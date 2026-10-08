import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { CreateMultipartUploadCommand, AbortMultipartUploadCommand } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { errorResponse, HttpError, requireAdmin, readJson } from '@/lib/server/http';
import { getS3Client, storageConfig, storageRequestOptions } from '@/lib/server/storage';
import { MAX_UPLOAD_FILE_SIZE, UPLOAD_PART_SIZE, uploadPartCount } from '@/lib/shared';

export const runtime = 'nodejs';
export const maxDuration = 60;
const maxFileSize = MAX_UPLOAD_FILE_SIZE;
const mimeMap = { 'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image', 'video/mp4': 'video' } as const;
const schema = z.object({
  fileName: z.string().trim().min(1).max(240),
  fileSize: z.number().int().positive().max(maxFileSize),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'video/mp4']),
}).strict();

export async function POST(request: NextRequest) {
  let stage = 'admin_auth';
  try {
    const { db, user } = await requireAdmin(request);
    stage = 'read_metadata';
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'صيغة الملف أو حجمه غير مدعوم. الحد الأعلى 2 جيجابايت.', 'invalid_media');
    const config = storageConfig();
    const client = getS3Client();
    const id = randomUUID();
    const key = `media/${id}`;
    stage = 'create_storage_multipart';
    const create = await client.send(new CreateMultipartUploadCommand({
      Bucket: config.bucket,
      Key: key,
      ContentType: parsed.data.mimeType,
      CacheControl: 'private, max-age=3600',
      Metadata: { 'upload-reference': id },
    }), storageRequestOptions());
    if (!create.UploadId) throw new Error('Object storage did not return a multipart upload id.');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    stage = 'insert_upload_session';
    const { data: upload, error } = await db.from('media_uploads').insert({
      id, user_id: user.id, storage_path: key, multipart_id: create.UploadId,
      file_name: parsed.data.fileName, file_size: parsed.data.fileSize,
      mime_type: parsed.data.mimeType, expires_at: expiresAt,
    }).select('id').single();
    if (error) {
      await client.send(new AbortMultipartUploadCommand({ Bucket: config.bucket, Key: key, UploadId: create.UploadId }), storageRequestOptions(5_000)).catch(() => undefined);
      throw error;
    }
    return NextResponse.json({
      uploadId: upload.id,
      partSize: UPLOAD_PART_SIZE,
      totalParts: uploadPartCount(parsed.data.fileSize),
      expiresAt,
      kind: mimeMap[parsed.data.mimeType],
    }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error, { route: 'POST /api/admin/media/uploads', stage }); }
}
