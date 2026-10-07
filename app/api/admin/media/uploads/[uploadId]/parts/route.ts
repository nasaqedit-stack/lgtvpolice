import { NextRequest, NextResponse } from 'next/server';
import { UploadPartCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { z } from 'zod';
import { errorResponse, HttpError, readJson, requireAdmin } from '@/lib/server/http';
import { getS3Client, storageConfig } from '@/lib/server/storage';
import { loadUpload } from '@/lib/server/uploads';

export const runtime = 'nodejs';
type Context = { params: Promise<{ uploadId: string }> };
const schema = z.object({ partNumbers: z.array(z.number().int().positive()).min(1).max(20) }).strict();

export async function POST(request: NextRequest, context: Context) {
  try {
    const { db, user } = await requireAdmin(request);
    const { uploadId } = await context.params;
    const upload = await loadUpload(db, user.id, uploadId);
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'أرقام أجزاء الرفع غير صالحة.', 'invalid_parts');
    const partSize = 8 * 1024 * 1024;
    const totalParts = Math.ceil(Number(upload.file_size) / partSize);
    const numbers = [...new Set(parsed.data.partNumbers)];
    if (numbers.some(number => number > totalParts)) throw new HttpError(400, 'رقم الجزء يتجاوز حجم الملف.', 'invalid_parts');
    const config = storageConfig();
    const client = getS3Client();
    const urls: Record<number, string> = {};
    for (const partNumber of numbers) {
      urls[partNumber] = await getSignedUrl(client, new UploadPartCommand({
        Bucket: config.bucket, Key: upload.storage_path, UploadId: upload.multipart_id, PartNumber: partNumber,
      }), { expiresIn: 15 * 60 });
    }
    return NextResponse.json({ urls, partSize, totalParts, expiresIn: 900 }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}
