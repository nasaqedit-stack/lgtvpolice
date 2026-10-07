import { NextRequest, NextResponse } from 'next/server';
import { ListPartsCommand } from '@aws-sdk/client-s3';
import { errorResponse, requireAdmin } from '@/lib/server/http';
import { getS3Client, storageConfig } from '@/lib/server/storage';
import { loadUpload } from '@/lib/server/uploads';

export const runtime = 'nodejs';
type Context = { params: Promise<{ uploadId: string }> };
export async function GET(request: NextRequest, context: Context) {
  try {
    const { db, user } = await requireAdmin(request);
    const { uploadId } = await context.params;
    const upload = await loadUpload(db, user.id, uploadId);
    const config = storageConfig();
    const result = await getS3Client().send(new ListPartsCommand({
      Bucket: config.bucket, Key: upload.storage_path, UploadId: upload.multipart_id,
    }));
    return NextResponse.json({
      upload: { id: upload.id, fileName: upload.file_name, fileSize: Number(upload.file_size), mimeType: upload.mime_type, expiresAt: upload.expires_at },
      parts: (result.Parts ?? []).map(part => ({ partNumber: part.PartNumber, size: part.Size ?? 0 })),
      partSize: 8 * 1024 * 1024,
      totalParts: Math.ceil(Number(upload.file_size) / (8 * 1024 * 1024)),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}
