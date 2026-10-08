import { NextRequest, NextResponse } from 'next/server';
import { CompleteMultipartUploadCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListPartsCommand } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { errorResponse, HttpError, readJson, requireAdmin } from '@/lib/server/http';
import { getS3Client, storageConfig, storageRequestOptions } from '@/lib/server/storage';
import { loadUpload, verifyUploadParts } from '@/lib/server/uploads';
import { inspectQuickTimeObject } from '@/lib/server/quicktime';
import { isQuickTimeMovCompatible, type QuickTimeCodecInfo } from '@/lib/shared/quicktime';
import { MAX_UPLOAD_FILE_SIZE } from '@/lib/shared';

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
  /**
   * The byte length the browser read off each Blob it PUT, one entry per part.
   * Optional only so an admin tab that was already open before this deploy keeps
   * working; a current client always sends it and is validated part by part.
   */
  parts: z.array(z.object({
    partNumber: z.number().int().positive().max(10_000),
    size: z.number().int().nonnegative().max(MAX_UPLOAD_FILE_SIZE),
  }).strict()).max(1024).optional(),
}).strict();

function signatureMatches(mime: string, bytes: Uint8Array) {
  if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/png') return bytes[0] === 0x89 && String.fromCharCode(...bytes.slice(1, 4)) === 'PNG';
  if (mime === 'image/webp') return String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  if (mime === 'video/mp4' || mime === 'video/quicktime') return String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp';
  return false;
}

/** Compare media types only: a store may echo parameters (`image/png; charset=binary`) it was never given. */
function sameMediaType(left: string | undefined, right: string | undefined) {
  const trim = (value: string | undefined) => String(value ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return trim(left) === trim(right) && trim(left) !== '';
}

export async function POST(request: NextRequest, context: Context) {
  let uploadedKey: string | undefined;
  let bucketName: string | undefined;
  let quickTimeCodecs: QuickTimeCodecInfo | null = null;
  let stage = 'admin_auth';
  try {
    const { db, user } = await requireAdmin(request);
    stage = 'load_upload_session';
    const { uploadId } = await context.params;
    const upload = await loadUpload(db, user.id, uploadId);
    stage = 'read_metadata';
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'بيانات الوسيط أو بصمته غير صالحة.', 'invalid_media_metadata');
    if (upload.mime_type === 'video/quicktime' && parsed.data.compatibility !== 'candidate') {
      throw new HttpError(422, 'لا يقبل النظام MOV قبل تأكيد توافق H.264/AAC من فحص الوسيط.', 'quicktime_compatibility_unverified');
    }
    const config = storageConfig();
    bucketName = config.bucket;
    const client = getS3Client();
    const fileSize = Number(upload.file_size);
    stage = 'list_uploaded_parts';
    // The 2 GiB file cap means at most 256 parts, well inside ListParts' 1000-part page.
    const listed = await client.send(new ListPartsCommand({ Bucket: config.bucket, Key: upload.storage_path, UploadId: upload.multipart_id }), storageRequestOptions());
    stage = 'verify_part_sizes';
    const parts = verifyUploadParts(fileSize, listed.Parts ?? [], parsed.data.parts);
    stage = 'complete_storage_multipart';
    await client.send(new CompleteMultipartUploadCommand({
      Bucket: config.bucket,
      Key: upload.storage_path,
      UploadId: upload.multipart_id,
      MultipartUpload: { Parts: parts.map(part => ({ PartNumber: part.PartNumber, ETag: part.ETag })) },
    }), storageRequestOptions());
    uploadedKey = upload.storage_path;
    stage = 'verify_stored_object';
    // The authoritative byte count: whatever the parts really contained is what the store
    // assembled, so this is the size validation that cannot be fooled by a client manifest.
    const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: upload.storage_path }), storageRequestOptions());
    if (Number(head.ContentLength) !== fileSize || !sameMediaType(head.ContentType, upload.mime_type)) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: upload.storage_path }), storageRequestOptions());
      await db.from('media_uploads').update({ status: 'aborted' }).eq('id', upload.id);
      throw new HttpError(422, 'الملف المخزن لا يطابق الحجم أو النوع المتوقع.', 'stored_file_mismatch');
    }
    stage = 'verify_file_signature';
    const firstBytes = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: upload.storage_path, Range: 'bytes=0-31' }), storageRequestOptions());
    const signature = firstBytes.Body ? await firstBytes.Body.transformToByteArray() : new Uint8Array();
    if (!signatureMatches(upload.mime_type, signature)) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: upload.storage_path }), storageRequestOptions());
      await db.from('media_uploads').update({ status: 'aborted' }).eq('id', upload.id);
      throw new HttpError(422, 'محتوى الملف لا يطابق نوعه المعلن. لم تتم إضافته إلى المكتبة.', 'file_signature_invalid');
    }
    if (upload.mime_type === 'video/quicktime') {
      stage = 'verify_quicktime_codecs';
      quickTimeCodecs = await inspectQuickTimeObject(client, config.bucket, upload.storage_path, fileSize);
      if (!isQuickTimeMovCompatible(quickTimeCodecs)) {
        await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: upload.storage_path }), storageRequestOptions());
        await db.from('media_uploads').update({ status: 'aborted' }).eq('id', upload.id);
        throw new HttpError(422, 'رُفض ملف MOV: تعذّر تأكيد مسار فيديو H.264 وصوت AAC مدعوم. حوّله إلى MP4/H.264/AAC.', 'quicktime_codec_unsupported');
      }
    }
    stage = 'check_media_duplicate';
    const { data: duplicate, error: duplicateError } = await db.from('media').select('id,display_name,sha256,file_size,mime_type,kind').eq('sha256', parsed.data.sha256).maybeSingle();
    if (duplicateError) throw duplicateError;
    if (duplicate) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: upload.storage_path }), storageRequestOptions());
      await db.from('media_uploads').update({ status: 'completed', completed_media_id: duplicate.id }).eq('id', upload.id);
      return NextResponse.json({ media: duplicate, duplicate: true });
    }
    const kind = upload.mime_type.startsWith('video/') ? 'video' : 'image';
    stage = 'insert_media_record';
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
      metadata: {
        uploadProtocol: 's3-multipart',
        verifiedContainerSignature: true,
        ...(quickTimeCodecs ? { verifiedQuickTimeCodecs: quickTimeCodecs } : {}),
      },
      uploaded_by: user.id,
    }).select('*').single();
    if (insertError) {
      if (insertError.code === '23505') {
        const { data: raced } = await db.from('media').select('id,display_name,sha256,file_size,mime_type,kind').eq('sha256', parsed.data.sha256).maybeSingle();
        if (raced) {
          await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: upload.storage_path }), storageRequestOptions());
          await db.from('media_uploads').update({ status: 'completed', completed_media_id: raced.id }).eq('id', upload.id);
          return NextResponse.json({ media: raced, duplicate: true });
        }
      }
      throw insertError;
    }
    stage = 'mark_upload_completed';
    const { error: completionError } = await db.from('media_uploads').update({ status: 'completed', completed_media_id: media.id }).eq('id', upload.id);
    if (completionError) console.error('Media upload completion marker failed:', { route: 'POST /api/admin/media/uploads/[uploadId]/complete', code: completionError.code ?? 'database_error' });
    return NextResponse.json({ media, duplicate: false }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (uploadedKey && bucketName) {
      await getS3Client().send(new DeleteObjectCommand({ Bucket: bucketName, Key: uploadedKey }), storageRequestOptions(5_000)).catch(() => undefined);
    }
    return errorResponse(error, { route: 'POST /api/admin/media/uploads/[uploadId]/complete', stage });
  }
}
