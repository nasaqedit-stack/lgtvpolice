#!/usr/bin/env node
/**
 * Production pairing end-to-end test.
 *
 * Modes (set via E2E_MODE):
 *  - probe : credential-free diagnosis of POST /api/player/pair against the live
 *            production deployment. Reports exactly how the endpoint responds to
 *            the payload the TV player sends. Never fails the job (diagnostic).
 *  - full  : complete pairing flow A-H against production:
 *            generate a real code through the real admin API, submit it through
 *            the real player API, verify the paired screen + credential (against
 *            the Supabase production database when the service key is available),
 *            verify one-time reuse rejection and expiry rejection.
 *
 * Credentials are read from GitHub Actions secrets (repo + "Production" environment)
 * passed via SECRETS_JSON. Recognized (case-insensitive) names:
 *  - NEXT_PUBLIC_SUPABASE_URL / SUPABASE_URL
 *  - NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_ANON_KEY
 *  - SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SERVICE_KEY   (optional, enables DB checks)
 *  - ADMIN_EMAIL + ADMIN_PASSWORD                       (optional if service key set)
 */
import { createHash, randomBytes } from 'node:crypto';

const MODE = process.env.E2E_MODE || 'full';
const APP = (process.env.APP_ORIGIN || 'https://lgtvpolice.vercel.app').replace(/\/+$/, '');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

let secrets = {};
try { secrets = JSON.parse(process.env.SECRETS_JSON || '{}'); } catch { secrets = {}; }
function secret(...patterns) {
  // Prefer explicit environment variables (how the workflow passes GitHub
  // secrets); fall back to a JSON blob for local runs.
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
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${name}${detail ? ` — ${detail}` : ''}`);
}
function skip(name, detail) {
  results.push({ name, pass: null, detail });
  console.log(`SKIP | ${name} — ${detail}`);
}
function summary() {
  const failed = results.filter((r) => r.pass === false);
  console.log('\n===== E2E SUMMARY =====');
  for (const r of results) console.log(`${r.pass === null ? 'SKIP' : r.pass ? 'PASS' : 'FAIL'} | ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  console.log(failed.length === 0 ? 'RESULT: ALL CHECKS PASSED' : `RESULT: ${failed.length} CHECK(S) FAILED`);
  return failed.length === 0;
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 300) }; }
  return { status: response.status, data };
}

/** The deviceInfo object components/player.tsx deviceInfo() builds. */
function playerDeviceInfo() {
  return {
    userAgent: 'Mozilla/5.0 (Web0S; Linux) AppleWebKit/537.36 Chrome/133.0.0.0 Safari/537.36',
    platform: 'Web0S',
    screenWidth: 1920,
    screenHeight: 1080,
    language: 'ar-SA',
  };
}
/** POST /api/player/pair exactly the way components/player.tsx does. */
function playerPair(code, deviceInfo = playerDeviceInfo()) {
  return postJson(`${APP}/api/player/pair`, {
    code: code.replace(/[^a-zA-Z0-9]/g, '').toUpperCase(),
    deviceInfo,
  });
}

async function pairWithRetry(code) {
  let result = await playerPair(code);
  if (result.status === 429) {
    console.log('rate limited; waiting for the window to roll over (max ~11 min)…');
    await sleep(11 * 60_000);
    result = await playerPair(code);
  }
  return result;
}

/* ------------------------------------------------------------------ probe */

async function discoverPublicConfig() {
  const urls = new Set();
  const keys = new Set();
  const pages = [`${APP}/login`, `${APP}/player`];
  for (const page of pages) {
    let html = '';
    try { html = await (await fetch(page)).text(); } catch { continue; }
    for (const match of html.matchAll(/\/_next\/static\/[^"'\\ ]+\.js/g)) urls.add(`${APP}${match[0]}`);
  }
  for (const url of [...urls].slice(0, 40)) {
    let js = '';
    try { js = await (await fetch(url)).text(); } catch { continue; }
    for (const match of js.matchAll(/https:\/\/[a-z0-9]{16,}\.supabase\.co/g)) urls.add(match[0]);
    for (const match of js.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g)) keys.add(match[0]);
  }
  const supabaseUrl = [...urls].find((u) => u.includes('.supabase.co')) || undefined;
  return { supabaseUrl, anonKey: [...keys][0] };
}

async function runProbe() {
  console.log(`== probe mode against ${APP} ==`);

  let pageOk = false;
  try {
    const response = await fetch(`${APP}/player`);
    pageOk = response.ok;
    console.log(`GET /player -> ${response.status}`);
  } catch (error) { console.log(`GET /player -> network error: ${error.message}`); }

  // Payload the TV actually sends (includes `language`).
  let withLanguage;
  let withoutLanguage;
  try {
    withLanguage = await playerPair('E2EPROBE');
    console.log(`POST /api/player/pair WITH language -> ${withLanguage.status} ${JSON.stringify(withLanguage.data)}`);
    // Byte-identical payload minus only the `language` key, to see how far the request gets.
    const withoutLanguageDevice = playerDeviceInfo();
    delete withoutLanguageDevice.language;
    withoutLanguage = await playerPair('E2EPROBE', withoutLanguageDevice);
    console.log(`POST /api/player/pair WITHOUT language -> ${withoutLanguage.status} ${JSON.stringify(withoutLanguage.data)}`);
  } catch (error) {
    console.log(`pair endpoint unreachable: ${error.message}`);
  }

  const schemaReject = withLanguage && withLanguage.data.code === 'invalid_pairing_code' && withLanguage.data.error === 'أدخل رمز ربط صالحاً.';
  console.log(`diagnosis: schema-rejects-player-payload = ${schemaReject ? 'YES (root cause: strict deviceInfo schema)' : 'no'}`);
  console.log(`diagnosis: db-path-without-language = ${withoutLanguage ? (withoutLanguage.status === 400 ? 'reached lookup' : `status ${withoutLanguage.status}`) : 'unreachable'}`);

  const config = await discoverPublicConfig();
  console.log(`discovered public supabase url: ${config.supabaseUrl || '(not found)'}`);
  console.log(`discovered public anon key present: ${config.anonKey ? 'yes' : 'no'}`);

  console.log(`site reachable: ${pageOk}`);
  return true; // probe is informational; never fails the job
}

/* ------------------------------------------------------------------- full */

async function runFull() {
  console.log(`== full E2E against ${APP} ==`);
  const { createServerClient } = await import('@supabase/ssr');

  const config = await discoverPublicConfig();
  const supabaseUrl = secret('^NEXT_PUBLIC_SUPABASE_URL$', '^SUPABASE_URL$') || process.env.NEXT_PUBLIC_SUPABASE_URL || config.supabaseUrl;
  const anonKey = secret('^NEXT_PUBLIC_SUPABASE_ANON_KEY$', '^SUPABASE_ANON_KEY$') || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || config.anonKey;
  const serviceKey = secret('^SUPABASE_SERVICE_ROLE_KEY$', '^SUPABASE_SERVICE_KEY$') || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !anonKey) {
    throw new Error('Cannot resolve Supabase URL/anon key (secrets or public bundle).');
  }
  console.log(`supabase: ${supabaseUrl}`);
  const adminCreds = Boolean(secret('^ADMIN_EMAIL$', '^E2E_ADMIN_EMAIL$', '^TEST_ADMIN_EMAIL$') && secret('^ADMIN_PASSWORD$', '^E2E_ADMIN_PASSWORD$', '^TEST_ADMIN_PASSWORD$'));
  console.log(`credentials: service-key=${serviceKey ? 'yes' : 'no'} admin-creds=${adminCreds ? 'yes' : 'no'}`);

  const supaHeaders = (key) => ({ apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' });

  // -- resolve an admin session -------------------------------------------------
  let adminEmail = secret('^ADMIN_EMAIL$', '^E2E_ADMIN_EMAIL$', '^TEST_ADMIN_EMAIL$');
  let adminPassword = secret('^ADMIN_PASSWORD$', '^E2E_ADMIN_PASSWORD$', '^TEST_ADMIN_PASSWORD$');
  let tempUserId = null;

  if ((!adminEmail || !adminPassword) && serviceKey) {
    tempUserId = `e2e-${Date.now()}`;
    adminEmail = `pairing-e2e-${Date.now()}@lgtvpolice-e2e.invalid`;
    adminPassword = randomBytes(18).toString('base64url');
    const create = await postJson(`${supabaseUrl}/auth/v1/admin/users`, { email: adminEmail, password: adminPassword, email_confirm: true }, supaHeaders(serviceKey));
    if (create.status >= 300) throw new Error(`temp admin creation failed: ${create.status} ${JSON.stringify(create.data)}`);
    tempUserId = create.data?.id;
    const promote = await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${tempUserId}`, {
      method: 'PATCH', headers: { ...supaHeaders(serviceKey), Prefer: 'return=representation' },
      body: JSON.stringify({ role: 'admin', updated_at: new Date().toISOString() }),
    });
    const profile = await promote.json().catch(() => []);
    if (!promote.ok || profile?.[0]?.role !== 'admin') throw new Error(`profile promotion failed: ${promote.status} ${JSON.stringify(profile)}`);
    console.log(`created temporary admin ${tempUserId} (will be deleted after the run)`);
  }
  if (!adminEmail || !adminPassword) {
    throw new Error('No admin credentials: set ADMIN_EMAIL/ADMIN_PASSWORD secrets or SUPABASE_SERVICE_ROLE_KEY.');
  }

  // Real sign-in through Supabase Auth, stored in the exact @supabase/ssr cookie
  // format production reads (same code path as the login page).
  const jar = new Map();
  const authClient = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (items) => items.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  const login = await authClient.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  if (login.error) throw new Error(`admin login failed: ${login.error.message}`);
  const cookieHeader = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  console.log(`admin signed in; session cookies: ${[...jar.keys()].join(', ')}`);

  const origin = { Cookie: cookieHeader, Origin: APP, Referer: `${APP}/screens` };
  async function adminApi(path, init = {}) {
    const response = await fetch(`${APP}${path}`, { ...init, headers: { ...origin, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) } });
    const text = await response.text();
    let data = {}; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 300) }; }
    if (response.status === 429) return { status: response.status, data, retried: true };
    return { status: response.status, data };
  }
  async function adminPost(path, body, retries = 2) {
    let result = await adminApi(path, { method: 'POST', body: JSON.stringify(body) });
    while (result.status === 429 && retries > 0) {
      console.log('admin endpoint rate/space limited; retrying in 60s…');
      await sleep(60_000);
      retries -= 1;
      result = await adminApi(path, { method: 'POST', body: JSON.stringify(body) });
    }
    return result;
  }

  const createdScreens = [];
  const finish = () => { if (!summary()) process.exitCode = 1; };

  try {
    // A: open /player (the TV page the code gets entered into).
    const playerPage = await fetch(`${APP}/player`);
    record('A. /player page served', playerPage.ok, `GET /player -> ${playerPage.status}`);

    // B: generate a fresh pairing code through the real admin API.
    const stamp = Date.now();
    const create = await adminPost('/api/admin/screens', { name: `E2E pairing ${stamp}`, timezone: 'Asia/Riyadh' });
    if (create.status !== 201) {
      record('B. generate fresh pairing code', false, `create screen+code -> ${create.status} ${JSON.stringify(create.data)}`);
      finish();
      return;
    }
    createdScreens.push(create.data.screen.id);
    const code1 = create.data.pairingCode;
    const expiresAt = create.data.expiresAt;
    record('B. generate fresh pairing code', typeof code1 === 'string' && code1.length === 9, `code issued for screen ${create.data.screen.id}`);
    // C: record the displayed expiry.
    const expiryMs = new Date(expiresAt).getTime() - Date.now();
    record('C. displayed expiry recorded', Number.isFinite(expiryMs) && expiryMs > 14 * 60_000 && expiryMs <= 15 * 60_000 + 5_000, `expiresAt=${expiresAt} (in ${Math.round(expiryMs / 1000)}s)`);

    // D+E: submit the exact fresh code through the real player pairing flow.
    const paired = await pairWithRetry(code1);
    const freshOk = paired.status === 200 && typeof paired.data.credential === 'string';
    record('D/E. fresh code accepted by backend', freshOk, `status=${paired.status} ${JSON.stringify(paired.data).slice(0, 220)}`);
    if (!freshOk) { finish(); return; } // fail fast: nothing further can run

    const credential = paired.data.credential;
    const pairedScreenId = paired.data.screen?.id;
    record('E. response binds the intended screen', pairedScreenId === create.data.screen.id, `screen=${pairedScreenId}`);

    // F: the screen becomes paired.
    const list = await adminApi('/api/admin/screens');
    const listed = (list.data.screens || []).find((s) => s.id === create.data.screen.id);
    record('F. screen shows as paired (admin)', listed?.pairingStatus === 'paired', `pairingStatus=${listed?.pairingStatus}`);

    const manifest = await fetch(`${APP}/api/player/manifest`, { headers: { Authorization: `Bearer ${credential}` } });
    record('F. credential unlocks player endpoints', manifest.ok, `GET /api/player/manifest -> ${manifest.status}`);

    if (serviceKey) {
      const rest = async (path) => {
        const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, { headers: supaHeaders(serviceKey) });
        return response.json();
      };
      const [dbScreen, dbCreds, dbCodes] = await Promise.all([
        rest(`screens?id=eq.${create.data.screen.id}&select=id,paired_at`),
        rest(`screen_credentials?screen_id=eq.${create.data.screen.id}&revoked_at=is.null&select=token_hash,revoked_at`),
        rest(`pairing_codes?screen_id=eq.${create.data.screen.id}&select=code_hash,expires_at,used_at,created_at&order=created_at.desc&limit=1`),
      ]);
      record('F. screens.paired_at set in production DB', Boolean(dbScreen?.[0]?.paired_at), `paired_at=${dbScreen?.[0]?.paired_at}`);
      record('F. screen credential row created (sha256 only)', dbCreds?.some((c) => c.token_hash === sha256(credential)), `${dbCreds?.length || 0} active credential(s)`);
      const stored = dbCodes?.[0];
      const normalized = code1.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      record('DB stored hash matches validated value', stored?.code_hash === sha256(normalized), `code_hash=${String(stored?.code_hash).slice(0, 12)}…`);
      record('DB code tied to intended screen', stored?.screen_id === create.data.screen.id, `screen_id=${stored?.screen_id}`);
      record('DB code consumed (single-use recorded)', Boolean(stored?.used_at), `used_at=${stored?.used_at}`);
      const lifeMs = stored?.expires_at && stored?.created_at ? new Date(stored.expires_at) - new Date(stored.created_at) : 0;
      record('DB expiry within stated 15 minutes', lifeMs >= 14.5 * 60_000 && lifeMs <= 15.5 * 60_000, `created=${stored?.created_at} expires=${stored?.expires_at}`);
    } else {
      skip('DB source-of-truth checks', 'SUPABASE_SERVICE_ROLE_KEY not available');
    }

    // G: reuse the same code.
    const reuse = await pairWithRetry(code1);
    record('G. same code rejected on reuse', reuse.status === 400 && reuse.data.code === 'invalid_pairing_code', `status=${reuse.status} code=${reuse.data.code}`);

    // H: expired code is rejected. Issue a real code for a second screen, then
    // wait past its stated expiry (real time; no clock manipulation).
    const create2 = await adminPost('/api/admin/screens', { name: `E2E expiry ${stamp}`, timezone: 'Asia/Riyadh' });
    if (create2.status !== 201) {
      record('H. expired code rejected', false, `second screen creation failed: ${create2.status}`);
    } else {
      createdScreens.push(create2.data.screen.id);
      const code2 = create2.data.pairingCode;
      const waitMs = Math.max(0, new Date(create2.data.expiresAt).getTime() - Date.now() + 5_000);
      console.log(`waiting ${Math.round(waitMs / 1000)}s for code2 to pass its stated expiry…`);
      await sleep(waitMs);
      const expired = await pairWithRetry(code2);
      record('H. expired code rejected', expired.status === 400 && expired.data.code === 'invalid_pairing_code', `status=${expired.status} code=${expired.data.code}`);
      if (serviceKey) {
        const response = await fetch(`${supabaseUrl}/rest/v1/pairing_codes?screen_id=eq.${create2.data.screen.id}&select=code_hash,used_at,expires_at`, { headers: supaHeaders(serviceKey) });
        const rows = await response.json().catch(() => []);
        record('H. expired code not consumed in DB', rows?.[0] && !rows[0].used_at && new Date(rows[0].expires_at) < new Date(), `expires_at=${rows?.[0]?.expires_at} used_at=${rows?.[0]?.used_at}`);
      }
    }
  } finally {
    // Cleanup: screens (cascades credentials+codes) and the temporary admin user.
    for (const id of createdScreens) {
      await adminApi(`/api/admin/screens/${id}`, { method: 'DELETE', body: '{}' }).catch(() => {});
    }
    if (tempUserId && serviceKey) {
      await fetch(`${supabaseUrl}/auth/v1/admin/users/${tempUserId}`, { method: 'DELETE', headers: supaHeaders(serviceKey) }).catch(() => {});
      console.log(`removed temporary admin ${tempUserId}`);
    }
  }
  finish();
}

/* ------------------------------------------------------------------- main */

try {
  const ok = MODE === 'probe' ? await runProbe() : await runFull();
  if (!ok) process.exitCode = 1;
} catch (error) {
  console.error(`E2E aborted: ${error?.stack || error}`);
  if (MODE !== 'probe') {
    results.push({ name: 'E2E run', pass: false, detail: String(error?.message || error) });
    summary();
    process.exitCode = 1;
  }
}
