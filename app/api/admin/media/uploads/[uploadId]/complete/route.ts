import { NextRequest, NextResponse } from 'next/server';
import { CompleteMultipartUploadCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListPartsCommand } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { errorResponse, HttpError, readJson, requireAdmin } from '@/lib/server/http';
import { getS3Client, storageConfig } from '@/lib/server/storage';
import { loadUpload } from '@/lib/server/uploads';

export const runtime = 'nodejs';
export const maxDuration = 60;
type Context = { params: Promise<{ uploadId: string }> };
const schema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().int().positive().max(20000).nullable().optional(),
  height: z.number().int().positive().max(20000).nullable().optional(),
  durationMs: z.number().int().positive().max(7 * 24 * 60 * 60 * 1000).nullable().optional(),
  thumbnailData: z.string().max(400000).regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/).nullable().optional(),
  compatibility: z.enum(['unknown', 'candidate', 'warning']).default('unknown'),
}).strict();

function signatureMatches(mime: string, bytes: Uint8Array) {
  if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/png') return bytes[0] === 0x89 && String.fromCharCode(...bytes.slice(1, 4)) === 'PNG';
  if (mime === 'image/webp') return String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  if (mime === 'video/mp4') return String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp';
  return false;
}

export async function POST(request: NextRequest, context: Context) {
  let uploadedKey: string | undefined;
  let bucketName: string | undefined;
  try {
    const { db, user } = await requireAdmin(request);
    const { uploadId } = await context.params;
    const upload = await loadUpload(db, user.id, uploadId);
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'بيانات الوسيط أو بصمته غير صالحة.', 'invalid_media_metadata');
    const config = storageConfig();
    bucketName = config.bucket;
    const client = getS3Client();
    const partSize = 8 * 1024 * 1024;
    const totalParts = Math.ceil(Number(upload.file_size) / partSize);
    const listed = await client.send(new ListPartsCommand({ Bucket: config.bucket, Key: upload.storage_path, UploadId: upload.multipart_id }));
    const parts = (listed.Parts ?? []).sort((a, b) => (a.PartNumber ?? 0) - (b.PartNumber ?? 0));
    if (parts.length !== totalParts || parts.some((part, index) => part.PartNumber !== index + 1 || !part.ETag)) {
      throw new HttpError(409, 'لم تكتمل كل أجزاء الملف. أعد محاولة الأجزاء الناقصة.', 'upload_incomplete');
    }
    for (let index = 0; index < parts.length; index += 1) {
      const expected = Math.min(partSize, Number(upload.file_size) - index * partSize);
      if (Number(parts[index].Size) !== expected) throw new HttpError(409, 'حجم أحد أجزاء الرفع غير صحيح.', 'upload_part_size_invalid');
    }
    await client.send(new CompleteMultipartUploadCommand({
      Bucket: config.bucket,
      Key: upload.storage_path,
      UploadId: upload.multipart_id,
      MultipartUpload: { Parts: parts.map(part => ({ PartNumber: part.PartNumber, ETag: part.ETag })) },
    }));
    uploadedKey = upload.storage_path;
    const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: upload.storage_path }));
    if (Number(head.ContentLength) !== Number(upload.file_size) || head.ContentType !== upload.mime_type) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: upload.storage_path }));
      await db.from('media_uploads').update({ status: 'aborted' }).eq('id', upload.id);
      throw new HttpError(422, 'الملف المخزن لا يطابق الحجم أو النوع المتوقع.', 'stored_file_mismatch');
    }
    const firstBytes = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: upload.storage_path, Range: 'bytes=0-31' }));
    const signature = firstBytes.Body ? await firstBytes.Body.transformToByteArray() : new Uint8Array();
    if (!signatureMatches(upload.mime_type, signature)) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: upload.storage_path }));
      await db.from('media_uploads').update({ status: 'aborted' }).eq('id', upload.id);
      throw new HttpError(422, 'محتوى الملف لا يطابق نوعه المعلن. لم تتم إضافته إلى المكتبة.', 'file_signature_invalid');
    }
    const { data: duplicate, error: duplicateError } = await db.from('media').select('id,display_name,sha256,file_size,mime_type,kind').eq('sha256', parsed.data.sha256).maybeSingle();
    if (duplicateError) throw duplicateError;
    if (duplicate) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: upload.storage_path }));
      await db.from('media_uploads').update({ status: 'completed', completed_media_id: duplicate.id }).eq('id', upload.id);
      return NextResponse.json({ media: duplicate, duplicate: true });
    }
    const kind = upload.mime_type.startsWith('video/') ? 'video' : 'image';
    const { data: media, error: insertError } = await db.from('media').insert({
      storage_path: upload.storage_path,
      display_name: upload.file_name,
      mime_type: upload.mime_type,
      kind,
      file_size: upload.file_size,
      sha256: parsed.data.sha256,
      width: parsed.data.width ?? null,
      height: parsed.data.height ?? null,
      duration_ms: parsed.data.durationMs ?? null,
      thumbnail_data: parsed.data.thumbnailData ?? null,
      compatibility: parsed.data.compatibility,
      metadata: { uploadProtocol: 's3-multipart', verifiedContainerSignature: true },
      uploaded_by: user.id,
    }).select('*').single();
    if (insertError) {
      if (insertError.code === '23505') {
        const { data: raced } = await db.from('media').select('id,display_name,sha256,file_size,mime_type,kind').eq('sha256', parsed.data.sha256).maybeSingle();
        if (raced) {
          await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: upload.storage_path }));
          await db.from('media_uploads').update({ status: 'completed', completed_media_id: raced.id }).eq('id', upload.id);
          return NextResponse.json({ media: raced, duplicate: true });
        }
      }
      throw insertError;
    }
    await db.from('media_uploads').update({ status: 'completed', completed_media_id: media.id }).eq('id', upload.id);
    return NextResponse.json({ media, duplicate: false }, { status: 201 });
  } catch (error) {
    if (uploadedKey && bucketName) {
      await getS3Client().send(new DeleteObjectCommand({ Bucket: bucketName, Key: uploadedKey })).catch(() => undefined);
    }
    return errorResponse(error);
  }
}
