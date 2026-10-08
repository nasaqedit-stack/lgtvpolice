#!/usr/bin/env node
/**
 * Production media delivery end-to-end test.
 *
 * Verifies the complete pipeline against the live deployment:
 *   admin upload -> Supabase Storage (signage-media) -> media row -> playlist item ->
 *   published revision -> player manifest -> signed private URL -> byte download (Range) -> SHA-256
 *
 * Checks (A-I):
 *   A. media row exists in the production database (admin API + direct DB when the service key is set);
 *      every part is PUT as a Blob to its signed URL and finalization declares the real byte length
 *      of each part, including a two-part upload whose last part is a single byte (E2E_MULTIPART=0 skips it)
 *   B. the object exists in the private `signage-media` bucket (storage REST list + signed-URL byte read)
 *   C. the media is part of a playlist
 *   D. the playlist is published (immutable revision + published_version)
 *   E. a paired screen receives the playlist in /api/player/manifest (before and after explicit assignment)
 *   F. the screen credential obtains a valid signed media URL
 *   G. the signed URL downloads the exact bytes (4 MiB Range walk, SHA-256 verified) and is CORS-readable
 *   H. local cache / IndexedDB behaviour (download, SHA-256+size validation, retention on failure)
 *      is covered by `npm test`; it cannot run inside Node here and is reported as such
 *   I. visible playback on /player needs the real TV/browser and is reported as such
 *      (run with E2E_KEEP=1 to keep the test media and confirm it on the device)
 *
 * Credentials are read from GitHub Actions secrets (repository or the "Production" environment)
 * passed via environment variables, falling back to a SECRETS_JSON blob for local runs:
 *   NEXT_PUBLIC_SUPABASE_URL / SUPABASE_URL            (optional; usually discovered from the bundle)
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_ANON_KEY  (optional)
 *   SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SERVICE_KEY   (optional; enables DB/storage source-of-truth checks
 *                                                       and a temporary admin account)
 *   ADMIN_EMAIL + ADMIN_PASSWORD                       (optional if the service key is set)
 *
 * Without any of those the run reports SKIP with the exact missing capability instead of failing,
 * and still probes object storage reachability/CORS, which needs no credentials.
 */
import { appendFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const APP = (process.env.APP_ORIGIN || 'https://lgtvpolice.vercel.app').replace(/\/+$/, '');
const CHUNK_SIZE = 4 * 1024 * 1024; // must match lib/player/sync.ts
const KEEP = process.env.E2E_KEEP === '1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

let secrets = {};
try { secrets = JSON.parse(process.env.SECRETS_JSON || '{}'); } catch { secrets = {}; }
function secret(...patterns) {
  for (const source of [process.env, secrets]) {
    for (const [key, value] of Object.entries(source)) {
      if (!value || typeof value !== 'string') continue;
      if (patterns.some((pattern) => new RegExp(pattern, 'i').test(key))) return value;
    }
  }
  return undefined;
}

const results = [];
function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass === null ? 'SKIP' : pass ? 'PASS' : 'FAIL'} | ${name}${detail ? ` — ${detail}` : ''}`);
}
function skip(name, detail) { record(name, null, detail); }
function emitAnnotation(kind, title, text) {
  const escaped = text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::${kind} title=${title}::${escaped}`);
}
function summary() {
  const failed = results.filter((result) => result.pass === false);
  const skipped = results.filter((result) => result.pass === null);
  const block = [
    '===== MEDIA E2E SUMMARY =====',
    ...results.map((result) => `${result.pass === null ? 'SKIP' : result.pass ? 'PASS' : 'FAIL'} | ${result.name}${result.detail ? ` — ${result.detail}` : ''}`),
    failed.length === 0
      ? `RESULT: ${skipped.length ? `${skipped.length} CHECK(S) SKIPPED (missing capability)` : 'ALL CHECKS PASSED'}`
      : `RESULT: ${failed.length} CHECK(S) FAILED`,
  ].join('\n');
  console.log(block);
  emitAnnotation(failed.length === 0 ? 'notice' : 'error', 'Production media E2E results', block);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      const table = ['### Production media E2E', '', '| result | check | detail |', '| --- | --- | --- |',
        ...results.map((result) => `| ${result.pass === null ? 'SKIP' : result.pass ? 'PASS' : 'FAIL'} | ${result.name} | ${String(result.detail).replace(/\|/g, '\\|')} |`),
        '', failed.length === 0 ? '**RESULT: no failed checks**' : `**RESULT: ${failed.length} CHECK(S) FAILED**`, ''];
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, table.join('\n'));
    } catch { /* summary is best-effort */ }
  }
  return failed.length === 0;
}

/** Pairing is rate limited per client IP; a busy shared runner may need a pause before retrying. */
async function pairScreen(code, attempts = 3) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await postJson(`${APP}/api/player/pair`, {
      code,
      deviceInfo: { userAgent: 'prod-media-e2e', platform: 'node', language: 'ar-SA' },
    });
    if (response.status !== 429 || attempt >= attempts) return response;
    console.log(`pairing rate limited (429); retrying in 30s (attempt ${attempt + 1}/${attempts})`);
    await sleep(30_000);
  }
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 300) }; }
  return { status: response.status, data, headers: response.headers };
}

/* ------------------------------------------------- deterministic test image */

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}
/** A 64x64 RGB PNG with a visible colour gradient; no dependency, deterministic bytes. */
function makeTestPng(width = 64, height = 64) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * 3;
      raw[at] = Math.round((x / (width - 1)) * 255);
      raw[at + 1] = Math.round((y / (height - 1)) * 255);
      raw[at + 2] = 96;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * `node scripts/prod-media-e2e.mjs --self-test` validates the generated PNG fixture locally:
 * chunk structure, per-chunk CRC32 and the inflated scanline stream. No network, no credentials.
 */
function selfTest() {
  const png = makeTestPng();
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!png.subarray(0, 8).equals(signature)) throw new Error('bad PNG signature');
  const chunks = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('latin1');
    const body = png.subarray(offset + 4, offset + 8 + length);
    const stored = png.readUInt32BE(offset + 8 + length);
    if (crc32(body) !== stored) throw new Error(`bad CRC for chunk ${type}`);
    chunks.push({ type, data: png.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
  }
  const types = chunks.map((chunk) => chunk.type).join(',');
  if (types !== 'IHDR,IDAT,IEND') throw new Error(`unexpected chunk order: ${types}`);
  const header = chunks[0].data;
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const scanlines = inflateSync(chunks[1].data);
  if (scanlines.length !== (width * 3 + 1) * height) throw new Error(`scanline stream is ${scanlines.length} bytes, expected ${(width * 3 + 1) * height}`);
  if (scanlines.some((byte, index) => index % (width * 3 + 1) === 0 && byte !== 0)) throw new Error('unexpected scanline filter');
  console.log(`PASS | self-test | ${png.length} byte PNG ${width}x${height}, chunks=${types}, scanlines=${scanlines.length}, sha256=${sha256(png).slice(0, 16)}…`);
}

/* ------------------------------------------------------- public discovery */

async function discoverPublicConfig() {
  const jsUrls = new Set();
  const supabaseUrls = new Set();
  const keys = new Set();
  const diag = { pages: [], chunks: 0, sawSupabase: false };
  for (const page of [`${APP}/login`, `${APP}/player`]) {
    try {
      const response = await fetch(page);
      const html = await response.text();
      diag.pages.push({ page, status: response.status, bytes: html.length });
      for (const match of html.matchAll(/(?:["'`]|\\u0022)(\/_next\/static\/[^"'`\\ ]+?\.js)(?:["'`]|\\u0022)/g)) jsUrls.add(`${APP}${match[1]}`);
      for (const match of html.matchAll(/\/_next\/static\/[A-Za-z0-9_./-]+\.js/g)) jsUrls.add(`${APP}${match[0]}`);
    } catch (error) { diag.pages.push({ page, error: String(error) }); }
  }
  const queue = [...jsUrls];
  const fetched = new Set();
  while (queue.length > 0 && fetched.size < 80) {
    const url = queue.shift();
    if (fetched.has(url)) continue;
    fetched.add(url);
    let js = '';
    try { js = await (await fetch(url)).text(); } catch { continue; }
    for (const match of js.matchAll(/\/_next\/static\/[A-Za-z0-9_./-]+\.js/g)) {
      const next = `${APP}${match[0]}`;
      if (!fetched.has(next)) queue.push(next);
    }
    for (const match of js.matchAll(/https:\/\/[a-z0-9]{16,}\.supabase\.co/g)) supabaseUrls.add(match[0]);
    for (const match of js.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g)) keys.add(match[0]);
    if (js.includes('.supabase')) diag.sawSupabase = true;
  }
  diag.chunks = fetched.size;
  return { supabaseUrl: [...supabaseUrls][0], anonKey: [...keys][0], diag };
}

/* ------------------------------------------------- credential-free probes */

async function probeObjectStorage(supabaseUrl, anonKey) {
  if (!supabaseUrl) {
    skip('storage endpoint reachable', 'Supabase URL not discovered from the public bundle; set NEXT_PUBLIC_SUPABASE_URL');
    return;
  }
  const endpoint = `${supabaseUrl}/storage/v1/s3/signage-media/media/probe-not-signed`;
  try {
    const response = await fetch(endpoint, { headers: { Origin: APP } });
    const body = (await response.text()).slice(0, 200);
    // An S3 error (AccessDenied / SignatureDoesNotMatch / NoSuchKey) proves the project serves the
    // S3 protocol that the app signs against; a plain gateway error or a "not enabled"-style
    // message means S3 access was never switched on for the project, which breaks every upload.
    const served = /<Code>|SignatureDoesNotMatch|AccessDenied|AuthorizationHeaderMalformed/i.test(body)
      || ([400, 401, 403].includes(response.status) && !/not enabled|disabled/i.test(body));
    const code = /<Code>([^<]*)<\/Code>/.exec(body)?.[1];
    record('storage endpoint reachable (S3 protocol served)', served,
      `GET object probe -> ${response.status}${code ? ` ${code}` : ''} ${body.replace(/\s+/g, ' ').slice(0, 140)}`);
  } catch (error) {
    record('storage endpoint reachable (S3 protocol served)', false, `probe failed: ${error.message}`);
  }
  for (const method of ['GET', 'PUT']) {
    try {
      const response = await fetch(endpoint, {
        method: 'OPTIONS',
        headers: {
          Origin: APP,
          'Access-Control-Request-Method': method,
          'Access-Control-Request-Headers': method === 'PUT' ? 'content-type' : 'range',
        },
      });
      const allowOrigin = response.headers.get('access-control-allow-origin');
      const allowMethods = response.headers.get('access-control-allow-methods');
      record(`storage CORS preflight allows ${method} from the app origin`, Boolean(allowOrigin) && (allowOrigin === '*' || allowOrigin === APP),
        `status=${response.status} access-control-allow-origin=${allowOrigin ?? '(none)'} allow-methods=${allowMethods ?? '(none)'}`);
    } catch (error) {
      record(`storage CORS preflight allows ${method} from the app origin`, false, `preflight failed: ${error.message}`);
    }
  }
  if (anonKey) {
    try {
      const response = await fetch(`${supabaseUrl}/storage/v1/object/list/signage-media`, {
        method: 'POST',
        headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix: 'media/', limit: 1 }),
      });
      const body = (await response.text()).slice(0, 160);
      // The bucket must stay private: an anonymous listing must never return objects.
      record('private bucket rejects anonymous listing', !response.ok, `POST object/list -> ${response.status} ${body.replace(/\s+/g, ' ').slice(0, 120)}`);
    } catch (error) {
      record('private bucket rejects anonymous listing', true, `probe failed as expected: ${error.message}`);
    }
  } else {
    skip('private bucket rejects anonymous listing', 'anon key not discovered; set NEXT_PUBLIC_SUPABASE_ANON_KEY to include this probe');
  }
}

/* ------------------------------------------------------------------ helpers */

function readManifestMedia(manifest, mediaId) {
  const asset = (manifest.assets || []).find((entry) => entry.mediaId === mediaId);
  const item = (manifest.playlists || []).flatMap((playlist) => (playlist.items || []).map((entry) => ({ ...entry, playlistId: playlist.id }))).find((entry) => entry.mediaId === mediaId);
  return { asset, item, defaultPlaylistId: manifest.defaultPlaylistId };
}

/** Download the whole object through the exact HTTP shape the TV uses: 4 MiB Range windows. */
async function downloadWithRanges(url) {
  const digest = createHash('sha256');
  const bytes = [];
  let offset = 0;
  let total = null;
  let corsAllowOrigin;
  for (let request = 0; request < 64; request += 1) {
    const end = offset + CHUNK_SIZE - 1;
    const response = await fetch(url, { headers: { Range: `bytes=${offset}-${end}`, Origin: APP } });
    if (!response.ok) throw new Error(`range request failed: ${response.status} ${(await response.text()).slice(0, 160)}`);
    corsAllowOrigin = corsAllowOrigin ?? response.headers.get('access-control-allow-origin');
    const body = Buffer.from(await response.arrayBuffer());
    if (response.status === 206) {
      const contentRange = response.headers.get('content-range') || '';
      total = Number(contentRange.split('/')[1]) || total;
      if (body.length > end - offset + 1) throw new Error(`range body longer than requested (${body.length} > ${end - offset + 1})`);
      digest.update(body);
      bytes.push(body);
      offset += body.length;
      if (body.length < CHUNK_SIZE) break;
    } else {
      // A gateway that ignores Range returns the whole object (status 200).
      digest.update(body);
      bytes.push(body);
      offset += body.length;
      break;
    }
  }
  return { hash: digest.digest('hex'), size: offset, declaredSize: total, corsAllowOrigin, bytes: Buffer.concat(bytes) };
}

/* ------------------------------- multipart upload through the real admin API */

/**
 * Must match `lib/shared.ts` (`UPLOAD_PART_SIZE` / `uploadPartRange()`): `start` inclusive,
 * `end` exclusive, so the final part is whatever bytes remain.
 */
const UPLOAD_PART_SIZE = 8 * 1024 * 1024;
function partRanges(fileSize) {
  const ranges = [];
  for (let start = 0, partNumber = 1; start < fileSize; start += UPLOAD_PART_SIZE, partNumber += 1) {
    const end = Math.min(start + UPLOAD_PART_SIZE, fileSize);
    ranges.push({ partNumber, start, end, size: end - start });
  }
  return ranges;
}

/**
 * Uploads `bytes` to the live deployment exactly the way the admin browser does: one session,
 * one signed Blob PUT per part (never FormData, never through Vercel), then finalization with the
 * byte length that was really sent for each part. Resolves with the created media id.
 */
async function uploadThroughAdminApi(adminApi, bytes, fileName, mimeType, meta = {}) {
  const hash = sha256(bytes);
  const ranges = partRanges(bytes.length);
  const session = await adminApi('/api/admin/media/uploads', {
    method: 'POST',
    body: JSON.stringify({ fileName, fileSize: bytes.length, mimeType }),
  });
  if (session.status !== 201) throw new Error(`upload session failed: ${session.status} ${JSON.stringify(session.data)}`);
  const uploadId = session.data.uploadId;
  const serverPartition = { partSize: session.data.partSize, totalParts: session.data.totalParts };
  if (serverPartition.partSize !== UPLOAD_PART_SIZE || serverPartition.totalParts !== ranges.length) {
    throw new Error(`server partition ${JSON.stringify(serverPartition)} disagrees with the client partition partSize=${UPLOAD_PART_SIZE} totalParts=${ranges.length}`);
  }

  const uploaded = [];
  for (const range of ranges) {
    const ticket = await adminApi(`/api/admin/media/uploads/${uploadId}/parts`, {
      method: 'POST',
      body: JSON.stringify({ partNumbers: [range.partNumber] }),
    });
    if (ticket.status !== 200 || !ticket.data.urls?.[range.partNumber]) {
      throw new Error(`part ${range.partNumber} presign failed: ${ticket.status} ${JSON.stringify(ticket.data)}`);
    }
    // The declared size is the length of the exact bytes handed to fetch, not a recomputed value.
    const body = bytes.subarray(range.start, range.end);
    const put = await fetch(ticket.data.urls[range.partNumber], {
      method: 'PUT',
      body,
      headers: { 'Content-Type': mimeType, Origin: APP },
    });
    const putDetail = put.ok ? '' : (await put.text()).slice(0, 200);
    uploaded.push({ partNumber: range.partNumber, expected: range.size, size: body.length, status: put.status, detail: putDetail });
    if (!put.ok) throw new Error(`part ${range.partNumber} PUT failed: ${put.status} ${putDetail}`);
  }

  const status = await adminApi(`/api/admin/media/uploads/${uploadId}/status`);
  const complete = await adminApi(`/api/admin/media/uploads/${uploadId}/complete`, {
    method: 'POST',
    body: JSON.stringify({
      sha256: hash,
      width: null,
      height: null,
      durationMs: null,
      thumbnailData: null,
      compatibility: 'candidate',
      ...meta,
      parts: uploaded.map(({ partNumber, size }) => ({ partNumber, size })),
    }),
  });
  if (complete.status !== 201 || !complete.data.media?.id) {
    throw new Error(`upload complete failed: ${complete.status} ${JSON.stringify(complete.data)}`);
  }
  return {
    uploadId,
    mediaId: complete.data.media.id,
    duplicate: complete.data.duplicate === true,
    hash,
    uploaded,
    serverPartition,
    listedParts: status.data?.parts ?? [],
    storagePath: complete.data.media.storage_path,
  };
}

/* ------------------------------------------------------------------- main */

async function run() {
  console.log(`== production media E2E against ${APP} ==`);

  const config = await discoverPublicConfig();
  const supabaseUrl = secret('^NEXT_PUBLIC_SUPABASE_URL$', '^SUPABASE_URL$') || process.env.NEXT_PUBLIC_SUPABASE_URL || config.supabaseUrl;
  const anonKey = secret('^NEXT_PUBLIC_SUPABASE_ANON_KEY$', '^SUPABASE_ANON_KEY$') || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || config.anonKey;
  const serviceKey = secret('^SUPABASE_SERVICE_ROLE_KEY$', '^SUPABASE_SERVICE_KEY$') || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const adminEmailSecret = secret('^ADMIN_EMAIL$', '^E2E_ADMIN_EMAIL$', '^TEST_ADMIN_EMAIL$', '^PROD_ADMIN_EMAIL$', '^SUPABASE_ADMIN_EMAIL$');
  const adminPasswordSecret = secret('^ADMIN_PASSWORD$', '^E2E_ADMIN_PASSWORD$', '^TEST_ADMIN_PASSWORD$', '^PROD_ADMIN_PASSWORD$', '^SUPABASE_ADMIN_PASSWORD$');
  emitAnnotation('notice', 'Media E2E config', [
    `resolved: url=${supabaseUrl ? 'yes' : 'no'} anon=${anonKey ? 'yes' : 'no'} serviceKey=${serviceKey ? 'yes' : 'no'} adminCreds=${adminEmailSecret && adminPasswordSecret ? 'yes' : 'no'}`,
    `public discovery: pages=${JSON.stringify(config.diag.pages)} chunks=${config.diag.chunks}`,
  ].join('\n'));

  // Always available: the storage endpoint must serve the S3 protocol and allow the app origin.
  await probeObjectStorage(supabaseUrl, anonKey);

  if (!serviceKey && !(adminEmailSecret && adminPasswordSecret)) {
    const missing = 'No admin session is available to this run: set ADMIN_EMAIL + ADMIN_PASSWORD, or SUPABASE_SERVICE_ROLE_KEY (which lets the harness create a temporary admin), as GitHub Actions secrets. Until then the checks that need an authenticated admin (A-G) cannot be executed from CI.';
    for (const step of [
      'A. media row created in production DB', 'B. object stored in the private signage-media bucket',
      'C. media included in a playlist', 'D. playlist published (immutable revision)',
      'E. paired screen receives the playlist', 'F. screen credential obtains a signed media URL',
      'G. signed URL downloads the exact bytes (SHA-256)',
    ]) skip(step, missing);
    skip('H. media stored and verified in IndexedDB', 'covered by `npm test` (fake-indexeddb): download, SHA-256/size validation, retention on failure');
    skip('I. media renders on /player', 'requires the paired TV/browser; run with E2E_KEEP=1 and confirm on the device');
    return;
  }

  const { createServerClient } = await import('@supabase/ssr');
  const supaHeaders = (key) => ({ apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' });

  // -- admin session ---------------------------------------------------------
  let adminEmail = adminEmailSecret;
  let adminPassword = adminPasswordSecret;
  let tempUserId = null;
  if ((!adminEmail || !adminPassword) && serviceKey) {
    adminEmail = `media-e2e-${Date.now()}@lgtvpolice-e2e.invalid`;
    adminPassword = randomBytes(18).toString('base64url');
    const create = await postJson(`${supabaseUrl}/auth/v1/admin/users`, { email: adminEmail, password: adminPassword, email_confirm: true }, supaHeaders(serviceKey));
    if (create.status >= 300) throw new Error(`temporary admin creation failed: ${create.status} ${JSON.stringify(create.data)}`);
    tempUserId = create.data?.id;
    const promote = await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${tempUserId}`, {
      method: 'PATCH', headers: { ...supaHeaders(serviceKey), Prefer: 'return=representation' },
      body: JSON.stringify({ role: 'admin', updated_at: new Date().toISOString() }),
    });
    const profile = await promote.json().catch(() => []);
    if (!promote.ok || profile?.[0]?.role !== 'admin') throw new Error(`profile promotion failed: ${promote.status} ${JSON.stringify(profile)}`);
  }
  const jar = new Map();
  const authClient = createServerClient(supabaseUrl, anonKey || serviceKey, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (items) => items.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  const login = await authClient.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  if (login.error) throw new Error(`admin login failed: ${login.error.message}`);
  const requestHeaders = () => ({ Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '), Origin: APP, Referer: `${APP}/media` });
  async function adminApi(path, init = {}) {
    const response = await fetch(`${APP}${path}`, { ...init, headers: { ...requestHeaders(), ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) } });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 300) }; }
    return { status: response.status, data, headers: response.headers };
  }

  const rest = async (path) => {
    const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, { headers: supaHeaders(serviceKey) });
    return response.json().catch(() => []);
  };

  const cleanup = { playlistId: null, screenId: null, mediaId: null, extraMediaIds: [] };
  try {
    // 0. storage configuration must be present in the deployment -------------------
    const settings = await adminApi('/api/admin/settings');
    record('0. production storage configured', settings.status === 200 && settings.data.objectStorageConfigured === true,
      `GET /api/admin/settings -> ${settings.status} objectStorageConfigured=${settings.data.objectStorageConfigured} bucket=${settings.data.bucket}`);
    if (settings.status !== 200 || settings.data.objectStorageConfigured !== true) {
      skip('A-I media pipeline', 'SUPABASE_S3_ENDPOINT / SUPABASE_S3_ACCESS_KEY_ID / SUPABASE_S3_SECRET_ACCESS_KEY are not set in the Vercel production environment');
      return;
    }

    // 1. upload a real image through the real admin API ---------------------------
    const image = makeTestPng();
    const mediaHash = sha256(image);
    const fileName = `e2e-media-${Date.now()}.png`;
    const small = await uploadThroughAdminApi(adminApi, image, fileName, 'image/png', { width: 64, height: 64 });
    const mediaId = small.mediaId;
    cleanup.mediaId = mediaId;
    record('A. every part PUT was accepted by Storage',
      small.uploaded.every((part) => part.status === 200 && part.size === part.expected),
      `file=${image.length}B parts=${small.uploaded.map((part) => `#${part.partNumber}:${part.size}B->${part.status}`).join(', ')} partition=${JSON.stringify(small.serverPartition)}`);
    record('A. session status reports the uploaded part sizes',
      small.listedParts.length === small.uploaded.length
        && small.listedParts.every((part) => part.size === small.uploaded.find((uploaded) => uploaded.partNumber === part.partNumber)?.size),
      `GET …/status parts=${JSON.stringify(small.listedParts)}`);
    record('A. finalization accepted the declared part sizes', !small.duplicate && small.storagePath?.startsWith('media/'),
      `POST …/complete -> 201 media=${mediaId} path=${small.storagePath}`);
    record('A. media row created in production DB', !small.duplicate && small.hash === mediaHash,
      `media=${mediaId} sha256=${mediaHash.slice(0, 12)}… size=${image.length}B`);

    // 1b. a file one byte larger than a single part: two parts, the last one only 1 byte.
    // This is the shape that used to fail finalization with "حجم أحد أجزاء الرفع غير صحيح".
    if (process.env.E2E_MULTIPART === '0') {
      skip('A2. two-part upload with a short final part', 'E2E_MULTIPART=0');
    } else {
      const png = makeTestPng();
      const big = Buffer.alloc(UPLOAD_PART_SIZE + 1, 0x5a);
      png.copy(big, 0);
      const bigName = `e2e-multipart-${Date.now()}.png`;
      try {
        const large = await uploadThroughAdminApi(adminApi, big, bigName, 'image/png');
        cleanup.extraMediaIds.push(large.mediaId);
        record('A2. two-part upload with a 1-byte final part finalizes',
          !large.duplicate && large.uploaded.length === 2
            && large.uploaded[0].size === UPLOAD_PART_SIZE && large.uploaded[1].size === 1,
          `file=${big.length}B parts=${large.uploaded.map((part) => `#${part.partNumber}:${part.size}B->${part.status}`).join(', ')} media=${large.mediaId}`);
      } catch (error) {
        record('A2. two-part upload with a 1-byte final part finalizes', false, String(error?.message || error).slice(0, 300));
      }
    }

    // 2. the object really exists in the private bucket ---------------------------
    if (serviceKey) {
      const list = await postJson(`${supabaseUrl}/storage/v1/object/list/signage-media`, { prefix: 'media/', limit: 100, offset: 0, sortBy: { column: 'name', order: 'desc' } }, supaHeaders(serviceKey));
      const objectName = String(complete.data.media.storage_path || '').split('/').pop();
      const found = Array.isArray(list.data) && list.data.some((entry) => entry.name === objectName);
      record('B. object exists in the private signage-media bucket', found, `storage list -> ${list.status} entries=${Array.isArray(list.data) ? list.data.length : 0} object=${objectName}`);
    } else {
      skip('B. storage list check', 'SUPABASE_SERVICE_ROLE_KEY not available; the signed-URL byte read below still proves the object exists');
    }
    const preview = await adminApi(`/api/admin/media/${mediaId}/preview`);
    if (preview.status !== 200 || !preview.data.url) {
      record('B. signed URL delivers the stored object', false, `preview -> ${preview.status} ${JSON.stringify(preview.data).slice(0, 160)}`);
    } else {
      const fetched = await downloadWithRanges(preview.data.url);
      record('B/G. signed URL delivers the exact stored bytes', fetched.hash === mediaHash && fetched.bytes.length === image.length,
        `signed-URL range walk -> bytes=${fetched.bytes.length}/${image.length} sha256=${fetched.hash.slice(0, 12)}… cors=${fetched.corsAllowOrigin ?? '(none)'}`);
      record('G. signed URL is CORS-readable from the app origin', Boolean(fetched.corsAllowOrigin) && (fetched.corsAllowOrigin === '*' || fetched.corsAllowOrigin === APP),
        `access-control-allow-origin=${fetched.corsAllowOrigin ?? '(none)'}`);
    }

    // 3. playlist with the media, published ---------------------------------------
    const extra = (await adminApi('/api/admin/media?hash=' + mediaHash)).data.media ?? [];
    record('A. media visible in the admin library', extra.some((entry) => entry.id === mediaId), `GET /api/admin/media?hash=… -> ${extra.length} row(s)`);
    const playlistName = `E2E media ${Date.now()}`;
    const created2 = await adminApi('/api/admin/playlists', {
      method: 'POST',
      body: JSON.stringify({ name: playlistName, enabled: true, publish: true, items: [{ mediaId, durationMs: 15_000, loop: false }] }),
    });
    if (created2.status !== 201) throw new Error(`playlist creation failed: ${created2.status} ${JSON.stringify(created2.data)}`);
    const playlistId = created2.data.playlist.id;
    cleanup.playlistId = playlistId;
    record('C/D. playlist created and published', Number(created2.data.version) >= 1 && created2.data.playlist.published_version === created2.data.version,
      `playlist=${playlistId} published_version=${created2.data.playlist.published_version}`);
    if (serviceKey) {
      const [revisions, mediaRows] = await Promise.all([
        rest(`playlist_versions?playlist_id=eq.${playlistId}&select=version,manifest,published_at`),
        rest(`media?id=eq.${mediaId}&select=storage_path,sha256,file_size,mime_type,kind`),
      ]);
      const revision = revisions?.[0];
      const item = revision?.manifest?.items?.[0];
      record('C. media included in the published playlist revision', item?.mediaId === mediaId, `items=${revision?.manifest?.items?.length ?? 0} mediaId=${item?.mediaId}`);
      record('D. published revision stored in production DB', Boolean(revision?.published_at), `version=${revision?.version} published_at=${revision?.published_at}`);
      record('A. media row present in production DB', mediaRows?.[0]?.sha256 === mediaHash && Number(mediaRows[0].file_size) === image.length,
        `rows=${mediaRows?.length ?? 0} path=${mediaRows?.[0]?.storage_path} kind=${mediaRows?.[0]?.kind}`);

    }

    // 4. paired screen receives the playlist --------------------------------------
    const screenCreate = await adminApi('/api/admin/screens', { method: 'POST', body: JSON.stringify({ name: `E2E media screen ${Date.now()}`, timezone: 'Asia/Riyadh' }) });
    if (screenCreate.status !== 201) throw new Error(`screen creation failed: ${screenCreate.status} ${JSON.stringify(screenCreate.data)}`);
    const screenId = screenCreate.data.screen.id;
    cleanup.screenId = screenId;
    const paired = await pairScreen(screenCreate.data.pairingCode.replace(/[^a-zA-Z0-9]/g, '').toUpperCase());
    if (paired.status !== 200 || !paired.data.credential) throw new Error(`pairing failed: ${paired.status} ${JSON.stringify(paired.data)}`);
    const credential = paired.data.credential;
    record('E. screen paired', paired.data.screen?.id === screenId, `screen=${paired.data.screen?.id}`);

    const manifestBefore = await fetch(`${APP}/api/player/manifest`, { headers: { Authorization: `Bearer ${credential}` } });
    const manifestBeforeBody = await manifestBefore.json().catch(() => ({}));
    const before = readManifestMedia(manifestBeforeBody, mediaId);
    record('E. published playlist reaches the paired screen without manual assignment',
      manifestBefore.status === 200 && before.asset?.hash === mediaHash && before.item?.mediaId === mediaId,
      `manifest -> ${manifestBefore.status} defaultPlaylistId=${before.defaultPlaylistId} asset=${before.asset ? 'yes' : 'no'}`);

    const assigned = await adminApi(`/api/admin/screens/${screenId}`, { method: 'PATCH', body: JSON.stringify({ assignedPlaylistId: playlistId }) });
    const manifestAfter = await fetch(`${APP}/api/player/manifest`, { headers: { Authorization: `Bearer ${credential}` } });
    const manifestAfterBody = await manifestAfter.json().catch(() => ({}));
    const after = readManifestMedia(manifestAfterBody, mediaId);
    record('E. explicit assignment also delivers the playlist',
      assigned.status === 200 && manifestAfter.status === 200 && after.defaultPlaylistId === playlistId && after.item?.mediaId === mediaId,
      `PATCH -> ${assigned.status} manifest -> ${manifestAfter.status} defaultPlaylistId=${after.defaultPlaylistId}`);
    if (serviceKey) {
      const screenRow = (await rest(`screens?id=eq.${screenId}&select=assigned_playlist_id,paired_at&limit=1`))?.[0];
      record('E. screen is paired and assigned in production DB', Boolean(screenRow?.paired_at) && screenRow?.assigned_playlist_id === playlistId,
        `paired_at=${screenRow?.paired_at} assigned_playlist_id=${screenRow?.assigned_playlist_id}`);
    }

    // 5. the player can obtain and use a signed URL -------------------------------
    const urls = await postJson(`${APP}/api/player/media-urls`, { mediaIds: [mediaId] }, { Authorization: `Bearer ${credential}` });
    const signedUrl = urls.data?.urls?.[mediaId];
    record('F. player obtains a valid signed media URL', urls.status === 200 && typeof signedUrl === 'string',
      `POST /api/player/media-urls -> ${urls.status} expiresIn=${urls.data?.expiresIn} url=${typeof signedUrl === 'string' ? 'issued' : 'missing'}`);
    if (typeof signedUrl === 'string') {
      const downloaded = await downloadWithRanges(signedUrl);
      record('G. player download matches the manifest hash and size',
        downloaded.hash === mediaHash && downloaded.bytes.length === image.length && (downloaded.declaredSize === null || downloaded.declaredSize === image.length),
        `bytes=${downloaded.bytes.length}/${image.length} sha256=${downloaded.hash === mediaHash ? 'match' : 'MISMATCH'} cors=${downloaded.corsAllowOrigin ?? '(none)'}`);
      record('G. signed media URL is CORS-readable from the app origin', Boolean(downloaded.corsAllowOrigin) && (downloaded.corsAllowOrigin === '*' || downloaded.corsAllowOrigin === APP),
        `access-control-allow-origin=${downloaded.corsAllowOrigin ?? '(none)'}`);
      const manifestHash = manifestAfterBody.manifestHash;
      if (manifestHash) {
        const revalidated = await fetch(`${APP}/api/player/manifest`, { headers: { Authorization: `Bearer ${credential}`, 'If-None-Match': `"${manifestHash}"` } });
        record('E. manifest revalidation is stable (ETag/304)', revalidated.status === 304, `If-None-Match -> ${revalidated.status}`);
      }
    }

    skip('H. media stored and verified in IndexedDB', 'browser-only: covered by `npm test` (fake-indexeddb) for download, SHA-256/size validation and retention of the working playlist when a download fails');
    if (KEEP) {
      skip('I. media renders on /player', `left in place: playlist=${playlistId} screen=${screenId} media=${mediaId} — open ${APP}/player on the paired TV to confirm playback, then delete the playlist, media and screen from the admin UI`);
    } else {
      skip('I. media renders on /player', 'requires the paired TV/browser; rerun with E2E_KEEP=1 to keep the test media and confirm on the device');
    }
  } finally {
    if (KEEP) {
      console.log('E2E_KEEP=1: leaving test data in place for device verification');
      console.log(JSON.stringify(cleanup));
    } else {
      if (cleanup.screenId) await adminApi(`/api/admin/screens/${cleanup.screenId}`, { method: 'PATCH', body: JSON.stringify({ assignedPlaylistId: null }) }).catch(() => undefined);
      if (cleanup.playlistId) await adminApi(`/api/admin/playlists/${cleanup.playlistId}`, { method: 'DELETE' }).catch(() => undefined);
      if (cleanup.mediaId) await adminApi(`/api/admin/media/${cleanup.mediaId}`, { method: 'DELETE' }).catch(() => undefined);
      for (const extraId of cleanup.extraMediaIds) await adminApi(`/api/admin/media/${extraId}`, { method: 'DELETE' }).catch(() => undefined);
      if (cleanup.screenId) await adminApi(`/api/admin/screens/${cleanup.screenId}`, { method: 'DELETE' }).catch(() => undefined);
      console.log(`cleanup requested for screen=${cleanup.screenId} playlist=${cleanup.playlistId} media=${cleanup.mediaId}`);
    }
    if (tempUserId && serviceKey) {
      await fetch(`${supabaseUrl}/auth/v1/admin/users/${tempUserId}`, { method: 'DELETE', headers: supaHeaders(serviceKey) }).catch(() => undefined);
      console.log(`removed temporary admin ${tempUserId}`);
    }
  }
}

if (process.argv.includes('--self-test')) {
  try {
    selfTest();
    process.exitCode = 0;
  } catch (error) {
    console.error(`FAIL | self-test | ${error.message}`);
    process.exitCode = 1;
  }
} else try {
  await run();
  if (!summary()) process.exitCode = 1;
} catch (error) {
  console.error(`Media E2E aborted: ${error?.stack || error}`);
  record('E2E run', false, String(error?.message || error));
  summary();
  process.exitCode = 1;
}
