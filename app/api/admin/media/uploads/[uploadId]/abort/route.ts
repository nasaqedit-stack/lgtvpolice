import { NextRequest, NextResponse } from 'next/server';
import { AbortMultipartUploadCommand } from '@aws-sdk/client-s3';
import { errorResponse, requireAdmin } from '@/lib/server/http';
import { getS3Client, storageConfig, storageRequestOptions } from '@/lib/server/storage';
import { loadUpload } from '@/lib/server/uploads';

export const runtime = 'nodejs';
export const maxDuration = 60;
type Context = { params: Promise<{ uploadId: string }> };
export async function POST(request: NextRequest, context: Context) {
  let stage = 'admin_auth';
  try {
    const { db, user } = await requireAdmin(request);
    stage = 'load_upload_session';
    const { uploadId } = await context.params;
    const upload = await loadUpload(db, user.id, uploadId);
    const config = storageConfig();
    stage = 'abort_storage_multipart';
    await getS3Client().send(new AbortMultipartUploadCommand({ Bucket: config.bucket, Key: upload.storage_path, UploadId: upload.multipart_id }), storageRequestOptions());
    stage = 'mark_upload_aborted';
    await db.from('media_uploads').update({ status: 'aborted' }).eq('id', upload.id);
    return NextResponse.json({ ok: true });
  } catch (error) { return errorResponse(error, { route: 'POST /api/admin/media/uploads/[uploadId]/abort', stage }); }
}
