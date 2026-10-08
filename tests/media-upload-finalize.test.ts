/**
 * Integration test for the whole multipart upload path, in one process:
 *
 *   real browser uploader (lib/client/media-upload.ts)
 *     -> real Next.js route handlers (app/api/admin/media/uploads/**)
 *       -> real AWS SDK v3 commands
 *         -> a fake object store that answers EXACTLY like Supabase Storage's S3 protocol
 *
 * The fake store is the point of this file: like Supabase, its `ListParts` reply carries
 * `PartNumber`, `LastModified` and `ETag` per part and NO `<Size>` element, which is what made
 * every production finalization fail with `upload_part_size_invalid` on part 1.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/* ------------------------------------------------------------------ fake Postgres/PostgREST */

type Row = Record<string, any>;
const dbState: { profiles: Row[]; media_uploads: Row[]; media: Row[] } = { profiles: [], media_uploads: [], media: [] };
const defaults: Record<string, Row> = { media_uploads: { status: 'uploading' }, media: {} };
const ADMIN_USER_ID = '11111111-1111-4111-8111-111111111111';

function matches(row: Row, filters: Row) {
  return Object.entries(filters).every(([key, value]) => String(row[key]) === String(value));
}

function fakeDb() {
  return {
    from(table: keyof typeof dbState) {
      const filters: Row = {};
      let operation: 'select' | 'insert' | 'update' = 'select';
      let payload: Row = {};
      const builder: any = {
        select: () => builder,
        insert: (row: Row) => { operation = 'insert'; payload = row; return builder; },
        update: (row: Row) => { operation = 'update'; payload = row; return builder; },
        eq: (key: string, value: unknown) => { filters[key] = value; return builder; },
        single: () => run(true),
        maybeSingle: () => run(false),
      };
      const run = async (strict: boolean) => {
        const rows = dbState[table];
        if (operation === 'insert') {
          const row = { ...defaults[table], ...payload, id: payload.id ?? `row-${rows.length + 1}-${table}`, created_at: new Date().toISOString() };
          rows.push(row);
          return { data: row, error: null };
        }
        if (operation === 'update') {
          const found = rows.filter(row => matches(row, filters));
          found.forEach(row => Object.assign(row, payload));
          return { data: found, error: null };
        }
        const found = rows.filter(row => matches(row, filters));
        if (!found.length) {
          return strict
            ? { data: null, error: { code: 'PGRST116', message: 'no rows returned' } }
            : { data: null, error: null };
        }
        return { data: found[0], error: null };
      };
      return builder;
    },
  };
}

vi.mock('@/lib/server/supabase', () => ({
  createSupabaseServer: () => ({ auth: { getUser: async () => ({ data: { user: { id: ADMIN_USER_ID } }, error: null }) } }),
  createSupabaseAdmin: () => fakeDb(),
  getSupabasePublicConfig: () => ({ url: 'http://supabase.test', anonKey: 'anon' }),
}));

/* --------------------------------------------- fake object store (Supabase Storage's S3 API) */

type StoredPart = { partNumber: number; bytes: Uint8Array; etag: string };
type Upload = { key: string; contentType: string; parts: Map<number, StoredPart> };
type StoredObject = { bytes: Uint8Array; contentType: string };

const store = { uploads: new Map<string, Upload>(), objects: new Map<string, StoredObject>() };
let uploadCounter = 0;
const xmlEscape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function sendXml(response: any, status: number, body: string, headers: Record<string, string> = {}) {
  const payload = Buffer.from(body, 'utf8');
  response.writeHead(status, { 'Content-Type': 'application/xml', 'Content-Length': String(payload.length), ...headers });
  response.end(payload);
}

/**
 * Supabase Storage's `ListParts` reply, field for field: `s3-handler.ts#listParts` pushes only
 * `{ PartNumber, LastModified, ETag }`, so there is no `<Size>` element to parse.
 */
function listPartsXml(bucket: string, key: string, uploadId: string, upload: Upload) {
  const parts = [...upload.parts.values()].sort((left, right) => left.partNumber - right.partNumber)
    .map(part => `<Part><PartNumber>${part.partNumber}</PartNumber><LastModified>2026-10-08T00:00:00.000Z</LastModified><ETag>${xmlEscape(part.etag)}</ETag></Part>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${xmlEscape(uploadId)}</UploadId><PartNumberMarker></PartNumberMarker><NextPartNumberMarker></NextPartNumberMarker><MaxParts>1000</MaxParts><IsTruncated>false</IsTruncated>${parts}</ListPartsResult>`;
}

async function readBody(request: any): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

function startFakeStorage(): Promise<{ server: Server; endpoint: string }> {
  return new Promise(resolve => {
    const server = createServer(async (request, response) => {
      const url = new URL(String(request.url), 'http://127.0.0.1');
      const [, bucket, ...rest] = url.pathname.split('/');
      const key = rest.join('/');
      const uploadId = url.searchParams.get('uploadId') ?? '';
      try {
        // CreateMultipartUpload
        if (request.method === 'POST' && url.searchParams.has('uploads')) {
          uploadCounter += 1;
          const id = `upload-${uploadCounter}`;
          store.uploads.set(id, { key, contentType: String(request.headers['content-type'] ?? ''), parts: new Map() });
          return sendXml(response, 200, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${xmlEscape(bucket!)}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
        }
        // CompleteMultipartUpload: assemble the parts in ascending part-number order.
        if (request.method === 'POST' && uploadId) {
          const upload = store.uploads.get(uploadId);
          if (!upload) return sendXml(response, 404, '<Error><Code>NoSuchUpload</Code></Error>');
          await readBody(request);
          const ordered = [...upload.parts.values()].sort((left, right) => left.partNumber - right.partNumber);
          const bytes = new Uint8Array(ordered.reduce((sum, part) => sum + part.bytes.length, 0));
          let offset = 0;
          for (const part of ordered) { bytes.set(part.bytes, offset); offset += part.bytes.length; }
          store.objects.set(key, { bytes, contentType: upload.contentType });
          store.uploads.delete(uploadId);
          return sendXml(response, 200, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Location>${xmlEscape(bucket!)}/${xmlEscape(key)}</Location><Bucket>${xmlEscape(bucket!)}</Bucket><Key>${xmlEscape(key)}</Key><ETag>&quot;assembled&quot;</ETag></CompleteMultipartUploadResult>`);
        }
        // UploadPart
        if (request.method === 'PUT' && uploadId) {
          const upload = store.uploads.get(uploadId);
          if (!upload) return sendXml(response, 404, '<Error><Code>NoSuchUpload</Code></Error>');
          const partNumber = Number(url.searchParams.get('partNumber'));
          const bytes = await readBody(request);
          const etag = `"etag-${uploadId}-${partNumber}"`;
          upload.parts.set(partNumber, { partNumber, bytes, etag });
          response.writeHead(200, { ETag: etag, 'Content-Length': '0' });
          return response.end();
        }
        // ListParts — note the deliberate absence of <Size>, exactly like Supabase.
        if (request.method === 'GET' && uploadId) {
          const upload = store.uploads.get(uploadId);
          if (!upload) return sendXml(response, 404, '<Error><Code>NoSuchUpload</Code></Error>');
          return sendXml(response, 200, listPartsXml(bucket!, key, uploadId, upload));
        }
        if (request.method === 'HEAD') {
          const object = store.objects.get(key);
          if (!object) { response.writeHead(404); return response.end(); }
          response.writeHead(200, { 'Content-Length': String(object.bytes.length), 'Content-Type': object.contentType, ETag: '"assembled"' });
          return response.end();
        }
        if (request.method === 'GET') {
          const object = store.objects.get(key);
          if (!object) return sendXml(response, 404, '<Error><Code>NoSuchKey</Code></Error>');
          const range = /^bytes=(\d+)-(\d*)$/.exec(String(request.headers.range ?? ''));
          if (range) {
            const start = Number(range[1]);
            const end = range[2] ? Math.min(Number(range[2]), object.bytes.length - 1) : object.bytes.length - 1;
            const slice = object.bytes.subarray(start, end + 1);
            response.writeHead(206, { 'Content-Length': String(slice.length), 'Content-Range': `bytes ${start}-${end}/${object.bytes.length}`, 'Content-Type': object.contentType });
            return response.end(Buffer.from(slice));
          }
          response.writeHead(200, { 'Content-Length': String(object.bytes.length), 'Content-Type': object.contentType });
          return response.end(Buffer.from(object.bytes));
        }
        if (request.method === 'DELETE') {
          store.objects.delete(key);
          response.writeHead(204);
          return response.end();
        }
        return sendXml(response, 501, '<Error><Code>NotImplemented</Code></Error>');
      } catch (error) {
        return sendXml(response, 500, `<Error><Code>InternalError</Code><Message>${xmlEscape(String(error))}</Message></Error>`);
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, endpoint: `http://127.0.0.1:${port}` });
    });
  });
}

/* ------------------------------------------------------------- routing real API calls in-process */

type Routes = {
  create: typeof import('@/app/api/admin/media/uploads/route');
  parts: typeof import('@/app/api/admin/media/uploads/[uploadId]/parts/route');
  status: typeof import('@/app/api/admin/media/uploads/[uploadId]/status/route');
  complete: typeof import('@/app/api/admin/media/uploads/[uploadId]/complete/route');
};
let routes: Routes;
let server: Server;
const APP_ORIGIN = 'http://admin.test';
const realFetch = globalThis.fetch;

function buildRequest(method: string, url: URL, init: RequestInit = {}) {
  return new NextRequest(url, {
    method,
    body: init.body as BodyInit | undefined,
    headers: { Origin: APP_ORIGIN, Host: url.host, ...(init.headers as Record<string, string> | undefined) },
  });
}

async function dispatchApi(url: URL, init: RequestInit = {}): Promise<Response> {
  const context = (uploadId: string) => ({ params: Promise.resolve({ uploadId }) });
  const segments = url.pathname.split('/').filter(Boolean); // api admin media uploads [uploadId] <leaf>
  const method = (init.method ?? 'GET').toUpperCase();
  if (url.pathname === '/api/admin/media/uploads' && method === 'POST') {
    return routes.create.POST(buildRequest(method, url, init));
  }
  const uploadId = segments[4]!;
  const leaf = segments[5];
  if (leaf === 'parts' && method === 'POST') return routes.parts.POST(buildRequest(method, url, init), context(uploadId));
  if (leaf === 'status' && method === 'GET') return routes.status.GET(buildRequest(method, url, init), context(uploadId));
  if (leaf === 'complete' && method === 'POST') return routes.complete.POST(buildRequest(method, url, init), context(uploadId));
  throw new Error(`test harness has no route for ${method} ${url.pathname}`);
}

/** The browser's fetch: relative /api calls hit the real route handlers, absolute URLs hit Storage. */
function installBrowserFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/')) return dispatchApi(new URL(url, APP_ORIGIN), init ?? {});
    return realFetch(input as any, init);
  }));
}

async function callApi(method: string, path: string, body?: unknown) {
  const response = await dispatchApi(new URL(path, APP_ORIGIN), {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

/* --------------------------------------------------------------------------- fixtures */

function pngBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  for (let index = 8; index < length; index += 1) bytes[index] = (index * 31 + 7) % 251;
  return bytes;
}

function mp4Bytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  bytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32], 0);
  for (let index = 12; index < length; index += 1) bytes[index] = (index * 37 + 11) % 251;
  return bytes;
}
function testAscii(value: string) { return new Uint8Array([...value].map(character => character.charCodeAt(0))); }
function joinTestBytes(...parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result as Uint8Array<ArrayBuffer>;
}
function testAtom(type: string, payload = new Uint8Array()) {
  const result = new Uint8Array(8 + payload.length);
  new DataView(result.buffer).setUint32(0, result.length, false);
  result.set(testAscii(type), 4);
  result.set(payload, 8);
  return result;
}
function testDescriptor(tag: number, payload: Uint8Array) {
  if (payload.length >= 128) throw new Error('test descriptor too large');
  return joinTestBytes(new Uint8Array([tag, payload.length]), payload);
}
function testAacSampleEntry() {
  const decoderConfig = new Uint8Array(13);
  decoderConfig[0] = 0x40;
  decoderConfig[1] = 0x15;
  const decoderSpecific = testDescriptor(0x05, new Uint8Array([0x12, 0x10]));
  const decoderConfigDescriptor = testDescriptor(0x04, joinTestBytes(decoderConfig, decoderSpecific));
  const esDescriptor = testDescriptor(0x03, joinTestBytes(new Uint8Array([0, 1, 0]), decoderConfigDescriptor, testDescriptor(0x06, new Uint8Array([2]))));
  return testAtom('mp4a', joinTestBytes(new Uint8Array(28), testAtom('esds', joinTestBytes(new Uint8Array(4), esDescriptor))));
}
function testSampleDescription(codec: string) {
  const entryCount = new Uint8Array(4);
  new DataView(entryCount.buffer).setUint32(0, 1, false);
  const entry = codec === 'mp4a' ? testAacSampleEntry() : testAtom(codec);
  return testAtom('stsd', joinTestBytes(new Uint8Array(4), entryCount, entry));
}
function testTrack(handler: 'vide' | 'soun', codec: string) {
  const handlerPayload = joinTestBytes(new Uint8Array(8), testAscii(handler), new Uint8Array(12));
  const mediaInformation = testAtom('minf', testAtom('stbl', testSampleDescription(codec)));
  return testAtom('trak', testAtom('mdia', joinTestBytes(testAtom('hdlr', handlerPayload), mediaInformation)));
}
function movBytes(videoCodec = 'avc1', audioCodec: string | null = 'mp4a'): Uint8Array<ArrayBuffer> {
  const fileType = testAtom('ftyp', joinTestBytes(testAscii('qt  '), new Uint8Array(4)));
  const tracks = [testTrack('vide', videoCodec)];
  if (audioCodec) tracks.push(testTrack('soun', audioCodec));
  const movie = testAtom('moov', joinTestBytes(...tracks));
  const mediaData = testAtom('mdat', new Uint8Array([1, 2, 3, 4]));
  return joinTestBytes(fileType, movie, mediaData);
}

const sha256Of = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Deep-equality on multi-MiB typed arrays exhausts the worker heap; compare digests instead. */
function expectSameBytes(actual: Uint8Array, expected: Uint8Array) {
  expect(actual.length).toBe(expected.length);
  expect(sha256Of(actual)).toBe(sha256Of(expected));
}

/** Runs the complete browser flow: session -> parts -> Blob PUTs -> status -> complete. */
async function uploadLikeTheBrowser(bytes: Uint8Array<ArrayBuffer>, fileName: string, mimeType: 'image/png' | 'video/mp4' | 'video/quicktime') {
  const file = new File([bytes], fileName, { type: mimeType });
  const session = await callApi('POST', '/api/admin/media/uploads', { fileName, fileSize: file.size, mimeType });
  expect(session.status, JSON.stringify(session.body)).toBe(201);
  const uploadId = session.body.uploadId as string;

  const status = await callApi('GET', `/api/admin/media/uploads/${uploadId}/status`);
  expect(status.status).toBe(200);
  const pending = Array.from({ length: status.body.totalParts as number }, (_unused, index) => index + 1)
    .filter(partNumber => !(status.body.parts as Array<{ partNumber: number }>).some(part => part.partNumber === partNumber));

  const { uploadParts, buildPartManifest } = await import('@/lib/client/media-upload');
  const progress: number[] = [];
  const uploaded = await uploadParts(file, uploadId, pending, done => progress.push(done));

  const complete = await callApi('POST', `/api/admin/media/uploads/${uploadId}/complete`, {
    sha256: sha256Of(bytes),
    width: null,
    height: null,
    durationMs: null,
    thumbnailData: null,
    compatibility: 'candidate',
    parts: buildPartManifest(file.size, uploaded),
  });
  return { file, uploadId, session: session.body, status: status.body, uploaded, progress, complete };
}

/* ------------------------------------------------------------------------------ suite */

beforeAll(async () => {
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const started = await startFakeStorage();
  server = started.server;
  process.env.SUPABASE_S3_ENDPOINT = started.endpoint;
  process.env.SUPABASE_S3_REGION = 'us-east-1';
  process.env.SUPABASE_S3_ACCESS_KEY_ID = 'test-access-key';
  process.env.SUPABASE_S3_SECRET_ACCESS_KEY = 'test-secret-key';
  process.env.SIGNAGE_STORAGE_BUCKET = 'signage-media';
  dbState.profiles.push({ id: ADMIN_USER_ID, role: 'admin', disabled: false });
  routes = {
    create: await import('@/app/api/admin/media/uploads/route'),
    parts: await import('@/app/api/admin/media/uploads/[uploadId]/parts/route'),
    status: await import('@/app/api/admin/media/uploads/[uploadId]/status/route'),
    complete: await import('@/app/api/admin/media/uploads/[uploadId]/complete/route'),
  };
});

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  installBrowserFetch();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise(resolve => server.close(resolve));
});

describe('finalization against a Supabase-shaped object store', () => {
  it('uploads a small image (single part) and returns a media id', async () => {
    const bytes = pngBytes(2048);
    const result = await uploadLikeTheBrowser(bytes, 'small.png', 'image/png');

    expect(result.complete.status, JSON.stringify(result.complete.body)).toBe(201);
    expect(typeof result.complete.body.media.id).toBe('string');
    expect(result.complete.body.duplicate).toBe(false);
    expect(result.uploaded).toEqual([{ partNumber: 1, size: 2048 }]);
    expect(result.progress).toEqual([2048]);
    // The bytes the store assembled are the bytes of the file.
    const stored = store.objects.get(String(result.complete.body.media.storage_path))!;
    expectSameBytes(stored.bytes, bytes);
    expect(stored.contentType).toBe('image/png');
  });

  it('uploads a three-part MP4 whose final part is short, and stores the exact bytes', async () => {
    const bytes = mp4Bytes(20_000_000);
    const result = await uploadLikeTheBrowser(bytes, 'clip.mp4', 'video/mp4');

    expect(result.complete.status, JSON.stringify(result.complete.body)).toBe(201);
    expect(result.uploaded.map(part => part.size)).toEqual([8_388_608, 8_388_608, 3_222_784]);
    expect(result.progress.reduce((sum, value) => sum + value, 0)).toBe(bytes.length);
    expectSameBytes(store.objects.get(String(result.complete.body.media.storage_path))!.bytes, bytes);
  });

  it('stores an explicitly compatibility-checked QuickTime MOV with its original MIME type', async () => {
    const bytes = movBytes();
    const result = await uploadLikeTheBrowser(bytes, 'h264-aac.mov', 'video/quicktime');

    expect(result.complete.status, JSON.stringify(result.complete.body)).toBe(201);
    expect(result.complete.body.media.mime_type).toBe('video/quicktime');
    expect(store.objects.get(String(result.complete.body.media.storage_path))!.contentType).toBe('video/quicktime');
    expectSameBytes(store.objects.get(String(result.complete.body.media.storage_path))!.bytes, bytes);
  });

  it('refuses a MOV upload with no successful client codec-compatibility preflight', async () => {
    const bytes = movBytes();
    const file = new File([bytes], 'unverified.mov', { type: 'video/quicktime' });
    const session = await callApi('POST', '/api/admin/media/uploads', { fileName: file.name, fileSize: file.size, mimeType: 'video/quicktime' });
    expect(session.status).toBe(201);
    const uploadId = session.body.uploadId as string;
    const { uploadParts, buildPartManifest } = await import('@/lib/client/media-upload');
    const uploaded = await uploadParts(file, uploadId, [1], () => undefined);
    const complete = await callApi('POST', `/api/admin/media/uploads/${uploadId}/complete`, {
      sha256: sha256Of(bytes), width: null, height: null, durationMs: null, thumbnailData: null,
      compatibility: 'warning', parts: buildPartManifest(file.size, uploaded),
    });
    expect(complete.status).toBe(422);
    expect(complete.body.code).toBe('quicktime_compatibility_unverified');
  });

  it('rejects a QuickTime file with unsupported codecs even when a forged client claims it is compatible', async () => {
    const before = store.objects.size;
    const bytes = movBytes('hvc1', 'mp4a');
    const result = await uploadLikeTheBrowser(bytes, 'unsupported-hevc.mov', 'video/quicktime');

    expect(result.complete.status).toBe(422);
    expect(result.complete.body.code).toBe('quicktime_codec_unsupported');
    expect(store.objects.size).toBe(before);
    expect(dbState.media.some(row => row.sha256 === sha256Of(bytes))).toBe(false);
  });

  it('is not fooled by a ListParts answer without <Size>', async () => {
    const bytes = pngBytes(8_388_609); // exactly one chunk + 1 byte -> a 1-byte final part
    const result = await uploadLikeTheBrowser(bytes, 'edge.png', 'image/png');

    expect(result.complete.status, JSON.stringify(result.complete.body)).toBe(201);
    expect(result.complete.body.code).toBeUndefined();
    expect(result.uploaded.map(part => part.size)).toEqual([8_388_608, 1]);
    expectSameBytes(store.objects.get(String(result.complete.body.media.storage_path))!.bytes, bytes);
  });

  it('reports real progress for parts that already landed when a session is resumed', async () => {
    const bytes = pngBytes(2048);
    const session = await callApi('POST', '/api/admin/media/uploads', { fileName: 'resume.png', fileSize: bytes.length, mimeType: 'image/png' });
    const uploadId = session.body.uploadId as string;
    const { uploadParts } = await import('@/lib/client/media-upload');
    await uploadParts(new File([bytes], 'resume.png', { type: 'image/png' }), uploadId, [1], () => undefined);

    const status = await callApi('GET', `/api/admin/media/uploads/${uploadId}/status`);
    // Supabase reports no length, so the session state falls back to the real partition size
    // instead of the 0 that used to restart every progress bar.
    expect(status.body.parts).toEqual([{ partNumber: 1, size: 2048 }]);
  });

  it('still rejects a declared part size that does not match the file', async () => {
    const bytes = pngBytes(20_000_000);
    const session = await callApi('POST', '/api/admin/media/uploads', { fileName: 'tampered.png', fileSize: bytes.length, mimeType: 'image/png' });
    const uploadId = session.body.uploadId as string;
    const { uploadParts } = await import('@/lib/client/media-upload');
    const file = new File([bytes], 'tampered.png', { type: 'image/png' });
    const uploaded = await uploadParts(file, uploadId, [1, 2, 3], () => undefined);

    const tampered = uploaded.map(part => (part.partNumber === 3 ? { ...part, size: part.size - 1 } : part));
    const complete = await callApi('POST', `/api/admin/media/uploads/${uploadId}/complete`, {
      sha256: sha256Of(bytes), width: null, height: null, durationMs: null, thumbnailData: null,
      compatibility: 'candidate', parts: tampered,
    });
    expect(complete.status).toBe(409);
    expect(complete.body.code).toBe('upload_part_size_invalid');
    expect(String(complete.body.error)).toContain('الجزء 3');
  });

  it('still rejects finalization while a part is missing', async () => {
    const bytes = pngBytes(20_000_000);
    const session = await callApi('POST', '/api/admin/media/uploads', { fileName: 'partial.png', fileSize: bytes.length, mimeType: 'image/png' });
    const uploadId = session.body.uploadId as string;
    const { uploadParts } = await import('@/lib/client/media-upload');
    await uploadParts(new File([bytes], 'partial.png', { type: 'image/png' }), uploadId, [1, 2], () => undefined);

    const complete = await callApi('POST', `/api/admin/media/uploads/${uploadId}/complete`, {
      sha256: sha256Of(bytes), width: null, height: null, durationMs: null, thumbnailData: null,
      compatibility: 'candidate', parts: [{ partNumber: 1, size: 8_388_608 }, { partNumber: 2, size: 8_388_608 }, { partNumber: 3, size: 3_222_784 }],
    });
    expect(complete.status).toBe(409);
    expect(complete.body.code).toBe('upload_incomplete');
  });

  it('still finalizes for a client that sends no part manifest', async () => {
    const bytes = pngBytes(4096);
    const session = await callApi('POST', '/api/admin/media/uploads', { fileName: 'legacy.png', fileSize: bytes.length, mimeType: 'image/png' });
    const uploadId = session.body.uploadId as string;
    const { uploadParts } = await import('@/lib/client/media-upload');
    await uploadParts(new File([bytes], 'legacy.png', { type: 'image/png' }), uploadId, [1], () => undefined);

    const complete = await callApi('POST', `/api/admin/media/uploads/${uploadId}/complete`, {
      sha256: sha256Of(bytes), width: null, height: null, durationMs: null, thumbnailData: null, compatibility: 'candidate',
    });
    expect(complete.status, JSON.stringify(complete.body)).toBe(201);
    expectSameBytes(store.objects.get(String(complete.body.media.storage_path))!.bytes, bytes);
  });

  it('rejects a stored object whose assembled length differs from the declared file size', async () => {
    // A client that declares the right sizes but PUTs the wrong bytes is caught by HeadObject,
    // which measures what the store actually assembled.
    const declaredSize = 4096;
    const session = await callApi('POST', '/api/admin/media/uploads', { fileName: 'short.png', fileSize: declaredSize, mimeType: 'image/png' });
    const uploadId = session.body.uploadId as string;
    const ticket = await callApi('POST', `/api/admin/media/uploads/${uploadId}/parts`, { partNumbers: [1] });
    const shortBytes = pngBytes(1024);
    await realFetch(ticket.body.urls[1] as string, { method: 'PUT', body: shortBytes });

    const complete = await callApi('POST', `/api/admin/media/uploads/${uploadId}/complete`, {
      sha256: sha256Of(shortBytes), width: null, height: null, durationMs: null, thumbnailData: null,
      compatibility: 'candidate', parts: [{ partNumber: 1, size: declaredSize }],
    });
    expect(complete.status).toBe(422);
    expect(complete.body.code).toBe('stored_file_mismatch');
  });
});
