import { NextRequest, NextResponse } from 'next/server';
import { AbortMultipartUploadCommand } from '@aws-sdk/client-s3';
import { errorResponse, requireAdmin } from '@/lib/server/http';
import { getS3Client, storageConfig } from '@/lib/server/storage';
import { loadUpload } from '@/lib/server/uploads';

export const runtime = 'nodejs';
type Context = { params: Promise<{ uploadId: string }> };
export async function POST(request: NextRequest, context: Context) {
  try {
    const { db, user } = await requireAdmin(request);
    const { uploadId } = await context.params;
    const upload = await loadUpload(db, user.id, uploadId);
    const config = storageConfig();
    await getS3Client().send(new AbortMultipartUploadCommand({ Bucket: config.bucket, Key: upload.storage_path, UploadId: upload.multipart_id }));
    await db.from('media_uploads').update({ status: 'aborted' }).eq('id', upload.id);
    return NextResponse.json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
