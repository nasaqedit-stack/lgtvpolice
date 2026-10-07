import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { CreateMultipartUploadCommand, AbortMultipartUploadCommand } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { errorResponse, HttpError, requireAdmin, readJson } from '@/lib/server/http';
import { getS3Client, storageConfig } from '@/lib/server/storage';

export const runtime = 'nodejs';
export const maxDuration = 60;
const maxFileSize = 2 * 1024 * 1024 * 1024;
const mimeMap = { 'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image', 'video/mp4': 'video' } as const;
const schema = z.object({
  fileName: z.string().trim().min(1).max(240),
  fileSize: z.number().int().positive().max(maxFileSize),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'video/mp4']),
}).strict();

export async function POST(request: NextRequest) {
  try {
    const { db, user } = await requireAdmin(request);
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'صيغة الملف أو حجمه غير مدعوم. الحد الأعلى 2 جيجابايت.', 'invalid_media');
    const config = storageConfig();
    const client = getS3Client();
    const id = randomUUID();
    const key = `media/${id}`;
    const create = await client.send(new CreateMultipartUploadCommand({
      Bucket: config.bucket,
      Key: key,
      ContentType: parsed.data.mimeType,
      CacheControl: 'private, max-age=3600',
      Metadata: { 'upload-reference': id },
    }));
    if (!create.UploadId) throw new Error('Object storage did not return a multipart upload id.');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const { data: upload, error } = await db.from('media_uploads').insert({
      id, user_id: user.id, storage_path: key, multipart_id: create.UploadId,
      file_name: parsed.data.fileName, file_size: parsed.data.fileSize,
      mime_type: parsed.data.mimeType, expires_at: expiresAt,
    }).select('id').single();
    if (error) {
      await client.send(new AbortMultipartUploadCommand({ Bucket: config.bucket, Key: key, UploadId: create.UploadId })).catch(() => undefined);
      throw error;
    }
    return NextResponse.json({
      uploadId: upload.id,
      partSize: 8 * 1024 * 1024,
      totalParts: Math.ceil(parsed.data.fileSize / (8 * 1024 * 1024)),
      expiresAt,
      kind: mimeMap[parsed.data.mimeType],
    }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}
