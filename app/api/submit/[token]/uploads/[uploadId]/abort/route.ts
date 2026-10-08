import { NextRequest, NextResponse } from 'next/server';
import { AbortMultipartUploadCommand } from '@aws-sdk/client-s3';
import { createSupabaseAdmin } from '@/lib/server/supabase';
import { assertSameOrigin, errorResponse } from '@/lib/server/http';
import { getS3Client, storageConfig, storageRequestOptions } from '@/lib/server/storage';
import { loadSubmissionLink, loadSubmissionUpload } from '@/lib/server/submissions';

export const runtime = 'nodejs';
export const maxDuration = 60;
type Context = { params: Promise<{ token: string; uploadId: string }> };

/** Abort an in-progress public upload (contributor cancelled). The submission stays in DRAFT. */
export async function POST(request: NextRequest, context: Context) {
  let stage = 'validate_link';
  try {
    assertSameOrigin(request);
    const { token, uploadId } = await context.params;
    const db = createSupabaseAdmin();
    const link = await loadSubmissionLink(db, token);
    stage = 'load_upload_session';
    const { upload } = await loadSubmissionUpload(db, uploadId, link.id);
    stage = 'abort_storage_multipart';
    const config = storageConfig();
    await getS3Client().send(new AbortMultipartUploadCommand({
      Bucket: config.bucket, Key: upload.storage_path, UploadId: upload.multipart_id,
    }), storageRequestOptions(5_000)).catch(() => undefined);
    await db.from('submission_uploads').update({ status: 'aborted' }).eq('id', upload.id);
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error, { route: 'POST /api/submit/[token]/uploads/[uploadId]/abort', stage }); }
}
