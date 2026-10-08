export type SubmissionState =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'PROCESSING'
  | 'READY_FOR_REVIEW'
  | 'UNDER_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'PUBLISHED'
  | 'ARCHIVED';

export const SUBMISSION_STATES: SubmissionState[] = [
  'DRAFT',
  'SUBMITTED',
  'PROCESSING',
  'READY_FOR_REVIEW',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'PUBLISHED',
  'ARCHIVED',
];

export const SUBMISSION_STATE_LABELS: Record<SubmissionState, string> = {
  DRAFT: 'مسودة',
  SUBMITTED: 'مُرسل',
  PROCESSING: 'قيد المعالجة',
  READY_FOR_REVIEW: 'جاهز للمراجعة',
  UNDER_REVIEW: 'قيد المراجعة',
  APPROVED: 'معتمد',
  REJECTED: 'مرفوض',
  PUBLISHED: 'منشور',
  ARCHIVED: 'مؤرشف',
};

export const SUBMISSION_STATE_TONES: Record<SubmissionState, 'online' | 'offline' | 'pending' | 'failed' | 'neutral'> = {
  DRAFT: 'neutral',
  SUBMITTED: 'pending',
  PROCESSING: 'pending',
  READY_FOR_REVIEW: 'pending',
  UNDER_REVIEW: 'pending',
  APPROVED: 'online',
  REJECTED: 'failed',
  PUBLISHED: 'online',
  ARCHIVED: 'offline',
};

export const VALID_TRANSITIONS: Record<SubmissionState, SubmissionState[]> = {
  DRAFT: ['SUBMITTED'],
  SUBMITTED: ['PROCESSING', 'REJECTED', 'ARCHIVED'],
  PROCESSING: ['READY_FOR_REVIEW', 'SUBMITTED'],
  READY_FOR_REVIEW: ['UNDER_REVIEW', 'REJECTED', 'ARCHIVED'],
  UNDER_REVIEW: ['APPROVED', 'REJECTED', 'ARCHIVED'],
  APPROVED: ['PUBLISHED', 'ARCHIVED'],
  REJECTED: ['ARCHIVED'],
  PUBLISHED: ['ARCHIVED'],
  ARCHIVED: [],
};

export const CONSENT_VERSION = '1.0';
export const CONSENT_TEXT = 'أقر بأن المادة التي أرفعها مخصصة للأغراض الأمنية والتوعوية والإعلامية والنشر العام بعد المراجعة والاعتماد، وأن لدي الحق في تقديمها، وأوافق على مراجعتها واستخدامها ونشرها وفق الإجراءات المعتمدة. كما أقر بعدم رفع أي معلومات سرية أو مصنفة أو مقيدة أو بيانات لا أملك حق مشاركتها.';

export const SUBMISSION_MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GiB
export const SUBMISSION_ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/quicktime',
] as const;

export type SubmissionAllowedMimeType = typeof SUBMISSION_ALLOWED_MIME_TYPES[number];

export const SUBMISSION_OPTIMIZED_IMAGE_MAX_DIMENSION = 1920;
export const SUBMISSION_THUMBNAIL_MAX_DIMENSION = 480;
export const SUBMISSION_VIDEO_MAX_WIDTH = 1920;
export const SUBMISSION_VIDEO_MAX_HEIGHT = 1080;