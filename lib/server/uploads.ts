import { HttpError } from '@/lib/server/http';
import { UPLOAD_PART_SIZE, uploadPartCount, uploadPartSize } from '@/lib/shared';

export { UPLOAD_PART_SIZE };

export async function loadUpload(db: any, userId: string, id: string) {
  const { data, error } = await db.from('media_uploads').select('*').eq('id', id).eq('user_id', userId).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, 'جلسة الرفع غير موجودة.', 'upload_not_found');
  if (data.status !== 'uploading') throw new HttpError(409, 'جلسة الرفع لم تعد نشطة.', 'upload_not_active');
  if (new Date(data.expires_at).getTime() < Date.now()) throw new HttpError(410, 'انتهت صلاحية جلسة الرفع. ابدأ رفعاً جديداً.', 'upload_expired');
  return data;
}

/** A part as an S3 `ListParts` response reports it. */
export type ListedUploadPart = { PartNumber?: number; Size?: number | null; ETag?: string };
/** A part as the browser declares it: `size` is the `Blob.size` it actually PUT. */
export type DeclaredUploadPart = { partNumber: number; size: number };

function partSizeError(partNumber: number, expected: number, actual: number, source: string) {
  const reported = Number.isFinite(actual) ? `${actual} بايت` : 'غير مُبلَّغ';
  return new HttpError(
    409,
    `حجم أحد أجزاء الرفع غير صحيح: الجزء ${partNumber}، المتوقع ${expected} بايت، ${source} ${reported}.`,
    'upload_part_size_invalid',
  );
}

function manifestError(detail: string) {
  return new HttpError(409, `قائمة أجزاء الرفع المُرسلة غير صالحة: ${detail}`, 'upload_parts_manifest_invalid');
}

/**
 * `ListParts` byte length when the object store reports one.
 *
 * Supabase Storage's S3 `ListParts` serialises only `PartNumber`, `ETag` and
 * `LastModified` — it never emits `<Size>` (its `s3_multipart_uploads_parts.size`
 * column is left at its `DEFAULT 0` because `uploadPart` does not write it). With the
 * AWS SDK that surfaces as `Size === undefined`, so "absent" must never be read as
 * "wrong size": doing that made every finalization fail on part 1 with
 * `upload_part_size_invalid`, for every file size. Stores that do report a size are
 * still validated against it below.
 */
export function listedPartSize(part: ListedUploadPart): number | null {
  return typeof part.Size === 'number' && Number.isFinite(part.Size) ? part.Size : null;
}

/**
 * Byte length to report for an already-landed part when a session is resumed.
 * Uses the store's own number when it gives one, otherwise the size that part must
 * have had, so the browser's progress bar does not restart from zero.
 */
export function resumePartSize(fileSize: number, partNumber: number, reported?: number | null): number {
  if (typeof reported === 'number' && Number.isFinite(reported)) return reported;
  const totalParts = uploadPartCount(fileSize);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > totalParts) return 0;
  return uploadPartSize(fileSize, partNumber);
}

/**
 * Verify that a multipart upload really contains the file it claims to, then return the
 * parts in the ascending order `CompleteMultipartUpload` requires.
 *
 * Three independent layers, all of which stay in place:
 *  1. Storage itself must hold exactly parts 1..N with an ETag each (`upload_incomplete`).
 *  2. Any byte length Storage reports must equal the shared partition (`upload_part_size_invalid`).
 *  3. The browser's manifest must declare one entry per part, each equal to the shared
 *     partition, and the sizes must add up to the declared file size.
 * The caller finishes the proof after assembly with `HeadObject.ContentLength`, which is
 * the object store's own count of the bytes that landed.
 */
export function verifyUploadParts(fileSize: number, listed: ListedUploadPart[], declared?: DeclaredUploadPart[] | null): ListedUploadPart[] {
  const totalParts = uploadPartCount(fileSize);
  const parts = [...listed].sort((left, right) => (left.PartNumber ?? 0) - (right.PartNumber ?? 0));
  if (totalParts < 1 || parts.length !== totalParts || parts.some((part, index) => part.PartNumber !== index + 1 || !part.ETag)) {
    throw new HttpError(409, 'لم تكتمل كل أجزاء الملف. أعد محاولة الأجزاء الناقصة.', 'upload_incomplete');
  }

  for (const [index, part] of parts.entries()) {
    const partNumber = index + 1;
    const expected = uploadPartSize(fileSize, partNumber);
    const reported = listedPartSize(part);
    if (reported !== null && reported !== expected) throw partSizeError(partNumber, expected, reported, 'المسجّل في التخزين');
  }

  if (!declared) {
    // An older admin bundle that does not send a manifest: layers 1 and 2 plus the
    // post-assembly HeadObject length check still apply.
    return parts;
  }

  const seen = new Set<number>();
  for (const entry of declared) {
    if (!entry || !Number.isInteger(entry.partNumber) || entry.partNumber < 1 || entry.partNumber > totalParts) {
      throw manifestError(`رقم جزء غير صالح «${entry?.partNumber}» والملف يتكون من ${totalParts} جزء.`);
    }
    if (seen.has(entry.partNumber)) throw manifestError(`الجزء ${entry.partNumber} مكرّر.`);
    if (!Number.isInteger(entry.size) || entry.size < 0) throw manifestError(`حجم الجزء ${entry.partNumber} ليس عدداً صحيحاً من البايتات.`);
    seen.add(entry.partNumber);
  }
  for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
    if (!seen.has(partNumber)) throw manifestError(`الجزء ${partNumber} ناقص من القائمة.`);
  }

  const declaredSizes = new Map(declared.map(entry => [entry.partNumber, entry.size]));
  let total = 0;
  for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
    const expected = uploadPartSize(fileSize, partNumber);
    const actual = declaredSizes.get(partNumber)!;
    if (actual !== expected) throw partSizeError(partNumber, expected, actual, 'المرفوع من المتصفح');
    total += actual;
  }
  if (total !== fileSize) {
    throw new HttpError(409, `مجموع أحجام الأجزاء ${total} بايت لا يساوي حجم الملف ${fileSize} بايت.`, 'upload_part_size_invalid');
  }
  return parts;
}
