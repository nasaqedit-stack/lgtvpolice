import { NextRequest, NextResponse } from 'next/server';
import { CompleteMultipartUploadCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListPartsCommand } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { createSupabaseAdmin } from '@/lib/server/supabase';
import { HttpError, assertSameOrigin, errorResponse, readJson } from '@/lib/server/http';
import { getS3Client, storageConfig, storageRequestOptions } from '@/lib/server/storage';
import { MAX_UPLOAD_FILE_SIZE } from '@/lib/shared';
import { SUBMISSION_MAX_FILE_SIZE } from '@/lib/shared/submissions';
import { loadSubmissionLink, loadSubmissionUpload, markSubmissionFileStored } from '@/lib/server/submissions';
import { verifyUploadParts } from '@/lib/server/uploads';
import { signatureMatches, sameMediaType } from '@/lib/server/file-validation';
import { processSubmissionMedia } from '@/lib/server/media-optimization';

export const runtime = 'nodejs';
// Media optimization (image re-encode / video transcode) runs inline; allow a long deadline.
export const maxDuration = 300;
type Context = { params: Promise<{ token: string; uploadId: string }> };

const schema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().int().positive().max(20000).nullable().optional(),
  height: z.number().int().positive().max(20000).nullable().optional(),
  durationMs: z.number().int().positive().max(7 * 24 * 60 * 60 * 1000).nullable().optional(),
  /**
   * The byte length the browser read off each Blob it PUT, one entry per part. Validated
   * against the shared partition exactly like the admin upload pipeline.
   */
  parts: z.array(z.object({
    partNumber: z.number().int().positive().max(10_000),
    size: z.number().int().nonnegative().max(MAX_UPLOAD_FILE_SIZE),
  }).strict()).max(1024).optional(),
}).strict();

/**
 * Finalize a public submission upload: assemble the multipart upload, verify size and file
 * signature, record the original, move the submission DRAFT -> SUBMITTED and run media
 * optimization (PROCESSING -> READY_FOR_REVIEW, or processing=failed on error).
 *
 * The submission is never approved or public here: default visibility is OFF.
 */
export async function POST(request: NextRequest, context: Context) {
  let stage = 'validate_link';
  let assembledKey: string | undefined;
  let bucketName: string | undefined;
  try {
    assertSameOrigin(request);
    const { token, uploadId } = await context.params;
    const db = createSupabaseAdmin();
    const link = await loadSubmissionLink(db, token);
    stage = 'load_upload_session';
    const { upload, submission } = await loadSubmissionUpload(db, uploadId, link.id);
    stage = 'read_metadata';
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'بيانات الإكمال غير صالحة.', 'invalid_completion');
    if (Number(upload.file_size) > SUBMISSION_MAX_FILE_SIZE) {
      throw new HttpError(400, 'حجم الملف يتجاوز الحد المسموح به للمشاركات العامة.', 'file_too_large');
    }
    const config = storageConfig();
    bucketName = config.bucket;
    const client = getS3Client();
    const fileSize = Number(upload.file_size);
    stage = 'list_uploaded_parts';
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
    assembledKey = upload.storage_path;
    stage = 'verify_stored_object';
    const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: upload.storage_path }), storageRequestOptions());
    if (Number(head.ContentLength) !== fileSize || !sameMediaType(head.ContentType, upload.mime_type)) {
      throw new HttpError(422, 'الملف المخزن لا يطابق الحجم أو النوع المتوقع.', 'stored_file_mismatch');
    }
    stage = 'verify_file_signature';
    const firstBytes = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: upload.storage_path, Range: 'bytes=0-31' }), storageRequestOptions());
    const signature = firstBytes.Body ? await firstBytes.Body.transformToByteArray() : new Uint8Array();
    if (!signatureMatches(upload.mime_type, signature)) {
      throw new HttpError(422, 'محتوى الملف لا يطابق نوعه المعلن.', 'file_signature_invalid');
    }
    stage = 'mark_submitted';
    const submitted = await markSubmissionFileStored(db, submission, {
      storagePath: upload.storage_path,
      fileName: upload.file_name,
      fileSize,
      mimeType: upload.mime_type,
      sha256: parsed.data.sha256,
      width: parsed.data.width ?? null,
      height: parsed.data.height ?? null,
      durationMs: parsed.data.durationMs ?? null,
    });
    await db.from('submission_uploads').update({ status: 'completed' }).eq('id', upload.id);
    stage = 'process_media';
    const result = await processSubmissionMedia(db, submitted);
    return NextResponse.json({
      submission: result.submission,
      processing: result.ok ? 'completed' : 'failed',
      processingError: result.ok ? null : result.error,
    }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    // The assembled original is kept for review/retry unless it failed verification, in which
    // case it is removed and the submission stays in DRAFT.
    if (assembledKey && bucketName && error instanceof HttpError && error.status === 422) {
      await getS3Client().send(new DeleteObjectCommand({ Bucket: bucketName, Key: assembledKey }), storageRequestOptions(5_000)).catch(() => undefined);
      await createSupabaseAdmin().from('submission_uploads').update({ status: 'aborted' }).eq('id', (await context.params).uploadId);
    }
    return errorResponse(error, { route: 'POST /api/submit/[token]/uploads/[uploadId]/complete', stage });
  }
}
