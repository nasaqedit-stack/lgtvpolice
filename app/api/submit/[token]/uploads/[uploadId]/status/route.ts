import { NextRequest, NextResponse } from 'next/server';
import { ListPartsCommand } from '@aws-sdk/client-s3';
import { createSupabaseAdmin } from '@/lib/server/supabase';
import { errorResponse } from '@/lib/server/http';
import { getS3Client, storageConfig, storageRequestOptions } from '@/lib/server/storage';
import { UPLOAD_PART_SIZE, uploadPartCount } from '@/lib/shared';
import { loadSubmissionLink, loadSubmissionUpload } from '@/lib/server/submissions';
import { resumePartSize } from '@/lib/server/uploads';

export const runtime = 'nodejs';
export const maxDuration = 60;
type Context = { params: Promise<{ token: string; uploadId: string }> };

/** Resume info for an in-progress public upload (which parts already landed in storage). */
export async function GET(request: NextRequest, context: Context) {
  let stage = 'validate_link';
  try {
    const { token, uploadId } = await context.params;
    const db = createSupabaseAdmin();
    const link = await loadSubmissionLink(db, token);
    stage = 'load_upload_session';
    const { upload } = await loadSubmissionUpload(db, uploadId, link.id);
    const config = storageConfig();
    stage = 'list_uploaded_parts';
    const result = await getS3Client().send(new ListPartsCommand({
      Bucket: config.bucket, Key: upload.storage_path, UploadId: upload.multipart_id,
    }), storageRequestOptions());
    const fileSize = Number(upload.file_size);
    return NextResponse.json({
      upload: { id: upload.id, fileName: upload.file_name, fileSize, mimeType: upload.mime_type, expiresAt: upload.expires_at },
      parts: (result.Parts ?? []).map(part => ({
        partNumber: Number(part.PartNumber),
        size: resumePartSize(fileSize, Number(part.PartNumber), typeof part.Size === 'number' ? part.Size : null),
      })),
      partSize: UPLOAD_PART_SIZE,
      totalParts: uploadPartCount(fileSize),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error, { route: 'GET /api/submit/[token]/uploads/[uploadId]/status', stage }); }
}
