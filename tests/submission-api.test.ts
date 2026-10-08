/**
 * End-to-end tests of the PUBLIC submission flow against the real Next.js route handlers:
 *
 *   POST /api/submit/[token]/uploads            (consent + metadata + upload session)
 *     -> POST …/parts (presign) -> PUT to fake storage -> POST …/complete (assemble, verify,
 *        mark SUBMITTED, run REAL media optimization via sharp/ffmpeg)
 *
 * The fake database and fake object store are the only seams; validation, the state machine,
 * consent recording, audit events, original preservation and optimized delivery all run for
 * real.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createFakeDb, type Row } from './helpers/fake-db';
import { startFakeStorage } from './helpers/fake-storage';
import { CONSENT_TEXT_AR, CONSENT_VERSION } from '../lib/shared/submissions';
import { generateSubmissionToken, hashSubmissionToken } from '../lib/server/submission-links';

/* ------------------------------------------------------------------ seams */

let db = createFakeDb();
let rateLimitCalls = 0;
let rateLimitAllow = true;

vi.mock('@/lib/server/supabase', () => ({
  createSupabaseServer: () => ({ auth: { getUser: async () => ({ data: { user: null }, error: null }) } }),
  createSupabaseAdmin: () => db,
  getSupabasePublicConfig: () => ({ url: 'http://supabase.test', anonKey: 'anon' }),
}));

import { POST as createUpload } from '../app/api/submit/[token]/uploads/route';
import { POST as presignParts } from '../app/api/submit/[token]/uploads/[uploadId]/parts/route';
import { POST as completeUpload } from '../app/api/submit/[token]/uploads/[uploadId]/complete/route';
import { POST as abortUpload } from '../app/api/submit/[token]/uploads/[uploadId]/abort/route';
import { GET as publicMedia } from '../app/api/public/submissions/[id]/media/route';
import { GET as publicMeta } from '../app/api/public/submissions/[id]/route';

/* ------------------------------------------------------------------ fixtures */

const LINK_TOKEN = generateSubmissionToken().token;
const OTHER_LINK_TOKEN = generateSubmissionToken().token;
const LINK_ID = 'link-1';
const OTHER_LINK_ID = 'link-2';

function seedLinks() {
  db.state.submission_links = [
    { id: LINK_ID, token_hash: hashSubmissionToken(LINK_TOKEN), label: 'حملة التوعية', active: true, created_at: new Date().toISOString(), expires_at: null },
    { id: OTHER_LINK_ID, token_hash: hashSubmissionToken(OTHER_LINK_TOKEN), label: 'رابط آخر', active: true, created_at: new Date().toISOString(), expires_at: null },
  ];
}

function request(path: string, init: { method?: string; body?: unknown; origin?: string } = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      origin: init.origin ?? 'http://localhost',
      'x-forwarded-for': '203.0.113.9',
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

const basePayload = {
  fileName: 'poster.png',
  fileSize: 0, // set per test
  mimeType: 'image/png',
  title: 'ملصق توعوي أمني',
  description: 'ملصق لحملة توعية',
  contributorName: 'سارة Abdullah',
  contributorContact: 'sara@example.org',
  consentAccepted: true,
  consentVersion: CONSENT_VERSION,
  consentText: CONSENT_TEXT_AR,
};

async function makePng(width = 64, height = 64): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  return sharp({ create: { width, height, channels: 3, background: { r: 30, g: 90, b: 140 } } }).png().toBuffer();
}

async function makeMp4(): Promise<Buffer> {
  const ffmpeg = process.env.FFMPEG_BIN!;
  const dir = await mkdtemp(join(tmpdir(), 'submission-test-video-'));
  try {
    const output = join(dir, 'in.mp4');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(ffmpeg, [
        '-y',
        '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=10',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
        output,
      ]);
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', code => (code === 0 ? resolve() : reject(new Error(stderr.slice(-300)))));
    });
    const { readFile } = await import('node:fs/promises');
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Run the whole public upload flow for one file and return the final response + submission row. */
async function runPublicUpload(fileBytes: Buffer, mimeType: string, fileName: string, payloadOverrides: Record<string, unknown> = {}, token = LINK_TOKEN) {
  const createResponse = await createUpload(request(`/api/submit/${token}/uploads`, {
    method: 'POST',
    body: { ...basePayload, fileName, fileSize: fileBytes.length, mimeType, ...payloadOverrides },
  }), { params: Promise.resolve({ token }) });
  const created = await createResponse.json();
  if (createResponse.status !== 201) throw new Error(`create failed: ${JSON.stringify(created)}`);

  const partsResponse = await presignParts(request(`/api/submit/${token}/uploads/${created.uploadId}/parts`, {
    method: 'POST',
    body: { partNumbers: Array.from({ length: created.totalParts }, (_, index) => index + 1) },
  }), { params: Promise.resolve({ token, uploadId: created.uploadId }) });
  const ticket = await partsResponse.json();
  const uploaded: Array<{ partNumber: number; size: number }> = [];
  for (let partNumber = 1; partNumber <= created.totalParts; partNumber += 1) {
    const partSize = Math.min(8 * 1024 * 1024, fileBytes.length - (partNumber - 1) * 8 * 1024 * 1024);
    const put = await fetch(ticket.urls[partNumber], { method: 'PUT', body: new Uint8Array(fileBytes.subarray((partNumber - 1) * 8 * 1024 * 1024, (partNumber - 1) * 8 * 1024 * 1024 + partSize)) });
    expect(put.status).toBe(200);
    uploaded.push({ partNumber, size: partSize });
  }

  const completeResponse = await completeUpload(request(`/api/submit/${token}/uploads/${created.uploadId}/complete`, {
    method: 'POST',
    body: { sha256: createHash('sha256').update(fileBytes).digest('hex'), parts: uploaded },
  }), { params: Promise.resolve({ token, uploadId: created.uploadId }) });
  const completed = await completeResponse.json();
  const submission = db.state.submissions.find((row: Row) => row.id === created.submissionId);
  if (!submission) throw new Error('submission row missing after upload');
  return { createResponse, created, completeResponse, completed, submission };
}

/* ------------------------------------------------------------------ setup */

let storage: Awaited<ReturnType<typeof startFakeStorage>>;

beforeAll(async () => {
  process.env.FFMPEG_BIN = process.env.FFMPEG_BIN || '/home/user/.local/lib/python3.11/site-packages/imageio_ffmpeg/binaries/ffmpeg-linux-x86_64-v7.0.2';
  storage = await startFakeStorage();
  process.env.SUPABASE_S3_ENDPOINT = storage.endpoint;
  process.env.SUPABASE_S3_REGION = 'us-east-1';
  process.env.SUPABASE_S3_ACCESS_KEY_ID = 'fake-access-key';
  process.env.SUPABASE_S3_SECRET_ACCESS_KEY = 'fake-secret-key';
  process.env.SIGNAGE_STORAGE_BUCKET = 'signage-media';
});

afterAll(async () => {
  await new Promise(resolve => storage.server.close(resolve));
});

beforeEach(() => {
  db = createFakeDb();
  seedLinks();
  rateLimitCalls = 0;
  rateLimitAllow = true;
  db.setRpc('consume_submission_rate_limit', () => {
    rateLimitCalls += 1;
    return rateLimitAllow && rateLimitCalls <= 100;
  });
  db.setRpc('get_media_usage_counts', (args: any) => (args.p_media_ids as string[]).map(media_id => ({ media_id, usage_count: 0 })));
});

/* ------------------------------------------------------------------ tests */

describe('public submission API', () => {
  it('rejects submissions without explicit consent', async () => {
    const payload: Record<string, unknown> = { ...basePayload, fileSize: 1024 };
    delete payload.consentAccepted;
    const response = await createUpload(request(`/api/submit/${LINK_TOKEN}/uploads`, { method: 'POST', body: payload }), { params: Promise.resolve({ token: LINK_TOKEN }) });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('consent_required');
    expect(db.state.submissions).toHaveLength(0);
  });

  it('rejects consentAccepted=false', async () => {
    const response = await createUpload(request(`/api/submit/${LINK_TOKEN}/uploads`, { method: 'POST', body: { ...basePayload, fileSize: 1024, consentAccepted: false } }), { params: Promise.resolve({ token: LINK_TOKEN }) });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('consent_required');
  });

  it('rejects oversized and unsupported files before any storage is created', async () => {
    const oversized = await createUpload(request(`/api/submit/${LINK_TOKEN}/uploads`, { method: 'POST', body: { ...basePayload, fileName: 'big.mp4', fileSize: 512 * 1024 * 1024 + 1, mimeType: 'video/mp4' } }), { params: Promise.resolve({ token: LINK_TOKEN }) });
    expect(oversized.status).toBe(400);
    const svg = await createUpload(request(`/api/submit/${LINK_TOKEN}/uploads`, { method: 'POST', body: { ...basePayload, fileName: 'vector.svg', fileSize: 100, mimeType: 'image/svg+xml' } }), { params: Promise.resolve({ token: LINK_TOKEN }) });
    expect(svg.status).toBe(400);
    expect(db.state.submissions).toHaveLength(0);
    expect(storage.objects.size).toBe(0);
  });

  it('rejects invalid or predictable link tokens (404, no admin data leaked)', async () => {
    for (const badToken of ['1', 'submission-1', generateSubmissionToken().token]) {
      const response = await createUpload(request(`/api/submit/${badToken}/uploads`, { method: 'POST', body: { ...basePayload, fileSize: 1024 } }), { params: Promise.resolve({ token: badToken }) });
      expect(response.status).toBe(404);
    }
    expect(db.state.submissions).toHaveLength(0);
  });

  it('rejects cross-origin requests', async () => {
    const response = await createUpload(request(`/api/submit/${LINK_TOKEN}/uploads`, { method: 'POST', body: { ...basePayload, fileSize: 1024 }, origin: 'https://evil.example' }), { params: Promise.resolve({ token: LINK_TOKEN }) });
    expect(response.status).toBe(403);
  });

  it('enforces the upload rate limit', async () => {
    rateLimitAllow = true;
    rateLimitCalls = 0;
    db.setRpc('consume_submission_rate_limit', () => {
      rateLimitCalls += 1;
      return rateLimitCalls <= 2; // first create consumes 2 buckets
    });
    const first = await createUpload(request(`/api/submit/${LINK_TOKEN}/uploads`, { method: 'POST', body: { ...basePayload, fileSize: 1024 } }), { params: Promise.resolve({ token: LINK_TOKEN }) });
    expect(first.status).toBe(201);
    const second = await createUpload(request(`/api/submit/${LINK_TOKEN}/uploads`, { method: 'POST', body: { ...basePayload, fileSize: 1024 } }), { params: Promise.resolve({ token: LINK_TOKEN }) });
    expect(second.status).toBe(429);
    expect((await second.json()).code).toBe('submission_rate_limited');
  });

  it('accepts a valid image submission: consent recorded, SUBMITTED, media optimized, original preserved', async () => {
    const png = await makePng(1200, 600);
    const { createResponse, created, completeResponse, completed, submission: foundImage } = await runPublicUpload(png, 'image/png', 'poster.png');
    expect(foundImage).not.toBeNull();
    const submission = foundImage!;

    expect(createResponse.status).toBe(201);
    expect(created.state).toBe('DRAFT'); // default after session creation: never APPROVED

    expect(completeResponse.status).toBe(201);
    expect(completed.processing).toBe('completed');
    expect(submission.state).toBe('READY_FOR_REVIEW');
    expect(submission.processing_status).toBe('completed');
    // Never approved, never public by default.
    expect(submission.state).not.toBe('APPROVED');
    expect(submission.approved_by ?? null).toBeNull();

    // Consent recorded with exact text/version/timestamp.
    expect(submission.consent_accepted).toBe(true);
    expect(submission.consent_text).toBe(CONSENT_TEXT_AR);
    expect(submission.consent_version).toBe(CONSENT_VERSION);
    expect(submission.consent_at).toBeTruthy();
    // Contributor info + salted IP hash recorded (raw IP is not stored).
    expect(submission.contributor_name).toBe('سارة Abdullah');
    expect(submission.ip_hash).toMatch(/^[a-f0-9]{64}$/);

    // Original preserved byte-for-byte; optimized + thumbnail created and versioned.
    const original = storage.objects.get(submission.original_storage_path);
    expect(original).toBeDefined();
    expect(Buffer.from(original!.bytes).equals(png)).toBe(true);
    const optimized = storage.objects.get(submission.optimized_storage_path);
    expect(optimized).toBeDefined();
    expect(String.fromCharCode(...optimized!.bytes.slice(0, 4))).toBe('RIFF');
    expect(optimized!.contentType).toBe('image/webp');
    expect(optimized!.cacheControl).toContain('immutable');
    expect(submission.optimized_sha256).toBe(createHash('sha256').update(optimized!.bytes).digest('hex'));
    expect(storage.objects.get(submission.thumbnail_storage_path)).toBeDefined();
    // The optimized version really is a downscaled WebP (1200x600 fits under the 1920 cap).
    const sharp = (await import('sharp')).default;
    const meta = await sharp(optimized!.bytes).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(1200);
    expect(meta.height).toBe(600);

    // Audit trail.
    const events = db.state.submission_events.filter((event: Row) => event.submission_id === submission.id).map((event: Row) => event.event);
    expect(events).toEqual(['CONSENT_ACCEPTED', 'SUBMITTED', 'PROCESSING_STARTED', 'PROCESSING_COMPLETED']);
  }, 60_000);

  it('accepts a valid video submission and produces an optimized MP4 + thumbnail', async () => {
    const mp4 = await makeMp4();
    const { completeResponse, completed, submission: foundVideo } = await runPublicUpload(mp4, 'video/mp4', 'clip.mp4');
    expect(foundVideo).not.toBeNull();
    const videoSubmission = foundVideo!;
    expect(completeResponse!.status).toBe(201);
    expect(completed!.processing).toBe('completed');
    expect(videoSubmission.state).toBe('READY_FOR_REVIEW');
    expect(videoSubmission.kind).toBe('video');

    // Original preserved byte-for-byte.
    const original = storage.objects.get(videoSubmission.original_storage_path);
    expect(Buffer.from(original!.bytes).equals(mp4)).toBe(true);

    // Optimized playback version: MP4 container, immutable cache, thumbnail generated.
    const optimized = storage.objects.get(videoSubmission.optimized_storage_path);
    expect(optimized).toBeDefined();
    expect(optimized!.contentType).toBe('video/mp4');
    expect(String.fromCharCode(...optimized!.bytes.slice(4, 8))).toBe('ftyp');
    expect(optimized!.cacheControl).toContain('immutable');
    expect(storage.objects.get(videoSubmission.thumbnail_storage_path)?.contentType).toBe('image/webp');
    // Dimensions/duration were read from the source.
    expect(videoSubmission.width).toBe(320);
    expect(videoSubmission.height).toBe(240);
    expect(videoSubmission.duration_ms).toBeGreaterThan(0);
  }, 180_000);

  it('rejects a file whose bytes do not match its declared type (magic-byte validation)', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]); // JPEG magic declared as PNG
    const { completeResponse, completed, submission: rejected } = await runPublicUpload(Buffer.from(jpeg), 'image/png', 'fake.png');
    expect(rejected).not.toBeNull();
    expect(completeResponse!.status).toBe(422);
    expect(completed!.code).toBe('file_signature_invalid');
    // The rejected object was removed and the submission stays in DRAFT (never SUBMITTED).
    expect(storage.objects.get(rejected!.original_storage_path)).toBeUndefined();
    expect(rejected!.state).toBe('DRAFT');
  });

  it('keeps the submission and the original when media optimization fails, and never approves it', async () => {
    // Valid PNG magic bytes, corrupt payload: sharp accepts the signature check but fails to decode.
    const png = await makePng();
    const corrupt = Buffer.concat([png.subarray(0, 32), Buffer.from('this is not a real png body at all'.repeat(20))]);
    const { completeResponse, completed, submission: foundFailed } = await runPublicUpload(corrupt, 'image/png', 'broken.png');
    expect(foundFailed).not.toBeNull();
    const failed = foundFailed!;

    expect(completeResponse!.status).toBe(201);
    expect(completed!.processing).toBe('failed');
    expect(completed!.processingError).toBeTruthy();
    expect(failed.state).toBe('READY_FOR_REVIEW'); // visible to the admin queue
    expect(failed.processing_status).toBe('failed');
    expect(failed.processing_error).toBeTruthy();
    // The original is preserved; no optimized version exists; nothing was approved.
    const original = storage.objects.get(failed.original_storage_path);
    expect(original).toBeDefined();
    expect(Buffer.from(original!.bytes).equals(corrupt)).toBe(true);
    expect(failed.optimized_storage_path ?? null).toBeNull();
    expect(failed.approved_by ?? null).toBeNull();
    const events = db.state.submission_events.filter((event: Row) => event.submission_id === failed.id).map((event: Row) => event.event);
    expect(events).toEqual(['CONSENT_ACCEPTED', 'SUBMITTED', 'PROCESSING_STARTED', 'PROCESSING_FAILED']);
  }, 60_000);

  it('blocks upload-part access across links (token A cannot touch link B sessions)', async () => {
    const png = await makePng();
    const createResponse = await createUpload(request(`/api/submit/${LINK_TOKEN}/uploads`, { method: 'POST', body: { ...basePayload, fileName: 'poster.png', fileSize: png.length } }), { params: Promise.resolve({ token: LINK_TOKEN }) });
    const created = await createResponse.json();
    expect(createResponse.status).toBe(201);
    const partsResponse = await presignParts(request(`/api/submit/${OTHER_LINK_TOKEN}/uploads/${created.uploadId}/parts`, { method: 'POST', body: { partNumbers: [1] } }), { params: Promise.resolve({ token: OTHER_LINK_TOKEN, uploadId: created.uploadId }) });
    expect(partsResponse.status).toBe(404);
  });

  it('aborts an upload session on contributor cancel', async () => {
    const png = await makePng();
    const createResponse = await createUpload(request(`/api/submit/${LINK_TOKEN}/uploads`, { method: 'POST', body: { ...basePayload, fileName: 'poster.png', fileSize: png.length } }), { params: Promise.resolve({ token: LINK_TOKEN }) });
    const created = await createResponse.json();
    const abortResponse = await abortUpload(request(`/api/submit/${LINK_TOKEN}/uploads/${created.uploadId}/abort`, { method: 'POST' }), { params: Promise.resolve({ token: LINK_TOKEN, uploadId: created.uploadId }) });
    expect(abortResponse.status).toBe(200);
    const uploadRow = db.state.submission_uploads.find((row: Row) => row.id === created.uploadId);
    expect(uploadRow).toBeDefined();
    expect(uploadRow!.status).toBe('aborted');
    const partsResponse = await presignParts(request(`/api/submit/${LINK_TOKEN}/uploads/${created.uploadId}/parts`, { method: 'POST', body: { partNumbers: [1] } }), { params: Promise.resolve({ token: LINK_TOKEN, uploadId: created.uploadId }) });
    expect(partsResponse.status).toBe(409);
  });

  it('keeps unapproved content invisible to the public', async () => {
    const png = await makePng();
    const { submission: found } = await runPublicUpload(png, 'image/png', 'poster.png');
    expect(found).not.toBeNull();
    const row = found!;
    expect(row.state).toBe('READY_FOR_REVIEW');

    const mediaResponse = await publicMedia(request(`/api/public/submissions/${row.id}/media`), { params: Promise.resolve({ id: row.id }) });
    expect(mediaResponse.status).toBe(404);
    const metaResponse = await publicMeta(request(`/api/public/submissions/${row.id}`), { params: Promise.resolve({ id: row.id }) });
    expect(metaResponse.status).toBe(404);
  });
});
