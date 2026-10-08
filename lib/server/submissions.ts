import { createHash, randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { HttpError, requireAdmin } from '@/lib/server/http';

export { requireAdmin };
import { hashSubmissionToken, isSubmissionTokenShape } from '@/lib/server/submission-links';
import {
  CONSENT_TEXT_AR,
  CONSENT_VERSION,
  SUBMISSION_ALLOWED_MIME_TYPES,
  SUBMISSION_MAX_FILE_SIZE,
  SUBMISSION_MIME_KIND,
  canTransition,
  type SubmissionAuditEvent,
  type SubmissionState,
} from '@/lib/shared/submissions';

/**
 * Server-side submission workflow: creation, consent recording, state transitions, the
 * idempotent FINAL APPROVAL action, publication and the append-only audit trail.
 *
 * Every state change is a guarded UPDATE (`where id = … and state = <expected>`), so two
 * concurrent admin requests cannot both move the same submission, and repeated approval clicks
 * return the existing approval instead of creating a duplicate audit event.
 */

/* ------------------------------------------------------------------ validation schemas */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9][0-9\s-]{6,19}$/;

/**
 * The public submission request. Consent is a hard requirement: `consentAccepted` must be the
 * literal `true` (an active confirmation, not an absent field), and the consent text/version
 * must match the canonical statement exactly. A submission without explicit consent is never
 * accepted.
 */
export const createSubmissionSchema = z.object({
  fileName: z.string().trim().min(1).max(240),
  fileSize: z.number().int().positive().max(SUBMISSION_MAX_FILE_SIZE),
  mimeType: z.enum(SUBMISSION_ALLOWED_MIME_TYPES),
  title: z.string().trim().min(3).max(240),
  description: z.string().trim().max(2000).default(''),
  contributorName: z.string().trim().min(2).max(120),
  contributorContact: z.string().trim().min(5).max(200).refine(
    value => EMAIL_RE.test(value) || PHONE_RE.test(value),
    'أدخل بريدًا إلكترونيًا أو رقم هاتف صالحًا للتواصل معك.',
  ),
  consentAccepted: z.literal(true),
  consentVersion: z.literal(CONSENT_VERSION),
  consentText: z.literal(CONSENT_TEXT_AR),
}).strict();

export type CreateSubmissionInput = z.infer<typeof createSubmissionSchema>;

export function isConsentIssue(error: z.ZodError): boolean {
  return error.issues.some(issue => ['consentAccepted', 'consentText', 'consentVersion'].includes(String(issue.path[0])));
}

export const confirmSchema = z.object({ confirm: z.literal(true) }).strict();

export const rejectSchema = z.object({
  reason: z.string().trim().min(3).max(1000),
}).strict();

export const reviewSchema = z.object({
  action: z.enum(['start', 'request_changes']),
  notes: z.string().trim().max(1000).optional(),
}).strict();

/* ------------------------------------------------------------------ security metadata + rate limits */

/** Hash the source IP with a server-side salt; the raw IP is never stored. */
export function hashSubmissionIp(ip: string | null | undefined): string {
  const salt = process.env.SUBMISSION_RATE_LIMIT_SALT || process.env.PAIRING_RATE_LIMIT_SALT || '';
  return createHash('sha256').update(`submission-ip:${salt}:${ip ?? 'unknown'}`).digest('hex');
}

export function clientIp(request: NextRequest): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first || request.headers.get('x-real-ip') || null;
}

const RATE_LIMIT_WINDOW_MS = 10 * 60_000;
/** Per (link, IP) submissions per window. */
export const SUBMISSION_RATE_LIMIT_PER_LINK_IP = 8;
/** Per IP submissions per window, across all links. */
export const SUBMISSION_RATE_LIMIT_PER_IP = 30;

/**
 * Throws 429 when either rate-limit bucket is exceeded. Buckets are 10-minute windows keyed by
 * salted hashes, mirroring the pairing rate limiter.
 */
export async function consumeSubmissionRateLimit(db: any, linkTokenHash: string, ipHash: string, now = new Date()) {
  const bucketStart = new Date(Math.floor(now.getTime() / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS).toISOString();
  const keys = [
    { key: createHash('sha256').update(`submission-link-ip:${linkTokenHash}:${ipHash}`).digest('hex'), limit: SUBMISSION_RATE_LIMIT_PER_LINK_IP },
    { key: createHash('sha256').update(`submission-ip:${ipHash}`).digest('hex'), limit: SUBMISSION_RATE_LIMIT_PER_IP },
  ];
  for (const { key, limit } of keys) {
    const { data, error } = await db.rpc('consume_submission_rate_limit', { p_key_hash: key, p_bucket_start: bucketStart, p_limit: limit });
    if (error) throw error;
    if (data !== true) {
      throw new HttpError(429, 'تجاوزت عدد محاولات الإرسال المسموح به. أعد المحاولة لاحقًا.', 'submission_rate_limited');
    }
  }
}

/* ------------------------------------------------------------------ audit trail */

/** Append one immutable audit event. The table has no update/delete path (RLS + trigger). */
export async function recordSubmissionEvent(
  db: any,
  event: {
    submissionId: string;
    event: SubmissionAuditEvent;
    actorUserId?: string | null;
    actorRole?: string | null;
    stateAfter?: SubmissionState | null;
    details?: Record<string, unknown>;
  },
) {
  const { error } = await db.from('submission_events').insert({
    submission_id: event.submissionId,
    event: event.event,
    actor_user_id: event.actorUserId ?? null,
    actor_role: event.actorRole ?? null,
    state_after: event.stateAfter ?? null,
    details: event.details ?? {},
  });
  if (error) throw error;
}

/* ------------------------------------------------------------------ loading helpers */

const SUBMISSION_COLUMNS = '*';

export async function loadSubmission(db: any, id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new HttpError(400, 'معرّف المشاركة غير صالح.', 'invalid_submission_id');
  }
  const { data, error } = await db.from('submissions').select(SUBMISSION_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, 'المشاركة غير موجودة.', 'submission_not_found');
  return data;
}

/** Validate a public submission link token. Invalid/expired/revoked links are all a 404. */
export async function loadSubmissionLink(db: any, token: string) {
  if (!isSubmissionTokenShape(token)) throw new HttpError(404, 'رابط المشاركة غير صالح.', 'submission_link_invalid');
  const { data: link, error } = await db.from('submission_links').select('*').eq('token_hash', hashSubmissionToken(token)).maybeSingle();
  if (error) throw error;
  if (!link || !link.active) throw new HttpError(404, 'رابط المشاركة غير صالح أو تم إيقافه.', 'submission_link_invalid');
  if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) {
    throw new HttpError(404, 'انتهت صلاحية رابط المشاركة.', 'submission_link_expired');
  }
  return link;
}

/** Load an in-progress public upload session and verify it belongs to this link. */
export async function loadSubmissionUpload(db: any, uploadId: string, linkId: string) {
  const { data: upload, error } = await db.from('submission_uploads').select('*').eq('id', uploadId).maybeSingle();
  if (error) throw error;
  if (!upload) throw new HttpError(404, 'جلسة الرفع غير موجودة.', 'upload_not_found');
  const { data: submission, error: submissionError } = await db.from('submissions').select('id,link_id,state').eq('id', upload.submission_id).maybeSingle();
  if (submissionError) throw submissionError;
  if (!submission || submission.link_id !== linkId) throw new HttpError(404, 'جلسة الرفع غير موجودة.', 'upload_not_found');
  if (upload.status !== 'uploading') throw new HttpError(409, 'جلسة الرفع لم تعد نشطة.', 'upload_not_active');
  if (new Date(upload.expires_at).getTime() < Date.now()) throw new HttpError(410, 'انتهت صلاحية جلسة الرفع. ابدأ من جديد.', 'upload_expired');
  return { upload, submission };
}

/* ------------------------------------------------------------------ creation (public) */

/**
 * Create the submission row (DRAFT — never public) together with the consent record and its
 * audit event. Consent was already validated by `createSubmissionSchema`; it is recorded here
 * with its exact text, version and timestamp.
 */
export async function createSubmission(
  db: any,
  link: { id: string },
  input: CreateSubmissionInput,
  meta: { ipHash: string; userAgent: string | null },
) {
  const now = new Date().toISOString();
  const id = randomUUID();
  const { data: submission, error } = await db.from('submissions').insert({
    id,
    link_id: link.id,
    title: input.title,
    description: input.description ?? '',
    contributor_name: input.contributorName,
    contributor_contact: input.contributorContact,
    state: 'DRAFT',
    version: 1,
    consent_accepted: true,
    consent_text: input.consentText,
    consent_version: input.consentVersion,
    consent_at: now,
    processing_status: 'pending',
    processing_attempts: 0,
    ip_hash: meta.ipHash,
    user_agent: meta.userAgent,
  }).select('*').single();
  if (error) throw error;
  await recordSubmissionEvent(db, {
    submissionId: id,
    event: 'CONSENT_ACCEPTED',
    actorRole: 'contributor',
    stateAfter: 'DRAFT',
    details: { consentVersion: input.consentVersion, title: input.title },
  });
  return submission;
}

/**
 * The contributor finished uploading: the original file is stored. Record its metadata and move
 * DRAFT -> SUBMITTED. Consent is re-validated here so a row can never reach SUBMITTED without
 * an explicit, recorded consent.
 */
export async function markSubmissionFileStored(
  db: any,
  submission: any,
  file: { storagePath: string; fileName: string; fileSize: number; mimeType: string; sha256: string; width?: number | null; height?: number | null; durationMs?: number | null },
) {
  if (!submission.consent_accepted || !submission.consent_text || !submission.consent_version) {
    throw new HttpError(400, 'لا يمكن استلام المشاركة دون إقرار صريح من المساهم.', 'consent_required');
  }
  if (submission.state !== 'DRAFT') throw new HttpError(409, 'لا يمكن إكمال هذه المشاركة.', 'invalid_state_transition');
  const kind = SUBMISSION_MIME_KIND[file.mimeType as keyof typeof SUBMISSION_MIME_KIND];
  const { data: updated, error } = await db.from('submissions').update({
    state: 'SUBMITTED',
    kind,
    mime_type: file.mimeType,
    original_storage_path: file.storagePath,
    file_size: file.fileSize,
    sha256: file.sha256,
    width: file.width ?? null,
    height: file.height ?? null,
    duration_ms: file.durationMs ?? null,
    updated_at: new Date().toISOString(),
  }).eq('id', submission.id).eq('state', 'DRAFT').select('*').maybeSingle();
  if (error) throw error;
  if (!updated) throw new HttpError(409, 'تغيّرت حالة المشاركة بشكل متزامن.', 'state_conflict');
  await recordSubmissionEvent(db, {
    submissionId: submission.id,
    event: 'SUBMITTED',
    actorRole: 'contributor',
    stateAfter: 'SUBMITTED',
    details: { fileName: file.fileName, fileSize: file.fileSize, mimeType: file.mimeType, sha256: file.sha256 },
  });
  return updated;
}

/* ------------------------------------------------------------------ state transitions (admin) */

async function guardedTransition(
  db: any,
  submission: any,
  to: SubmissionState,
  options: {
    actorUserId?: string | null;
    actorRole?: string | null;
    event: SubmissionAuditEvent;
    details?: Record<string, unknown>;
    extra?: Record<string, unknown>;
  },
) {
  if (!canTransition(submission.state as SubmissionState, to)) {
    throw new HttpError(409, `لا يمكن نقل هذه المشاركة من حالة «${submission.state}» إلى «${to}».`, 'invalid_state_transition');
  }
  const { data: updated, error } = await db.from('submissions').update({
    state: to,
    updated_at: new Date().toISOString(),
    ...options.extra,
  }).eq('id', submission.id).eq('state', submission.state).select('*').maybeSingle();
  if (error) throw error;
  if (!updated) throw new HttpError(409, 'تغيّرت حالة المشاركة بشكل متزامن.', 'state_conflict');
  await recordSubmissionEvent(db, {
    submissionId: submission.id,
    event: options.event,
    actorUserId: options.actorUserId ?? null,
    actorRole: options.actorRole ?? null,
    stateAfter: to,
    details: options.details ?? {},
  });
  return updated;
}

/* ------------------------------------------------------------------ final approval (admin only) */

export type Approver = { id: string; role: 'admin' | 'operator' };

/**
 * FINAL ADMIN APPROVAL — the single server-side action that makes a submission eligible for
 * publication. Validates existence, contributor consent, successful media processing and that
 * the submission is not already approved; records the approving administrator, the exact
 * timestamp and the approved submission version; moves the state to APPROVED and writes one
 * immutable audit event.
 *
 * Idempotent: when the submission is already APPROVED/PUBLISHED the existing approval is
 * returned and NO new approval or audit event is created.
 */
export async function approveSubmission(db: any, submissionId: string, approver: Approver) {
  const submission = await loadSubmission(db, submissionId);

  // Idempotency: a repeated approval click returns the existing approval result.
  if (submission.state === 'APPROVED' || submission.state === 'PUBLISHED') {
    return { submission, alreadyApproved: true as const };
  }

  if (!submission.consent_accepted || !submission.consent_text || !submission.consent_version) {
    throw new HttpError(409, 'لا يمكن الاعتماد: المشاركة تفتقر إلى إقرار المساهم.', 'consent_missing');
  }
  if (submission.processing_status !== 'completed' || !submission.optimized_storage_path) {
    throw new HttpError(
      409,
      submission.processing_status === 'failed'
        ? 'لا يمكن الاعتماد: فشلت معالجة الوسائط. أعد المعالجة أولاً.'
        : 'لا يمكن الاعتماد قبل اكتمال معالجة الوسائط.',
      'processing_incomplete',
    );
  }
  if (!canTransition(submission.state as SubmissionState, 'APPROVED')) {
    throw new HttpError(409, `لا يمكن اعتماد مشاركة في حالة «${submission.state}».`, 'invalid_state_transition');
  }

  const approvedAt = new Date().toISOString();
  const { data: updated, error } = await db.from('submissions').update({
    state: 'APPROVED',
    approved_by: approver.id,
    approved_at: approvedAt,
    approved_version: submission.version,
    reviewed_by: submission.reviewed_by ?? approver.id,
    reviewed_at: submission.reviewed_at ?? approvedAt,
    updated_at: approvedAt,
  }).eq('id', submission.id).eq('state', submission.state).select('*').maybeSingle();
  if (error) throw error;
  if (!updated) {
    // Lost a race with a concurrent approval: return the existing approval (idempotent).
    const fresh = await loadSubmission(db, submissionId);
    if (fresh.state === 'APPROVED' || fresh.state === 'PUBLISHED') return { submission: fresh, alreadyApproved: true as const };
    throw new HttpError(409, 'تغيّرت حالة المشاركة بشكل متزامن.', 'state_conflict');
  }
  await recordSubmissionEvent(db, {
    submissionId: submission.id,
    event: 'APPROVED',
    actorUserId: approver.id,
    actorRole: approver.role,
    stateAfter: 'APPROVED',
    details: {
      submissionVersion: submission.version,
      previousState: submission.state,
      consentVersion: submission.consent_version,
      optimizedSha256: submission.optimized_sha256 ?? null,
    },
  });
  return { submission: updated, alreadyApproved: false as const };
}

export async function rejectSubmission(db: any, submission: any, approver: Approver, reason: string) {
  const now = new Date().toISOString();
  const updated = await guardedTransition(db, submission, 'REJECTED', {
    actorUserId: approver.id,
    actorRole: approver.role,
    event: 'REJECTED',
    details: { reason },
    extra: { rejection_reason: reason, reviewed_by: approver.id, reviewed_at: now },
  });
  return updated;
}

export async function startReview(db: any, submission: any, reviewer: Approver) {
  const now = new Date().toISOString();
  return guardedTransition(db, submission, 'UNDER_REVIEW', {
    actorUserId: reviewer.id,
    actorRole: reviewer.role,
    event: 'REVIEW_STARTED',
    details: {},
    extra: { reviewed_by: reviewer.id, reviewed_at: now },
  });
}

export async function requestChanges(db: any, submission: any, reviewer: Approver, notes: string) {
  return guardedTransition(db, submission, 'READY_FOR_REVIEW', {
    actorUserId: reviewer.id,
    actorRole: reviewer.role,
    event: 'CHANGES_REQUESTED',
    details: { notes },
    extra: { review_notes: notes },
  });
}

export async function archiveSubmission(db: any, submission: any, actor: Approver) {
  return guardedTransition(db, submission, 'ARCHIVED', {
    actorUserId: actor.id,
    actorRole: actor.role,
    event: 'ARCHIVED',
    details: {},
    extra: { archived_at: new Date().toISOString() },
  });
}

/* ------------------------------------------------------------------ publication */

/**
 * Publish an APPROVED submission: the optimized delivery version is registered in the media
 * library (the existing signage pipeline — playlists, manifests, the offline-first player —
 * then distributes it like any other media), and the submission becomes publicly visible
 * through the public delivery endpoint. APPROVED and PUBLISHED stay separate states.
 */
export async function publishSubmission(db: any, submissionId: string, approver: Approver) {
  let submission = await loadSubmission(db, submissionId);
  if (submission.state === 'PUBLISHED') return { submission, media: null, alreadyPublished: true as const };
  if (submission.state !== 'APPROVED') throw new HttpError(409, 'لا يمكن النشر قبل الاعتماد النهائي.', 'not_approved');
  if (submission.processing_status !== 'completed' || !submission.optimized_storage_path || !submission.optimized_sha256) {
    throw new HttpError(409, 'لا يمكن النشر: المعالجة غير مكتملة.', 'processing_incomplete');
  }

  // Reuse an identical library item when the optimized bytes are already registered.
  const { data: existing, error: existingError } = await db.from('media').select('*').eq('sha256', submission.optimized_sha256).maybeSingle();
  if (existingError) throw existingError;
  let media = existing;
  if (!media) {
    const { data: inserted, error: insertError } = await db.from('media').insert({
      storage_path: submission.optimized_storage_path,
      display_name: String(submission.title).slice(0, 240),
      mime_type: submission.optimized_mime_type,
      kind: submission.kind,
      file_size: submission.optimized_file_size,
      sha256: submission.optimized_sha256,
      width: submission.width ?? null,
      height: submission.height ?? null,
      duration_ms: submission.duration_ms ?? null,
      compatibility: 'candidate',
      metadata: {
        source: 'public-submission',
        submissionId: submission.id,
        submissionVersion: submission.version,
        consentVersion: submission.consent_version,
        approvedBy: submission.approved_by,
        approvedAt: submission.approved_at,
      },
      uploaded_by: approver.id,
    }).select('*').single();
    if (insertError) {
      if (insertError.code === '23505') {
        const { data: raced, error: racedError } = await db.from('media').select('*').eq('sha256', submission.optimized_sha256).maybeSingle();
        if (racedError) throw racedError;
        media = raced;
      } else {
        throw insertError;
      }
    } else {
      media = inserted;
    }
  }
  if (!media) throw new HttpError(500, 'تعذر تسجيل الوسائط المعالجة.', 'media_registration_failed');

  const publishedAt = new Date().toISOString();
  const { data: updated, error } = await db.from('submissions').update({
    state: 'PUBLISHED',
    published_media_id: media.id,
    published_by: approver.id,
    published_at: publishedAt,
    updated_at: publishedAt,
  }).eq('id', submission.id).eq('state', 'APPROVED').select('*').maybeSingle();
  if (error) throw error;
  if (!updated) {
    submission = await loadSubmission(db, submissionId);
    if (submission.state === 'PUBLISHED') return { submission, media, alreadyPublished: true as const };
    throw new HttpError(409, 'تغيّرت حالة المشاركة بشكل متزامن.', 'state_conflict');
  }
  await recordSubmissionEvent(db, {
    submissionId: submission.id,
    event: 'PUBLISHED',
    actorUserId: approver.id,
    actorRole: approver.role,
    stateAfter: 'PUBLISHED',
    details: { mediaId: media.id, submissionVersion: submission.version },
  });
  return { submission: updated, media, alreadyPublished: false as const };
}

/** Unpublish: back to APPROVED. The library item is removed only when no playlist uses it. */
export async function unpublishSubmission(db: any, submissionId: string, approver: Approver) {
  const submission = await loadSubmission(db, submissionId);
  if (submission.state !== 'PUBLISHED') throw new HttpError(409, 'المشاركة ليست منشورة.', 'not_published');
  if (submission.published_media_id) {
    const { data: usageRows, error: usageError } = await db.rpc('get_media_usage_counts', { p_media_ids: [submission.published_media_id] });
    if (usageError) throw usageError;
    const count = Number(usageRows?.[0]?.usage_count ?? 0);
    if (count > 0) {
      throw new HttpError(409, 'لا يمكن إلغاء النشر: الوسائط مستخدمة في قوائم تشغيل. أزلها من القوائم أولاً.', 'media_in_use');
    }
    const { error: deleteError } = await db.from('media').delete().eq('id', submission.published_media_id);
    if (deleteError) throw deleteError;
  }
  const unpublishedAt = new Date().toISOString();
  const { data: updated, error } = await db.from('submissions').update({
    state: 'APPROVED',
    published_media_id: null,
    unpublished_at: unpublishedAt,
    updated_at: unpublishedAt,
  }).eq('id', submission.id).eq('state', 'PUBLISHED').select('*').maybeSingle();
  if (error) throw error;
  if (!updated) throw new HttpError(409, 'تغيّرت حالة المشاركة بشكل متزامن.', 'state_conflict');
  await recordSubmissionEvent(db, {
    submissionId: submission.id,
    event: 'UNPUBLISHED',
    actorUserId: approver.id,
    actorRole: approver.role,
    stateAfter: 'APPROVED',
    details: { submissionVersion: submission.version, mediaId: submission.published_media_id },
  });
  return updated;
}

/* ------------------------------------------------------------------ processing retry */

/**
 * Re-run media optimization (safe retry after a processing failure). Bumps the submission
 * version and clears any previous approval, because new bytes are no longer the approved
 * version. Allowed from READY_FOR_REVIEW, UNDER_REVIEW and REJECTED.
 */
export async function reprocessSubmission(db: any, submission: any, actor: Approver) {
  if (!canTransition(submission.state as SubmissionState, 'PROCESSING')) {
    throw new HttpError(409, 'يمكن إعادة المعالجة من حالات «بانتظار الاعتماد» أو «قيد المراجعة» أو «مرفوضة» فقط.', 'invalid_state_transition');
  }
  if (!submission.original_storage_path) throw new HttpError(409, 'لا يوجد ملف أصلي لإعادة معالجته.', 'no_original');
  const nextVersion = Number(submission.version ?? 1) + 1;
  const { data: updated, error } = await db.from('submissions').update({
    state: 'PROCESSING',
    processing_status: 'processing',
    processing_error: null,
    processing_started_at: new Date().toISOString(),
    processing_attempts: Number(submission.processing_attempts ?? 0) + 1,
    version: nextVersion,
    // The approved version no longer matches the bytes that will be produced.
    approved_by: null,
    approved_at: null,
    approved_version: null,
    updated_at: new Date().toISOString(),
  }).eq('id', submission.id).eq('state', submission.state).select('*').maybeSingle();
  if (error) throw error;
  if (!updated) throw new HttpError(409, 'تغيّرت حالة المشاركة بشكل متزامن.', 'state_conflict');
  await recordSubmissionEvent(db, {
    submissionId: submission.id,
    event: 'PROCESSING_STARTED',
    actorUserId: actor.id,
    actorRole: actor.role,
    stateAfter: 'PROCESSING',
    details: { attempt: Number(submission.processing_attempts ?? 0) + 1, version: nextVersion, reason: 'retry' },
  });
  return updated;
}

/* ------------------------------------------------------------------ authorization */

/**
 * The FINAL APPROVER is a `admin`-role user. Reviewers (`operator`) may read, start reviews,
 * request changes, reprocess and archive, but never approve, reject, publish or unpublish.
 */
export async function requireApprover(request: NextRequest) {
  const session = await requireAdmin(request);
  if (session.role !== 'admin') {
    throw new HttpError(403, 'الاعتماد النهائي وقرار النشر يتطلبان صلاحية مدير النظام.', 'approver_required');
  }
  return session;
}
