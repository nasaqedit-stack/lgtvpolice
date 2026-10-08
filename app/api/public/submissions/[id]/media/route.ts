import { NextRequest, NextResponse } from 'next/server';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { createSupabaseAdmin } from '@/lib/server/supabase';
import { HttpError, errorResponse } from '@/lib/server/http';
import { getS3Client, storageConfig, storageRequestOptions } from '@/lib/server/storage';
import { isPublicState } from '@/lib/shared/submissions';
import { IMMUTABLE_CACHE_CONTROL } from '@/lib/server/media-optimization';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
type Context = { params: Promise<{ id: string }> };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Public delivery of a PUBLISHED submission's OPTIMIZED media (or its thumbnail via
 * `?variant=thumbnail`). Only state PUBLISHED is served — unapproved, rejected and merely
 * approved submissions all return 404, so the player/browser never downloads an original file.
 *
 * Delivery is optimized for the TV/player: versioned, immutable object keys are served with an
 * immutable long-lived cache policy, correct content type, and HTTP Range support for video
 * seeking. Bytes are read server-side from the private bucket with service credentials.
 */
export async function GET(request: NextRequest, context: Context) {
  try {
    const { id } = await context.params;
    if (!uuid.test(id)) throw new HttpError(400, 'معرّف غير صالح.', 'invalid_id');
    const variant = request.nextUrl.searchParams.get('variant') === 'thumbnail' ? 'thumbnail' : 'optimized';
    const db = createSupabaseAdmin();
    const { data: submission, error } = await db.from('submissions')
      .select('id,state,kind,version,title,optimized_storage_path,optimized_mime_type,optimized_file_size,thumbnail_storage_path,thumbnail_mime_type,thumbnail_file_size')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!submission || !isPublicState(submission.state)) {
      throw new HttpError(404, 'المحتوى غير متاح.', 'not_found');
    }
    const key = variant === 'thumbnail' ? submission.thumbnail_storage_path : submission.optimized_storage_path;
    const mimeType = variant === 'thumbnail' ? submission.thumbnail_mime_type : submission.optimized_mime_type;
    const size = Number(variant === 'thumbnail' ? submission.thumbnail_file_size : submission.optimized_file_size);
    if (!key || !mimeType || !Number.isFinite(size) || size <= 0) {
      throw new HttpError(404, 'النسخة المعالجة غير متاحة.', 'not_found');
    }
    const command: { Bucket: string; Key: string; Range?: string } = { Bucket: storageConfig().bucket, Key: key };
    let start: number | null = null;
    let end: number | null = null;
    const requested = request.headers.get('range');
    if (requested) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(requested.trim());
      if (match) {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : size - 1;
        if (start >= size || start > end) {
          return new NextResponse(null, { status: 416, headers: { 'Content-Range': `bytes */${size}`, 'Cache-Control': 'no-store' } });
        }
        end = Math.min(end, size - 1);
        command.Range = `bytes=${start}-${end}`;
      }
    }
    const object = await getS3Client().send(new GetObjectCommand(command), storageRequestOptions(60_000));
    const body = object.Body ? Buffer.from(await object.Body.transformToByteArray()) : Buffer.alloc(0);
    const extension = mimeType.split('/')[1]?.replace('quicktime', 'mov') ?? 'bin';
    const headers: Record<string, string> = {
      'Content-Type': mimeType,
      // Versioned, content-addressed URL: safe to cache immutably at every layer.
      'Cache-Control': IMMUTABLE_CACHE_CONTROL,
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename="submission-${submission.id}-v${submission.version}.${extension}"`,
    };
    if (start !== null && end !== null) {
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      return new NextResponse(body, { status: 206, headers });
    }
    return new NextResponse(body, { status: 200, headers });
  } catch (error) { return errorResponse(error, { route: 'GET /api/public/submissions/[id]/media' }); }
}
