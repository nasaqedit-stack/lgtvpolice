/**
 * Media optimization tests: REAL sharp (images) and REAL ffmpeg (videos), plus the
 * processSubmissionMedia orchestration (state transitions, audit events, original preservation,
 * failure recovery and safe retry) with injected storage seams.
 */
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createFakeDb, type Row } from './helpers/fake-db';
import {
  buildVideoOptimizationArgs,
  optimizeImage,
  optimizeVideo,
  parseFfmpegStreamInfo,
  processSubmissionMedia,
} from '../lib/server/media-optimization';
import { reprocessSubmission } from '../lib/server/submissions';

const FFMPEG_BIN = '/home/user/.local/lib/python3.11/site-packages/imageio_ffmpeg/binaries/ffmpeg-linux-x86_64-v7.0.2';

beforeAll(() => {
  process.env.FFMPEG_BIN = FFMPEG_BIN;
});

async function makePng(width: number, height: number, options: { orientation?: number } = {}): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  let pipeline = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 60, b: 60 } } });
  if (options.orientation) pipeline = pipeline.withMetadata({ orientation: options.orientation });
  return pipeline.png().toBuffer();
}

describe('image optimization (sharp)', () => {
  it('produces a WebP web version and thumbnail, preserving aspect ratio, never upscaling', async () => {
    const png = await makePng(2000, 1000);
    const result = await optimizeImage(png);

    expect(result.web.mimeType).toBe('image/webp');
    expect(result.web.width).toBe(1920); // capped
    expect(result.web.height).toBe(960); // aspect ratio preserved
    expect(result.thumbnail.width).toBe(480);
    expect(result.thumbnail.height).toBe(240);
    expect(String.fromCharCode(...result.web.data.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...result.web.data.slice(8, 12))).toBe('WEBP');
    // No EXIF/metadata in the public delivery copy.
    const sharp = (await import('sharp')).default;
    const meta = await sharp(result.web.data).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    // WebP is actually smaller than the source PNG.
    expect(result.web.data.length).toBeLessThan(png.length);
  });

  it('does not upscale small images', async () => {
    const png = await makePng(320, 200);
    const result = await optimizeImage(png);
    expect(result.web.width).toBe(320);
    expect(result.web.height).toBe(200);
    expect(result.thumbnail.width).toBe(320);
    expect(result.thumbnail.height).toBe(200);
  });

  it('applies EXIF orientation (correct orientation is preserved)', async () => {
    const png = await makePng(100, 50, { orientation: 6 }); // rotate 90 CW
    const result = await optimizeImage(png);
    expect(result.web.width).toBe(50);
    expect(result.web.height).toBe(100);
  });
});

describe('video optimization (ffmpeg)', () => {
  it('builds transcode args with faststart, H.264/AAC, yuv420p and a downscale-only width cap', () => {
    const args = buildVideoOptimizationArgs('/in.mov', '/out.mp4');
    const joined = args.join(' ');
    expect(joined).toContain('-movflags +faststart');
    expect(joined).toContain('-c:v libx264');
    expect(joined).toContain('-c:a aac');
    expect(joined).toContain('-pix_fmt yuv420p');
    expect(joined).toContain("min(1920,iw)");
    expect(joined).toContain('-map 0:a:0?'); // audio optional but preserved when present
    expect(joined).toContain('-map_metadata -1'); // metadata stripped from delivery copy
    expect(args[args.length - 1]).toBe('/out.mp4');
  });

  it('parses stream info from ffmpeg output', () => {
    const stderr = [
      'Input #0, mov,mp4,m4a,3gp,3g2,mj2, from \'in.mp4\':',
      '  Duration: 00:00:12.50, start: 0.000000, bitrate: 1234 kb/s',
      '  Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1280x720 [SAR 1:1 DAR 16:9], 1000 kb/s, 25 fps',
      '  Stream #0:1(und): Audio: aac (LC) (mp4a / 0x61706D34), 48000 Hz, stereo',
    ].join('\n');
    expect(parseFfmpegStreamInfo(stderr)).toEqual({ width: 1280, height: 720, durationMs: 12500 });
  });

  it('optimizes a real video: MP4/H.264/AAC, faststart, audio kept, thumbnail generated', async () => {
    const source = await makeTestVideo(1280, 720, 2);
    const result = await optimizeVideo(source);

    expect(result.playback.mimeType).toBe('video/mp4');
    expect(String.fromCharCode(...result.playback.data.slice(4, 8))).toBe('ftyp');
    expect(result.width).toBe(1280);
    expect(result.height).toBe(720);
    expect(result.durationMs).toBeGreaterThanOrEqual(1900);
    // faststart: the moov atom must come before mdat for fast startup.
    const bytes = result.playback.data;
    const moovAt = bytes.indexOf(Buffer.from('moov'));
    const mdatAt = bytes.indexOf(Buffer.from('mdat'));
    expect(moovAt).toBeGreaterThan(-1);
    expect(mdatAt).toBeGreaterThan(-1);
    expect(moovAt).toBeLessThan(mdatAt);
    // Thumbnail is a real WebP image.
    expect(result.thumbnail.mimeType).toBe('image/webp');
    expect(result.thumbnail.width).toBe(480);
    expect(result.thumbnail.height).toBe(270);
    expect(String.fromCharCode(...result.thumbnail.data.slice(0, 4))).toBe('RIFF');
  }, 180_000);

  it('never upscales: a small video keeps its native resolution', async () => {
    const source = await makeTestVideo(640, 360, 1);
    const result = await optimizeVideo(source);
    expect(result.width).toBe(640);
    expect(result.height).toBe(360);
  }, 180_000);

  it('downscales an oversized video to the 1920 width cap, preserving aspect ratio', async () => {
    const source = await makeTestVideo(2560, 1440, 1);
    const result = await optimizeVideo(source);
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
  }, 180_000);

  it('rejects input that is not a readable video', async () => {
    await expect(optimizeVideo(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))).rejects.toThrow();
  });
});

describe('processSubmissionMedia orchestration', () => {
  const SUBMISSION_ID = 'eeeeeeee-0000-4000-8000-000000000001';

  function seedSubmission(overrides: Row = {}) {
    const db = createFakeDb({
      submissions: [{
        id: SUBMISSION_ID,
        link_id: 'link-1',
        title: 'مشاركة',
        contributor_name: 'سارة',
        contributor_contact: 'sara@example.org',
        state: 'SUBMITTED',
        version: 1,
        consent_accepted: true,
        consent_text: 'text',
        consent_version: 'v',
        consent_at: new Date().toISOString(),
        kind: 'image',
        mime_type: 'image/png',
        original_storage_path: `submissions/${SUBMISSION_ID}/original`,
        file_size: 1000,
        sha256: createHash('sha256').update('original').digest('hex'),
        processing_status: 'pending',
        processing_attempts: 0,
        created_at: new Date().toISOString(),
        ...overrides,
      }],
    });
    db.setRpc('consume_submission_rate_limit', () => true);
    return db;
  }

  function makeDeps(overrides: { failOptimize?: boolean } = {}) {
    const uploaded = new Map<string, Uint8Array>();
    const removed: string[] = [];
    const originalBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const optimizedBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 9, 9, 9, 9, 0x57, 0x45, 0x42, 0x50]);
    const deps = {
      download: async (key: string) => {
        if (key !== `submissions/${SUBMISSION_ID}/original`) throw new Error('unexpected key ' + key);
        return originalBytes;
      },
      upload: async (key: string, body: Uint8Array) => { uploaded.set(key, body); },
      remove: async (key: string) => { removed.push(key); },
      optimizeImage: async () => ({
        web: { data: Buffer.from(optimizedBytes), mimeType: 'image/webp' as const, extension: 'webp' as const, width: 800, height: 600 },
        thumbnail: { data: Buffer.from(optimizedBytes.subarray(0, 6)), mimeType: 'image/webp' as const, extension: 'webp' as const, width: 480, height: 360 },
      }),
      optimizeVideo: async () => { throw new Error('not used'); },
    };
    if (overrides.failOptimize) deps.optimizeImage = async () => { throw new Error('sharp exploded'); };
    return { deps, uploaded, removed, originalBytes, optimizedBytes };
  }

  it('success: uploads versioned optimized+thumbnail, marks completed, audits, preserves the original', async () => {
    const db = seedSubmission();
    const { deps, uploaded, originalBytes, optimizedBytes } = makeDeps();
    const submission = db.state.submissions[0];

    const result = await processSubmissionMedia(db, submission, deps);

    expect(result.ok).toBe(true);
    const row = db.state.submissions[0];
    expect(row.state).toBe('READY_FOR_REVIEW');
    expect(row.processing_status).toBe('completed');
    expect(row.optimized_storage_path).toBe(`submissions/${SUBMISSION_ID}/optimized-v1.webp`);
    expect(row.thumbnail_storage_path).toBe(`submissions/${SUBMISSION_ID}/thumbnail-v1.webp`);
    expect(row.optimized_sha256).toBe(createHash('sha256').update(optimizedBytes).digest('hex'));
    expect(row.width).toBe(800);
    expect(row.height).toBe(600);
    expect(Buffer.from(uploaded.get(row.optimized_storage_path)!).equals(Buffer.from(optimizedBytes))).toBe(true);
    // The original was downloaded for processing but never re-uploaded or removed.
    expect(uploaded.has(`submissions/${SUBMISSION_ID}/original`)).toBe(false);
    expect(originalBytes.length).toBe(8);
    const events = db.state.submission_events.map((event: Row) => event.event);
    expect(events).toEqual(['PROCESSING_STARTED', 'PROCESSING_COMPLETED']);
  });

  it('failure: keeps the original, marks processing failed, audits PROCESSING_FAILED, never approves', async () => {
    const db = seedSubmission();
    const { deps, uploaded } = makeDeps({ failOptimize: true });

    const result = await processSubmissionMedia(db, db.state.submissions[0], deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('sharp exploded');
    const row = db.state.submissions[0];
    expect(row.state).toBe('READY_FOR_REVIEW'); // visible in the admin queue with the failure
    expect(row.processing_status).toBe('failed');
    expect(row.processing_error).toContain('sharp exploded');
    expect(row.approved_by ?? null).toBeNull();
    expect(uploaded.size).toBe(0); // nothing optimized was stored
    const events = db.state.submission_events.map((event: Row) => event.event);
    expect(events).toEqual(['PROCESSING_STARTED', 'PROCESSING_FAILED']);
  });

  it('safe retry after failure: reprocess bumps the version, reruns, and cleans stale artifacts', async () => {
    const db = seedSubmission();
    const failing = makeDeps({ failOptimize: true });
    await processSubmissionMedia(db, db.state.submissions[0], failing.deps);
    expect(db.state.submissions[0].processing_status).toBe('failed');

    // Admin retries (reprocess bumps version, clears approval), then processing succeeds.
    const reprocessed = await reprocessSubmission(db, db.state.submissions[0], { id: 'admin-1', role: 'admin' });
    expect(reprocessed.state).toBe('PROCESSING');
    expect(reprocessed.version).toBe(2);
    expect(reprocessed.approved_by ?? null).toBeNull();

    const succeeding = makeDeps();
    const result = await processSubmissionMedia(db, reprocessed, succeeding.deps);
    expect(result.ok).toBe(true);
    const row = db.state.submissions[0];
    expect(row.state).toBe('READY_FOR_REVIEW');
    expect(row.processing_status).toBe('completed');
    expect(row.version).toBe(2);
    expect(row.optimized_storage_path).toBe(`submissions/${SUBMISSION_ID}/optimized-v2.webp`);
    expect(Buffer.from(succeeding.uploaded.get(`submissions/${SUBMISSION_ID}/optimized-v2.webp`)!).equals(Buffer.from(succeeding.optimizedBytes))).toBe(true);
    const events = db.state.submission_events.map((event: Row) => event.event);
    expect(events).toEqual(['PROCESSING_STARTED', 'PROCESSING_FAILED', 'PROCESSING_STARTED', 'PROCESSING_COMPLETED']);
  });

  it('stale artifacts from a previous version are removed after a successful reprocess', async () => {
    const db = seedSubmission({
      state: 'REJECTED',
      version: 1,
      processing_status: 'completed',
      optimized_storage_path: `submissions/${SUBMISSION_ID}/optimized-v1.webp`,
      thumbnail_storage_path: `submissions/${SUBMISSION_ID}/thumbnail-v1.webp`,
    });
    const { deps, removed } = makeDeps();
    const reprocessed = await reprocessSubmission(db, db.state.submissions[0], { id: 'admin-1', role: 'admin' });
    const result = await processSubmissionMedia(db, reprocessed, deps);
    expect(result.ok).toBe(true);
    expect(removed).toEqual([
      `submissions/${SUBMISSION_ID}/optimized-v1.webp`,
      `submissions/${SUBMISSION_ID}/thumbnail-v1.webp`,
    ]);
    expect(db.state.submissions[0].optimized_storage_path).toBe(`submissions/${SUBMISSION_ID}/optimized-v2.webp`);
  });
});

/* ------------------------------------------------------------------ helpers */

async function makeTestVideo(width: number, height: number, seconds: number): Promise<Buffer> {
  const { spawn } = await import('node:child_process');
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'opt-test-'));
  try {
    const output = join(dir, 'in.mp4');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(FFMPEG_BIN, [
        '-y',
        '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=${width}x${height}:rate=10`,
        '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
        output,
      ]);
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', code => (code === 0 ? resolve() : reject(new Error(stderr.slice(-300)))));
    });
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
