import { SUBMISSION_ALLOWED_MIME_TYPES, SUBMISSION_MAX_FILE_SIZE, type SubmissionMimeType } from '@/lib/shared/submissions';

/**
 * Server-side file validation shared by the admin media pipeline and the public submission
 * pipeline. A declared MIME type is never trusted on its own: the stored bytes must match the
 * container/image signature (magic bytes) before the file is accepted.
 */

/** Magic-byte check: does `bytes` really start like the container/image `mime` claims? */
export function signatureMatches(mime: string, bytes: Uint8Array): boolean {
  if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/png') return bytes[0] === 0x89 && String.fromCharCode(...bytes.slice(1, 4)) === 'PNG';
  if (mime === 'image/webp') return String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  if (mime === 'video/mp4' || mime === 'video/quicktime') return String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp';
  return false;
}

/** Compare media types only: a store may echo parameters (`image/png; charset=binary`) it was never given. */
export function sameMediaType(left: string | undefined, right: string | undefined): boolean {
  const trim = (value: string | undefined) => String(value ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return trim(left) === trim(right) && trim(left) !== '';
}

const EXTENSION_BY_MIME: Record<SubmissionMimeType, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
};

export function extensionForMime(mime: SubmissionMimeType): string {
  return EXTENSION_BY_MIME[mime];
}

/**
 * Reduce a contributor-supplied file name to a safe ASCII fallback for Content-Disposition and
 * logs. Object keys never embed the original name, so this is display-only.
 */
export function sanitizeFileName(name: string): string {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
  return cleaned || 'file';
}

/**
 * Validate the declared file metadata of a public submission. Returns an Arabic error message,
 * or null when the file is acceptable. Checks: extension/MIME allowlist, magic-byte shape is
 * verified separately after upload, and the size ceiling.
 */
export function validateSubmissionFileMeta(input: { fileName: string; fileSize: number; mimeType: string }): string | null {
  const { fileName, fileSize, mimeType } = input;
  if (!fileName || !fileName.trim()) return 'اسم الملف مفقود.';
  if (!Number.isInteger(fileSize) || fileSize <= 0) return 'حجم الملف غير صالح.';
  if (fileSize > SUBMISSION_MAX_FILE_SIZE) {
    return `حجم الملف يتجاوز الحد المسموح به (${Math.round(SUBMISSION_MAX_FILE_SIZE / 1024 / 1024)} ميجابايت).`;
  }
  if (!(SUBMISSION_ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType)) {
    return 'نوع الملف غير مدعوم. الصيغ المقبولة: JPG وPNG وWebP وMP4 وMOV.';
  }
  // The extension must exist and agree with the declared MIME type. Anything else — including
  // SVG, HTML or script files — is rejected before a single byte is uploaded.
  const extension = extOf(fileName);
  const extensionMime = (Object.entries(EXTENSION_BY_MIME) as Array<[SubmissionMimeType, string]>)
    .find(([, ext]) => ext === extension)?.[0];
  if (!extensionMime) return 'امتداد الملف غير مدعوم. الصيغ المقبولة: jpg وpng وwebp وmp4 وmov.';
  if (extensionMime !== mimeType) return 'امتداد الملف لا يطابق نوعه المعلن.';
  return null;
}

function extOf(fileName: string): string {
  const match = /\.([a-z0-9]{1,5})$/i.exec(fileName.trim());
  return match ? `.${match[1].toLowerCase()}` : '';
}
