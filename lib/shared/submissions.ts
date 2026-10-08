/**
 * Public contribution workflow — shared between the public `/submit/[token]` page, the admin
 * submissions queue and the API routes.
 *
 * The intended model is PUBLIC AWARENESS / EDUCATIONAL content:
 *
 *   contributor submission -> explicit consent -> media optimization -> admin review
 *     -> FINAL ADMIN APPROVAL -> publication
 *
 * A submission is never public on upload. Only a server-side administrator decision moves a
 * submission to APPROVED, and only an APPROVED submission can become PUBLISHED. No client-side
 * flag (e.g. `isApproved=true`) has any effect: every transition is enforced in Route Handlers
 * with guarded database updates.
 *
 * This system is NOT a secure channel for classified, secret, confidential or restricted
 * information. Contributors are explicitly told not to upload such material.
 */

/* ------------------------------------------------------------------ states */

export const SUBMISSION_STATES = [
  'DRAFT',
  'SUBMITTED',
  'PROCESSING',
  'READY_FOR_REVIEW',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'PUBLISHED',
  'ARCHIVED',
] as const;
export type SubmissionState = (typeof SUBMISSION_STATES)[number];

export const SUBMISSION_PROCESSING_STATUSES = ['pending', 'processing', 'completed', 'failed'] as const;
export type SubmissionProcessingStatus = (typeof SUBMISSION_PROCESSING_STATUSES)[number];

/** Append-only audit events (public.submission_events). */
export const SUBMISSION_AUDIT_EVENTS = [
  'CONSENT_ACCEPTED',
  'SUBMITTED',
  'PROCESSING_STARTED',
  'PROCESSING_COMPLETED',
  'PROCESSING_FAILED',
  'REVIEW_STARTED',
  'CHANGES_REQUESTED',
  'APPROVED',
  'REJECTED',
  'PUBLISHED',
  'UNPUBLISHED',
  'ARCHIVED',
] as const;
export type SubmissionAuditEvent = (typeof SUBMISSION_AUDIT_EVENTS)[number];

/**
 * The submission state machine. DRAFT is the default after a contributor starts an upload and
 * is never public; APPROVED is reachable ONLY through the server-side final approval action;
 * PUBLISHED is reachable only from APPROVED.
 */
const SUBMISSION_TRANSITIONS: Record<SubmissionState, readonly SubmissionState[]> = {
  DRAFT: ['SUBMITTED', 'ARCHIVED'],
  SUBMITTED: ['PROCESSING', 'ARCHIVED'],
  PROCESSING: ['READY_FOR_REVIEW'],
  READY_FOR_REVIEW: ['UNDER_REVIEW', 'APPROVED', 'REJECTED', 'PROCESSING', 'ARCHIVED'],
  UNDER_REVIEW: ['APPROVED', 'REJECTED', 'READY_FOR_REVIEW', 'PROCESSING', 'ARCHIVED'],
  APPROVED: ['PUBLISHED', 'REJECTED', 'ARCHIVED'],
  REJECTED: ['PROCESSING', 'ARCHIVED'],
  // Unpublishing returns the submission to APPROVED; archiving a published item requires
  // unpublishing first so published media is never orphaned silently.
  PUBLISHED: ['APPROVED'],
  ARCHIVED: [],
};

export function canTransition(from: SubmissionState, to: SubmissionState): boolean {
  return (SUBMISSION_TRANSITIONS[from] ?? []).includes(to);
}

export function isPublicState(state: SubmissionState): boolean {
  // The ONLY publicly visible state. Everything else — including APPROVED — is not public.
  return state === 'PUBLISHED';
}

/* ------------------------------------------------------------------ consent */

/** Version of the consent statement. Bump when the wording changes. */
export const CONSENT_VERSION = '2026-10-08.v1';

/**
 * The exact consent statement the contributor must actively accept before a submission is
 * accepted. The server compares the submitted text byte-for-byte with this constant, so the
 * wording can never drift between what the contributor saw and what is recorded.
 */
export const CONSENT_TEXT_AR = 'أقر بأن المادة التي أرفعها مخصصة للأغراض الأمنية والتوعوية والإعلامية والنشر العام بعد المراجعة والاعتماد، وأن لدي الحق في تقديمها، وأوافق على مراجعتها واستخدامها ونشرها وفق الإجراءات المعتمدة. كما أقر بعدم رفع أي معلومات سرية أو مصنفة أو مقيدة أو بيانات لا أملك حق مشاركتها.';

/* ------------------------------------------------------------------ files */

export const SUBMISSION_ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/quicktime',
] as const;
export type SubmissionMimeType = (typeof SUBMISSION_ALLOWED_MIME_TYPES)[number];

export const SUBMISSION_MIME_KIND: Record<SubmissionMimeType, 'image' | 'video'> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'video/mp4': 'video',
  'video/quicktime': 'video',
};

/** Public submissions are capped well below the 2 GiB admin library ceiling. */
export const SUBMISSION_MAX_FILE_SIZE = 512 * 1024 * 1024;

/** Optimization targets: large enough for TV playback, small enough for fast delivery. */
export const IMAGE_OPTIMIZED_MAX_DIMENSION = 1920;
export const IMAGE_THUMBNAIL_MAX_DIMENSION = 480;
export const VIDEO_OPTIMIZED_MAX_WIDTH = 1920;

/* ------------------------------------------------------------------ public link tokens */

/** 32 random bytes, base64url-encoded (43 characters). Never a predictable or sequential ID. */
export const SUBMISSION_TOKEN_BYTES = 32;
export const SUBMISSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/* ------------------------------------------------------------------ admin queue */

export type SubmissionQueueFilter =
  | 'new'
  | 'reviewing'
  | 'ready'
  | 'approved'
  | 'rejected'
  | 'published'
  | 'archived';

export const SUBMISSION_QUEUE_FILTERS: ReadonlyArray<{
  id: SubmissionQueueFilter;
  label: string;
  states: readonly SubmissionState[];
}> = [
  { id: 'new', label: 'مشاركات جديدة', states: ['SUBMITTED', 'PROCESSING'] },
  { id: 'reviewing', label: 'قيد المراجعة', states: ['UNDER_REVIEW'] },
  { id: 'ready', label: 'بانتظار الاعتماد', states: ['READY_FOR_REVIEW'] },
  { id: 'approved', label: 'معتمدة', states: ['APPROVED'] },
  { id: 'rejected', label: 'مرفوضة', states: ['REJECTED'] },
  { id: 'published', label: 'منشورة', states: ['PUBLISHED'] },
  { id: 'archived', label: 'مؤرشفة', states: ['ARCHIVED'] },
];

export const SUBMISSION_STATE_LABELS: Record<SubmissionState, string> = {
  DRAFT: 'مسودة',
  SUBMITTED: 'مُرسَلة',
  PROCESSING: 'قيد المعالجة',
  READY_FOR_REVIEW: 'بانتظار الاعتماد',
  UNDER_REVIEW: 'قيد المراجعة',
  APPROVED: 'معتمدة',
  REJECTED: 'مرفوضة',
  PUBLISHED: 'منشورة',
  ARCHIVED: 'مؤرشفة',
};

export const SUBMISSION_PROCESSING_LABELS: Record<SubmissionProcessingStatus, string> = {
  pending: 'بانتظار المعالجة',
  processing: 'جارٍ المعالجة',
  completed: 'اكتملت المعالجة',
  failed: 'فشلت المعالجة',
};

/** Badge tones reuse the existing .badge palette (online/pending/failed/neutral/offline). */
export function submissionStateTone(state: SubmissionState): 'online' | 'pending' | 'failed' | 'neutral' | 'offline' {
  switch (state) {
    case 'APPROVED':
    case 'PUBLISHED':
      return 'online';
    case 'REJECTED':
      return 'failed';
    case 'DRAFT':
    case 'ARCHIVED':
      return 'offline';
    case 'SUBMITTED':
    case 'PROCESSING':
    case 'READY_FOR_REVIEW':
    case 'UNDER_REVIEW':
      return 'pending';
    default:
      return 'neutral';
  }
}

export function submissionProcessingTone(status: SubmissionProcessingStatus): 'online' | 'pending' | 'failed' | 'neutral' {
  switch (status) {
    case 'completed':
      return 'online';
    case 'failed':
      return 'failed';
    case 'processing':
      return 'pending';
    default:
      return 'neutral';
  }
}

export const SUBMISSION_AUDIT_EVENT_LABELS: Record<SubmissionAuditEvent, string> = {
  CONSENT_ACCEPTED: 'قبول إقرار المساهم',
  SUBMITTED: 'استلام المشاركة',
  PROCESSING_STARTED: 'بدء معالجة الوسائط',
  PROCESSING_COMPLETED: 'اكتمال معالجة الوسائط',
  PROCESSING_FAILED: 'فشل معالجة الوسائط',
  REVIEW_STARTED: 'بدء المراجعة',
  CHANGES_REQUESTED: 'طلب تعديلات',
  APPROVED: 'اعتماد نهائي',
  REJECTED: 'رفض المشاركة',
  PUBLISHED: 'نشر المشاركة',
  UNPUBLISHED: 'إلغاء النشر',
  ARCHIVED: 'أرشفة المشاركة',
};
