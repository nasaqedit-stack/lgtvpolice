import { NextRequest, NextResponse } from 'next/server';
import { UploadPartCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { z } from 'zod';
import { createSupabaseAdmin } from '@/lib/server/supabase';
import { HttpError, assertSameOrigin, errorResponse, readJson } from '@/lib/server/http';
import { getS3Client, storageConfig } from '@/lib/server/storage';
import { UPLOAD_PART_SIZE, uploadPartCount } from '@/lib/shared';
import { loadSubmissionLink, loadSubmissionUpload } from '@/lib/server/submissions';

export const runtime = 'nodejs';
export const maxDuration = 60;
type Context = { params: Promise<{ token: string; uploadId: string }> };
const schema = z.object({ partNumbers: z.array(z.number().int().positive()).min(1).max(20) }).strict();

/** Presign multipart parts for a public submission upload. Link token + upload ownership checked. */
export async function POST(request: NextRequest, context: Context) {
  let stage = 'validate_link';
  try {
    assertSameOrigin(request);
    const { token, uploadId } = await context.params;
    const db = createSupabaseAdmin();
    const link = await loadSubmissionLink(db, token);
    stage = 'load_upload_session';
    const { upload } = await loadSubmissionUpload(db, uploadId, link.id);
    stage = 'validate_part_request';
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'أرقام أجزاء الرفع غير صالحة.', 'invalid_parts');
    const totalParts = uploadPartCount(Number(upload.file_size));
    const numbers = [...new Set(parsed.data.partNumbers)];
    if (numbers.some(number => number > totalParts)) throw new HttpError(400, 'رقم الجزء يتجاوز حجم الملف.', 'invalid_parts');
    stage = 'sign_storage_parts';
    const config = storageConfig();
    const client = getS3Client();
    const urls: Record<number, string> = {};
    for (const partNumber of numbers) {
      urls[partNumber] = await getSignedUrl(client, new UploadPartCommand({
        Bucket: config.bucket, Key: upload.storage_path, UploadId: upload.multipart_id, PartNumber: partNumber,
      }), { expiresIn: 15 * 60 });
    }
    return NextResponse.json({ urls, partSize: UPLOAD_PART_SIZE, totalParts, expiresIn: 900 }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error, { route: 'POST /api/submit/[token]/uploads/[uploadId]/parts', stage }); }
}
