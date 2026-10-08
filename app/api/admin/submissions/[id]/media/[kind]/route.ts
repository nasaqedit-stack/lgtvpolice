import { NextRequest, NextResponse } from 'next/server';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { errorResponse, HttpError, requireAdmin } from '@/lib/server/http';
import { getS3Client, storageConfig } from '@/lib/server/storage';
import { loadSubmission } from '@/lib/server/submissions';
import { sanitizeFileName } from '@/lib/server/file-validation';

export const runtime = 'nodejs';
export const maxDuration = 60;
type Context = { params: Promise<{ id: string; kind: string }> };

const KINDS = ['original', 'optimized', 'thumbnail'] as const;
type MediaKind = (typeof KINDS)[number];

/**
 * Short-lived presigned URL for administrator review: the untouched ORIGINAL contributor file,
 * the OPTIMIZED delivery version, or the THUMBNAIL. Admin/operator session required; the bucket
 * stays private and no storage credential is exposed.
 */
export async function GET(request: NextRequest, context: Context) {
  try {
    const { db } = await requireAdmin(request);
    const { id, kind } = await context.params;
    if (!KINDS.includes(kind as MediaKind)) throw new HttpError(400, 'نوع الوسائط غير صالح.', 'invalid_kind');
    const submission = await loadSubmission(db, id);
    const key = kind === 'original'
      ? submission.original_storage_path
      : kind === 'optimized'
        ? submission.optimized_storage_path
        : submission.thumbnail_storage_path;
    if (!key) throw new HttpError(404, kind === 'original' ? 'الملف الأصلي غير موجود.' : 'النسخة المعالجة غير موجودة بعد.', 'media_not_ready');
    const mimeType = kind === 'original'
      ? submission.mime_type
      : kind === 'optimized'
        ? submission.optimized_mime_type
        : submission.thumbnail_mime_type ?? 'image/webp';
    const extension = kind === 'original' ? submission.mime_type?.split('/')[1]?.replace('quicktime', 'mov') ?? 'bin' : mimeType?.split('/')[1] ?? 'bin';
    const safeName = `${sanitizeFileName(submission.title)}-${kind}.${extension}`;
    const url = await getSignedUrl(getS3Client(), new GetObjectCommand({
      Bucket: storageConfig().bucket,
      Key: key,
      ResponseContentType: mimeType ?? 'application/octet-stream',
      ResponseContentDisposition: `inline; filename="${safeName.replace(/["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    }), { expiresIn: 5 * 60 });
    return NextResponse.json({ url, kind, mimeType }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error, { route: 'GET /api/admin/submissions/[id]/media/[kind]' }); }
}
