import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { AbortMultipartUploadCommand, CreateMultipartUploadCommand } from '@aws-sdk/client-s3';
import { createSupabaseAdmin } from '@/lib/server/supabase';
import { HttpError, assertSameOrigin, errorResponse, readJson } from '@/lib/server/http';
import { getS3Client, storageConfig, storageRequestOptions } from '@/lib/server/storage';
import { UPLOAD_PART_SIZE, uploadPartCount } from '@/lib/shared';
import { SUBMISSION_MIME_KIND } from '@/lib/shared/submissions';
import {
  clientIp,
  consumeSubmissionRateLimit,
  createSubmission,
  createSubmissionSchema,
  hashSubmissionIp,
  isConsentIssue,
  loadSubmissionLink,
} from '@/lib/server/submissions';
import { hashSubmissionToken } from '@/lib/server/submission-links';
import { originalObjectKey } from '@/lib/server/media-optimization';
import { validateSubmissionFileMeta } from '@/lib/server/file-validation';

export const runtime = 'nodejs';
export const maxDuration = 60;
type Context = { params: Promise<{ token: string }> };

/**
 * Start a public submission (no account required).
 *
 * The link token is the only authorization: it is a 256-bit random value whose hash is stored
 * server-side. This endpoint creates the submission in DRAFT (never public, never approved),
 * records the explicit consent with its exact text/version/timestamp, and opens a multipart
 * upload session for the original file. No admin route, storage credential or other user's
 * data is reachable through it.
 */
export async function POST(request: NextRequest, context: Context) {
  let stage = 'validate_link';
  let multipart: { key: string; uploadId: string } | null = null;
  try {
    assertSameOrigin(request);
    const { token } = await context.params;
    const db = createSupabaseAdmin();
    const link = await loadSubmissionLink(db, token);

    stage = 'rate_limit';
    await consumeSubmissionRateLimit(db, hashSubmissionToken(token), hashSubmissionIp(clientIp(request)));

    stage = 'read_request';
    const body = await readJson(request);
    const parsed = createSubmissionSchema.safeParse(body);
    if (!parsed.success) {
      if (isConsentIssue(parsed.error)) {
        throw new HttpError(400, 'يجب الموافقة صراحةً على إقرار الأغراض والمراجعة والنشر قبل إرسال المشاركة.', 'consent_required');
      }
      throw new HttpError(400, 'بيانات المشاركة غير صالحة. تحقق من العنوان وبيانات المساهم ونوع الملف.', 'validation_error');
    }
    const fileError = validateSubmissionFileMeta(parsed.data);
    if (fileError) throw new HttpError(400, fileError, 'invalid_file');

    stage = 'create_submission';
    const submission = await createSubmission(db, link, parsed.data, {
      ipHash: hashSubmissionIp(clientIp(request)),
      userAgent: request.headers.get('user-agent')?.slice(0, 500) ?? null,
    });

    stage = 'create_storage_multipart';
    const config = storageConfig();
    const client = getS3Client();
    const uploadId = randomUUID();
    const key = originalObjectKey(submission.id);
    const create = await client.send(new CreateMultipartUploadCommand({
      Bucket: config.bucket,
      Key: key,
      ContentType: parsed.data.mimeType,
      CacheControl: 'private, max-age=3600',
      Metadata: { 'upload-reference': uploadId, 'submission-id': submission.id },
    }), storageRequestOptions());
    if (!create.UploadId) throw new Error('Object storage did not return a multipart upload id.');
    multipart = { key, uploadId: create.UploadId };

    stage = 'insert_upload_session';
    const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const { data: upload, error } = await db.from('submission_uploads').insert({
      id: uploadId,
      submission_id: submission.id,
      storage_path: key,
      multipart_id: create.UploadId,
      file_name: parsed.data.fileName,
      file_size: parsed.data.fileSize,
      mime_type: parsed.data.mimeType,
      expires_at: expiresAt,
    }).select('id').single();
    if (error) {
      await client.send(new AbortMultipartUploadCommand({ Bucket: config.bucket, Key: key, UploadId: create.UploadId }), storageRequestOptions(5_000)).catch(() => undefined);
      throw error;
    }

    return NextResponse.json({
      submissionId: submission.id,
      uploadId: upload.id,
      partSize: UPLOAD_PART_SIZE,
      totalParts: uploadPartCount(parsed.data.fileSize),
      expiresAt,
      kind: SUBMISSION_MIME_KIND[parsed.data.mimeType],
      state: submission.state,
    }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (multipart) {
      await getS3Client().send(new AbortMultipartUploadCommand({
        Bucket: storageConfig().bucket, Key: multipart.key, UploadId: multipart.uploadId,
      }), storageRequestOptions(5_000)).catch(() => undefined);
    }
    return errorResponse(error, { route: 'POST /api/submit/[token]/uploads', stage });
  }
}
