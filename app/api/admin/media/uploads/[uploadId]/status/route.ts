import { NextRequest, NextResponse } from 'next/server';
import { ListPartsCommand } from '@aws-sdk/client-s3';
import { errorResponse, requireAdmin } from '@/lib/server/http';
import { getS3Client, storageConfig, storageRequestOptions } from '@/lib/server/storage';
import { loadUpload, resumePartSize } from '@/lib/server/uploads';
import { UPLOAD_PART_SIZE, uploadPartCount } from '@/lib/shared';

export const runtime = 'nodejs';
export const maxDuration = 60;
type Context = { params: Promise<{ uploadId: string }> };
export async function GET(request: NextRequest, context: Context) {
  let stage = 'admin_auth';
  try {
    const { db, user } = await requireAdmin(request);
    stage = 'load_upload_session';
    const { uploadId } = await context.params;
    const upload = await loadUpload(db, user.id, uploadId);
    const config = storageConfig();
    stage = 'list_uploaded_parts';
    const result = await getS3Client().send(new ListPartsCommand({
      Bucket: config.bucket, Key: upload.storage_path, UploadId: upload.multipart_id,
    }), storageRequestOptions());
    const fileSize = Number(upload.file_size);
    const totalParts = uploadPartCount(fileSize);
    return NextResponse.json({
      upload: { id: upload.id, fileName: upload.file_name, fileSize, mimeType: upload.mime_type, expiresAt: upload.expires_at },
      // Supabase Storage's S3 ListParts never reports a per-part byte length (`Size` arrives
      // undefined), which used to make every resumed session start its progress from zero.
      // Fall back to the shared partition, so the size shown for a part that already landed is
      // the size that part must have; the assembled object is re-measured with HeadObject.
      parts: (result.Parts ?? []).map(part => ({
        partNumber: Number(part.PartNumber),
        size: resumePartSize(fileSize, Number(part.PartNumber), typeof part.Size === 'number' ? part.Size : null),
      })),
      partSize: UPLOAD_PART_SIZE,
      totalParts,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error, { route: 'GET /api/admin/media/uploads/[uploadId]/status', stage }); }
}
