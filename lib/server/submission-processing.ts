import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { storageRequestOptions } from '@/lib/server/storage';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import { createReadStream, createWriteStream, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'stream/promises';

export const SUBMISSION_OPTIMIZED_IMAGE_MAX_DIMENSION = 1920;
export const SUBMISSION_THUMBNAIL_MAX_DIMENSION = 480;
export const SUBMISSION_VIDEO_MAX_WIDTH = 1920;
export const SUBMISSION_VIDEO_MAX_HEIGHT = 1080;

export type ProcessedMediaResult = {
  storagePath: string;
  mimeType: string;
  kind: 'image' | 'video';
  fileSize: number;
  sha256: string;
  width?: number;
  height?: number;
  durationMs?: number;
  thumbnailData?: string;
};

async function downloadToTemp(client: S3Client, bucket: string, key: string): Promise<string> {
  const tempPath = join(tmpdir(), `submit-${randomUUID()}-${key.replace(/\//g, '-')}`);
  const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), storageRequestOptions());
  if (!object.Body) throw new Error('Empty object body');
  await pipeline(object.Body as any, createWriteStream(tempPath));
  return tempPath;
}

async function uploadFromTemp(client: S3Client, bucket: string, key: string, tempPath: string, mimeType: string): Promise<{ fileSize: number; sha256: string }> {
  const stream = createReadStream(tempPath);
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256');
  let fileSize = 0;
  for await (const chunk of stream) {
    hash.update(chunk);
    fileSize += chunk.length;
  }
  await new Promise<void>((resolve, reject) => {
    const uploadStream = createReadStream(tempPath);
    client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: uploadStream,
      ContentType: mimeType,
      CacheControl: 'public, max-age=31536000, immutable',
    }), storageRequestOptions(120_000)).then(() => resolve()).catch(reject);
  });
  return { fileSize, sha256: hash.digest('hex') };
}

function cleanupTemp(...paths: string[]) {
  for (const p of paths) {
    if (existsSync(p)) {
      try { unlinkSync(p); } catch {}
    }
  }
}

export async function processSubmissionImage(
  client: S3Client,
  bucket: string,
  originalKey: string,
  submissionId: string
): Promise<{ optimized: ProcessedMediaResult; thumbnail: ProcessedMediaResult }> {
  const originalTemp = await downloadToTemp(client, bucket, originalKey);
  try {
    const originalBuffer = await sharp(originalTemp).toBuffer();
    const metadata = await sharp(originalBuffer).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;

    // Optimized web version (WebP, max 1920px, strip EXIF)
    const optimizedBuffer = await sharp(originalBuffer)
      .rotate() // Auto-rotate based on EXIF
      .resize({
        width: SUBMISSION_OPTIMIZED_IMAGE_MAX_DIMENSION,
        height: SUBMISSION_OPTIMIZED_IMAGE_MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 85, effort: 4 })
      .toBuffer();

    // Thumbnail (480px)
    const thumbnailBuffer = await sharp(originalBuffer)
      .rotate()
      .resize({
        width: SUBMISSION_THUMBNAIL_MAX_DIMENSION,
        height: SUBMISSION_THUMBNAIL_MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 75 })
      .toBuffer();

    const optimizedKey = `submissions/${submissionId}/optimized.webp`;
    const thumbnailKey = `submissions/${submissionId}/thumbnail.webp`;

    // Write buffers to temp files for upload
    const optimizedTemp = join(tmpdir(), `opt-${randomUUID()}.webp`);
    const thumbnailTemp = join(tmpdir(), `thumb-${randomUUID()}.webp`);
    await Promise.all([
      import('fs').then(fs => fs.promises.writeFile(optimizedTemp, optimizedBuffer)),
      import('fs').then(fs => fs.promises.writeFile(thumbnailTemp, thumbnailBuffer)),
    ]);

    const [optimizedResult, thumbnailResult] = await Promise.all([
      uploadFromTemp(client, bucket, optimizedKey, optimizedTemp, 'image/webp'),
      uploadFromTemp(client, bucket, thumbnailKey, thumbnailTemp, 'image/webp'),
    ]);

    cleanupTemp(originalTemp, optimizedTemp, thumbnailTemp);

    return {
      optimized: {
        storagePath: optimizedKey,
        mimeType: 'image/webp',
        kind: 'image',
        fileSize: optimizedResult.fileSize,
        sha256: optimizedResult.sha256,
        width: Math.min(width, SUBMISSION_OPTIMIZED_IMAGE_MAX_DIMENSION),
        height: Math.min(height, SUBMISSION_OPTIMIZED_IMAGE_MAX_DIMENSION),
        thumbnailData: `data:image/webp;base64,${thumbnailBuffer.toString('base64')}`,
      },
      thumbnail: {
        storagePath: thumbnailKey,
        mimeType: 'image/webp',
        kind: 'image',
        fileSize: thumbnailResult.fileSize,
        sha256: thumbnailResult.sha256,
        width: Math.min(width, SUBMISSION_THUMBNAIL_MAX_DIMENSION),
        height: Math.min(height, SUBMISSION_THUMBNAIL_MAX_DIMENSION),
      },
    };
  } catch (error) {
    cleanupTemp(originalTemp);
    throw error;
  }
}

export async function processSubmissionVideo(
  client: S3Client,
  bucket: string,
  originalKey: string,
  submissionId: string
): Promise<{ optimized: ProcessedMediaResult; thumbnail: ProcessedMediaResult }> {
  const originalTemp = await downloadToTemp(client, bucket, originalKey);
  const optimizedTemp = join(tmpdir(), `opt-${randomUUID()}.mp4`);
  const thumbnailTemp = join(tmpdir(), `thumb-${randomUUID()}.webp`);

  try {
    // Get video metadata
    const metadata = await new Promise<any>((resolve, reject) => {
      ffmpeg.ffprobe(originalTemp, (err: Error | null, data: any) => {
        if (err) reject(err);
        else resolve(data);
      });
    });

    const videoStream = metadata.streams.find((s: any) => s.codec_type === 'video');
    const originalWidth = videoStream?.width ?? 0;
    const originalHeight = videoStream?.height ?? 0;
    const durationMs = Math.round((metadata.format.duration ?? 0) * 1000);

    // Calculate target dimensions (max 1920x1080, preserve aspect ratio)
    let targetWidth = originalWidth;
    let targetHeight = originalHeight;
    if (targetWidth > SUBMISSION_VIDEO_MAX_WIDTH || targetHeight > SUBMISSION_VIDEO_MAX_HEIGHT) {
      const scale = Math.min(
        SUBMISSION_VIDEO_MAX_WIDTH / targetWidth,
        SUBMISSION_VIDEO_MAX_HEIGHT / targetHeight
      );
      targetWidth = Math.round(targetWidth * scale / 2) * 2; // Ensure even dimensions
      targetHeight = Math.round(targetHeight * scale / 2) * 2;
    }

    // Transcode to H.264/AAC, faststart, yuv420p
    await new Promise<void>((resolve, reject) => {
      ffmpeg(originalTemp)
        .videoCodec('libx264')
        .audioCodec('aac')
        .outputOptions([
          '-preset', 'medium',
          '-crf', '23',
          '-movflags', '+faststart',
          '-pix_fmt', 'yuv420p',
          '-vf', `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2`,
        ])
        .on('end', () => resolve())
        .on('error', reject)
        .save(optimizedTemp);
    });

    // Generate thumbnail at 10% position
    await new Promise<void>((resolve, reject) => {
      ffmpeg(originalTemp)
        .seekInput(durationMs > 0 ? (durationMs / 1000) * 0.1 : 1)
        .frames(1)
        .outputOptions([
          '-vf', `scale=${SUBMISSION_THUMBNAIL_MAX_DIMENSION}:${SUBMISSION_THUMBNAIL_MAX_DIMENSION}:force_original_aspect_ratio=decrease`,
        ])
        .on('end', () => resolve())
        .on('error', reject)
        .save(thumbnailTemp);
    });

    const optimizedKey = `submissions/${submissionId}/optimized.mp4`;
    const thumbnailKey = `submissions/${submissionId}/thumbnail.webp`;

    const [optimizedResult, thumbnailResult] = await Promise.all([
      uploadFromTemp(client, bucket, optimizedKey, optimizedTemp, 'video/mp4'),
      uploadFromTemp(client, bucket, thumbnailKey, thumbnailTemp, 'image/webp'),
    ]);

    cleanupTemp(originalTemp, optimizedTemp, thumbnailTemp);

    return {
      optimized: {
        storagePath: optimizedKey,
        mimeType: 'video/mp4',
        kind: 'video',
        fileSize: optimizedResult.fileSize,
        sha256: optimizedResult.sha256,
        width: targetWidth,
        height: targetHeight,
        durationMs,
        thumbnailData: `data:image/webp;base64,${(await import('fs')).promises.readFile(thumbnailTemp).then(b => b.toString('base64'))}`,
      },
      thumbnail: {
        storagePath: thumbnailKey,
        mimeType: 'image/webp',
        kind: 'image',
        fileSize: thumbnailResult.fileSize,
        sha256: thumbnailResult.sha256,
        width: Math.min(targetWidth, SUBMISSION_THUMBNAIL_MAX_DIMENSION),
        height: Math.min(targetHeight, SUBMISSION_THUMBNAIL_MAX_DIMENSION),
      },
    };
  } catch (error) {
    cleanupTemp(originalTemp, optimizedTemp, thumbnailTemp);
    throw error;
  }
}