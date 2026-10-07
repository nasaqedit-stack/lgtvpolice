import { NextRequest, NextResponse } from 'next/server';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { errorResponse, HttpError, requireAdmin } from '@/lib/server/http';
import { getS3Client, storageConfig } from '@/lib/server/storage';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export async function GET(request: NextRequest, context: Context) {
  try {
    const { db } = await requireAdmin(request);
    const { id } = await context.params;
    const { data: media, error } = await db.from('media').select('storage_path').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!media) throw new HttpError(404, 'الوسيط غير موجود.', 'not_found');
    const config = storageConfig();
    const url = await getSignedUrl(getS3Client(), new GetObjectCommand({ Bucket: config.bucket, Key: media.storage_path }), { expiresIn: 5 * 60 });
    return NextResponse.json({ url }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}
