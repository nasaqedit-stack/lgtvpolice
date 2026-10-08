import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { HttpError } from '@/lib/server/http';
import { getS3Client, storageConfig, storageRequestOptions } from '@/lib/server/storage';
import { recordSubmissionEvent } from '@/lib/server/submissions';
import {
  IMAGE_OPTIMIZED_MAX_DIMENSION,
  IMAGE_THUMBNAIL_MAX_DIMENSION,
  VIDEO_OPTIMIZED_MAX_WIDTH,
  type SubmissionState,
} from '@/lib/shared/submissions';

/**
 * Original + optimized media pipeline for public submissions.
 *
 * The contributor's ORIGINAL upload is never replaced, re-encoded or deleted; it stays in the
 * private bucket for administrator review. Next to it we store:
 *
 *   ORIGINAL   submissions/<id>/original                    (untouched contributor bytes)
 *   OPTIMIZED  submissions/<id>/optimized-v<version>.<ext>  (fast web/TV delivery)
 *   THUMBNAIL  submissions/<id>/thumbnail-v<version>.webp   (preview)
 *
 * Optimized objects are versioned and uploaded with an immutable cache policy, so delivery URLs
 * can be cached forever. If optimization fails the original is kept, the submission is marked
 * processing=failed (never approvable/publishable) and the administrator can retry safely.
 */

export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export type OptimizedImage = {
  data: Buffer;
  mimeType: 'image/webp';
  extension: 'webp';
  width: number;
  height: number;
};

export type OptimizedVideo = {
  playback: { data: Buffer; mimeType: 'video/mp4'; extension: 'mp4' };
  thumbnail: OptimizedImage;
  width: number | null;
  height: number | null;
  durationMs: number | null;
};

/* ------------------------------------------------------------------ images (sharp) */

/**
 * Optimize an image for delivery: EXIF orientation is applied, the image is downscaled to fit
 * inside 1920x1920 (never upscaled, aspect ratio preserved) and re-encoded as WebP with all
 * metadata stripped. A smaller 480px WebP thumbnail is produced alongside.
 */
export async function optimizeImage(input: Uint8Array): Promise<{ web: OptimizedImage; thumbnail: OptimizedImage }> {
  const sharp = (await import('sharp')).default;
  const source = sharp(input, { failOn: 'none' }).rotate(); // apply EXIF orientation, drop the tag
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height) throw new Error('تعذّر قراءة أبعاد الصورة.');

  const webData = await sharp(input)
    .rotate()
    .resize({ width: IMAGE_OPTIMIZED_MAX_DIMENSION, height: IMAGE_OPTIMIZED_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82, effort: 4 })
    .toBuffer();
  const webMeta = await sharp(webData).metadata();

  const thumbnailData = await sharp(input)
    .rotate()
    .resize({ width: IMAGE_THUMBNAIL_MAX_DIMENSION, height: IMAGE_THUMBNAIL_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 70, effort: 4 })
    .toBuffer();
  const thumbnailMeta = await sharp(thumbnailData).metadata();

  return {
    web: { data: webData, mimeType: 'image/webp', extension: 'webp', width: webMeta.width ?? 0, height: webMeta.height ?? 0 },
    thumbnail: { data: thumbnailData, mimeType: 'image/webp', extension: 'webp', width: thumbnailMeta.width ?? 0, height: thumbnailMeta.height ?? 0 },
  };
}

/* ------------------------------------------------------------------ videos (ffmpeg) */

/** Locate the ffmpeg binary: FFMPEG_BIN override, then the ffmpeg-static package. */
export async function ffmpegPath(): Promise<string> {
  if (process.env.FFMPEG_BIN) return process.env.FFMPEG_BIN;
  try {
    const mod = await import('ffmpeg-static');
    const path = (mod as unknown as { default?: string } | string);
    const resolved = typeof path === 'string' ? path : path?.default;
    if (resolved) return resolved;
  } catch {
    // fall through to the error below
  }
  throw new Error('ffmpeg binary is not available on this server.');
}

/**
 * Transcode arguments for the optimized playback version:
 * H.264 + AAC in MP4 (the player architecture's recommended codecs), faststart for fast startup,
 * yuv420p for TV/mobile compatibility, audio preserved, and a width cap that only ever
 * DOWNSCALES — small videos keep their native resolution and aspect ratio is always preserved.
 */
export function buildVideoOptimizationArgs(inputPath: string, outputPath: string, maxWidth = VIDEO_OPTIMIZED_MAX_WIDTH): string[] {
  return [
    '-y',
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-vf', `scale=w='trunc(min(${maxWidth},iw)/2)*2':h=-2`,
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-map_metadata', '-1',
    '-f', 'mp4',
    outputPath,
  ];
}

/** Extract one thumbnail frame (WebP) at `atSeconds`. */
export function buildVideoThumbnailArgs(inputPath: string, outputPath: string, atSeconds: number, maxWidth = IMAGE_THUMBNAIL_MAX_DIMENSION): string[] {
  return [
    '-y',
    '-ss', String(atSeconds),
    '-i', inputPath,
    '-frames:v', '1',
    '-vf', `scale=w='trunc(min(${maxWidth},iw)/2)*2':h=-2`,
    '-f', 'image2',
    outputPath,
  ];
}

/** Parse "Duration: 00:00:12.34" and the last "Video: … 1920x1080" stream line from ffmpeg output. */
export function parseFfmpegStreamInfo(stderr: string): { width: number | null; height: number | null; durationMs: number | null } {
  let durationMs: number | null = null;
  const duration = /Duration:\s*(\d+):(\d+):(\d+)(?:\.(\d+))?/.exec(stderr);
  if (duration) {
    // The fractional part is a fraction of a second (ffmpeg prints centiseconds).
    const fractionMs = duration[4] ? Math.round(Number(`0.${duration[4]}`) * 1000) : 0;
    durationMs = ((Number(duration[1]) * 60 + Number(duration[2])) * 60 + Number(duration[3])) * 1000 + fractionMs;
  }
  let width: number | null = null;
  let height: number | null = null;
  for (const match of stderr.matchAll(/Video:\s*[^\n]*?(\d{2,5})x(\d{2,5})/g)) {
    width = Number(match[1]);
    height = Number(match[2]);
  }
  return { width, height, durationMs };
}

function runFfmpegRaw(binary: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function runFfmpeg(binary: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return runFfmpegRaw(binary, args).then(result => {
    if (result.code === 0) return { stdout: result.stdout, stderr: result.stderr };
    throw new Error(`ffmpeg exited with code ${result.code}: ${result.stderr.slice(-400)}`);
  });
}

async function probeFfmpeg(binary: string, inputPath: string): Promise<{ width: number | null; height: number | null; durationMs: number | null }> {
  // `ffmpeg -i` without an output exits non-zero but prints stream info on stderr. Parse the
  // FULL stderr (not a truncated error tail): the video stream line can fall outside a
  // last-400-chars window when audio stream info follows it.
  const result = await runFfmpegRaw(binary, ['-i', inputPath]);
  const parsed = parseFfmpegStreamInfo(result.stderr);
  if (result.code === 0 || (parsed.width && parsed.height)) return parsed;
  throw new Error(`ffmpeg could not read the input video: ${result.stderr.slice(-300)}`);
}

/**
 * Optimize a video for playback: MP4/H.264/AAC with faststart, width capped at 1920 (downscale
 * only, aspect ratio and orientation preserved, audio kept), plus a WebP thumbnail frame.
 */
export async function optimizeVideo(input: Uint8Array): Promise<OptimizedVideo> {
  const binary = await ffmpegPath();
  const dir = await mkdtemp(join(tmpdir(), 'submission-video-'));
  try {
    const inputPath = join(dir, 'input.bin');
    const outputPath = join(dir, 'output.mp4');
    const thumbnailPath = join(dir, 'thumb.webp');
    await writeFile(inputPath, input);

    const probe = await probeFfmpeg(binary, inputPath);
    if (!probe.width || !probe.height) throw new Error('تعذّر قراءة مسار الفيديو من الملف.');

    const transcode = await runFfmpeg(binary, buildVideoOptimizationArgs(inputPath, outputPath));
    const playback = await readFile(outputPath);
    if (playback.length < 64 || String.fromCharCode(...playback.slice(4, 8)) !== 'ftyp') {
      throw new Error('The transcoder produced an invalid MP4 output.');
    }
    const outInfo = parseFfmpegStreamInfo(transcode.stderr);

    // Thumbnail at 1s; fall back to the first frame for very short clips.
    let thumbnail: OptimizedImage | null = null;
    for (const atSeconds of [1, 0]) {
      try {
        await runFfmpeg(binary, buildVideoThumbnailArgs(inputPath, thumbnailPath, atSeconds));
        const data = await readFile(thumbnailPath);
        if (data.length > 0) {
          const sharp = (await import('sharp')).default;
          const meta = await sharp(data).metadata();
          thumbnail = { data, mimeType: 'image/webp', extension: 'webp', width: meta.width ?? 0, height: meta.height ?? 0 };
          break;
        }
      } catch {
        // try the next timestamp
      }
    }
    if (!thumbnail) throw new Error('تعذّر استخراج صورة مصغّرة من الفيديو.');

    return {
      playback: { data: playback, mimeType: 'video/mp4', extension: 'mp4' },
      thumbnail,
      width: outInfo.width ?? probe.width,
      height: outInfo.height ?? probe.height,
      durationMs: probe.durationMs ?? outInfo.durationMs,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ orchestration */

export type ProcessMediaDeps = {
  download?: (key: string) => Promise<Uint8Array>;
  upload?: (key: string, body: Uint8Array, contentType: string) => Promise<void>;
  remove?: (key: string) => Promise<void>;
  optimizeImage?: typeof optimizeImage;
  optimizeVideo?: typeof optimizeVideo;
};

async function defaultDownload(key: string): Promise<Uint8Array> {
  const config = storageConfig();
  const result = await getS3Client().send(new GetObjectCommand({ Bucket: config.bucket, Key: key }), storageRequestOptions(120_000));
  if (!result.Body) throw new Error('empty object body');
  return new Uint8Array(await result.Body.transformToByteArray());
}

async function defaultUpload(key: string, body: Uint8Array, contentType: string): Promise<void> {
  const config = storageConfig();
  await getS3Client().send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: IMMUTABLE_CACHE_CONTROL,
  }), storageRequestOptions(120_000));
}

async function defaultRemove(key: string): Promise<void> {
  const config = storageConfig();
  await getS3Client().send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }), storageRequestOptions(15_000)).catch(() => undefined);
}

export type ProcessMediaResult =
  | { ok: true; submission: any }
  | { ok: false; error: string; submission: any };

/**
 * Run the full optimization pipeline for a submission and persist the result:
 *
 *   SUBMITTED/… -> PROCESSING (audit PROCESSING_STARTED)
 *     -> download ORIGINAL -> optimize -> upload OPTIMIZED + THUMBNAIL (immutable, versioned)
 *     -> READY_FOR_REVIEW with processing=completed (audit PROCESSING_COMPLETED)
 *
 * On failure: the original and any previous optimized artifacts are kept, processing=failed is
 * recorded (audit PROCESSING_FAILED) and the submission returns to READY_FOR_REVIEW so the
 * administrator sees the failure and can retry. The function never throws for processing
 * errors; it returns `{ ok: false }` so the upload response stays consistent.
 */
export async function processSubmissionMedia(db: any, submission: any, deps: ProcessMediaDeps = {}): Promise<ProcessMediaResult> {
  const download = deps.download ?? defaultDownload;
  const upload = deps.upload ?? defaultUpload;
  const remove = deps.remove ?? defaultRemove;
  const attempt = Number(submission.processing_attempts ?? 0) + 1;

  // Move to PROCESSING. After a fresh upload the submission is still SUBMITTED; on an admin
  // retry, reprocessSubmission already moved it to PROCESSING and wrote the audit event, so
  // only the attempt counter is refreshed here (no duplicate PROCESSING_STARTED event).
  let processing = submission;
  if (submission.state !== 'PROCESSING') {
    const startedAt = new Date().toISOString();
    const { data: updated, error: processingError } = await db.from('submissions').update({
      state: 'PROCESSING',
      processing_status: 'processing',
      processing_started_at: startedAt,
      processing_attempts: attempt,
      updated_at: startedAt,
    }).eq('id', submission.id).eq('state', submission.state).select('*').maybeSingle();
    if (processingError) throw processingError;
    if (!updated) throw new HttpError(409, 'تغيّرت حالة المشاركة بشكل متزامن.', 'state_conflict');
    processing = updated;
    await recordSubmissionEvent(db, {
      submissionId: submission.id,
      event: 'PROCESSING_STARTED',
      actorRole: 'system',
      stateAfter: 'PROCESSING',
      details: { attempt, version: submission.version },
    });
  } else {
    const { data: updated, error: processingError } = await db.from('submissions').update({
      processing_attempts: attempt,
      updated_at: new Date().toISOString(),
    }).eq('id', submission.id).eq('state', 'PROCESSING').select('*').maybeSingle();
    if (processingError) throw processingError;
    if (!updated) throw new HttpError(409, 'تغيّرت حالة المشاركة بشكل متزامن.', 'state_conflict');
    processing = updated;
  }

  try {
    if (!processing.original_storage_path) throw new Error('original file is missing');
    const original = await download(processing.original_storage_path);

    let optimized: { data: Buffer; mimeType: string; extension: string };
    let thumbnail: { data: Buffer; mimeType: string };
    let width = processing.width ?? null;
    let height = processing.height ?? null;
    let durationMs = processing.duration_ms ?? null;

    if (processing.kind === 'video') {
      const result = await (deps.optimizeVideo ?? optimizeVideo)(original);
      optimized = result.playback;
      thumbnail = result.thumbnail;
      width = result.width ?? width;
      height = result.height ?? height;
      durationMs = result.durationMs ?? durationMs;
    } else {
      const result = await (deps.optimizeImage ?? optimizeImage)(original);
      optimized = result.web;
      thumbnail = result.thumbnail;
      width = result.web.width || width;
      height = result.web.height || height;
    }

    const optimizedKey = `submissions/${processing.id}/optimized-v${processing.version}.${optimized.extension}`;
    const thumbnailKey = `submissions/${processing.id}/thumbnail-v${processing.version}.webp`;
    await upload(optimizedKey, optimized.data, optimized.mimeType);
    await upload(thumbnailKey, thumbnail.data, thumbnail.mimeType);

    // Versioned keys make old artifacts unreachable; remove them to avoid storage growth.
    const staleKeys = [processing.optimized_storage_path, processing.thumbnail_storage_path]
      .filter((key): key is string => typeof key === 'string' && key !== optimizedKey && key !== thumbnailKey);
    for (const key of staleKeys) await remove(key);

    const completedAt = new Date().toISOString();
    const { data: updated, error: updateError } = await db.from('submissions').update({
      state: 'READY_FOR_REVIEW' as SubmissionState,
      processing_status: 'completed',
      processing_error: null,
      processing_completed_at: completedAt,
      optimized_storage_path: optimizedKey,
      optimized_mime_type: optimized.mimeType,
      optimized_file_size: optimized.data.length,
      optimized_sha256: createHash('sha256').update(optimized.data).digest('hex'),
      thumbnail_storage_path: thumbnailKey,
      thumbnail_mime_type: thumbnail.mimeType,
      thumbnail_file_size: thumbnail.data.length,
      width,
      height,
      duration_ms: durationMs,
      updated_at: completedAt,
    }).eq('id', processing.id).eq('state', 'PROCESSING').select('*').maybeSingle();
    if (updateError) throw updateError;
    if (!updated) throw new HttpError(409, 'تغيّرت حالة المشاركة بشكل متزامن.', 'state_conflict');
    await recordSubmissionEvent(db, {
      submissionId: processing.id,
      event: 'PROCESSING_COMPLETED',
      actorRole: 'system',
      stateAfter: 'READY_FOR_REVIEW',
      details: {
        attempt,
        version: processing.version,
        optimizedBytes: optimized.data.length,
        optimizedSha256: createHash('sha256').update(optimized.data).digest('hex'),
        thumbnailBytes: thumbnail.data.length,
      },
    });
    return { ok: true, submission: updated };
  } catch (error) {
    // Failure handling: keep the original, mark processing failed, never approve/publish
    // automatically, and leave the submission in READY_FOR_REVIEW so the admin sees the failure.
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    const failedAt = new Date().toISOString();
    const { data: failed, error: failError } = await db.from('submissions').update({
      state: 'READY_FOR_REVIEW' as SubmissionState,
      processing_status: 'failed',
      processing_error: message,
      updated_at: failedAt,
    }).eq('id', processing.id).eq('state', 'PROCESSING').select('*').maybeSingle();
    if (failError) throw failError;
    await recordSubmissionEvent(db, {
      submissionId: processing.id,
      event: 'PROCESSING_FAILED',
      actorRole: 'system',
      stateAfter: 'READY_FOR_REVIEW',
      details: { attempt, version: processing.version, error: message },
    });
    return { ok: false, error: message, submission: failed ?? processing };
  }
}

/** Object key for the untouched contributor upload. Fixed per submission; never rewritten. */
export function originalObjectKey(submissionId: string): string {
  return `submissions/${submissionId}/original`;
}

export function newUploadId(): string {
  return randomUUID();
}
