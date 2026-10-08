'use client';

import { api, jsonBody, RequestTimeoutError, withRequestTimeout } from '@/lib/client/api';
import { uploadPartCount, uploadPartRange, uploadPartSize } from '@/lib/shared';

/** One part as the browser actually uploaded it: `size` is read off the Blob, never recomputed. */
export type DeclaredUploadPart = { partNumber: number; size: number };

export const PART_UPLOAD_TIMEOUT_MS = 120_000;
const PART_CONCURRENCY = 3;
const PART_ATTEMPTS = 3;

/**
 * Slice one part out of a File/Blob.
 *
 * `Blob.slice(start, end)` treats `end` as EXCLUSIVE, and the bounds come from the
 * shared `uploadPartRange()` helper, so the returned Blob is exactly the bytes of
 * that part — including the short final part. The Blob's own `size` is then the
 * authoritative part length: it is what gets PUT to Storage and what gets reported
 * to the server, so no second, independent calculation can disagree with it.
 */
export function slicePart(file: Blob, partNumber: number): Blob {
  const { start, end, size } = uploadPartRange(file.size, partNumber);
  const blob = file.slice(start, end);
  if (blob.size !== size) {
    // Only reachable if the underlying file changed while it was being read (a moved,
    // truncated or re-written file). Refuse to upload a part whose bytes we cannot vouch for.
    throw new Error(
      `الجزء ${partNumber}: المقطع المقروء من الملف طوله ${blob.size} بايت بينما المتوقع ${size} بايت. لم يُرفع هذا الجزء.`,
    );
  }
  return blob;
}

/**
 * The part manifest sent to `…/complete`.
 *
 * Parts this browser just uploaded report their real `Blob.size`. Parts an earlier
 * session already landed in Storage are not re-read, so they report the size the
 * shared partition assigns them; the server validates the manifest against the same
 * partition and then verifies the assembled object's true byte length with HeadObject.
 */
export function buildPartManifest(fileSize: number, uploaded: Iterable<DeclaredUploadPart> = []): DeclaredUploadPart[] {
  const actual = new Map([...uploaded].map(part => [part.partNumber, part.size]));
  return Array.from({ length: uploadPartCount(fileSize) }, (_unused, index) => {
    const partNumber = index + 1;
    const size = actual.get(partNumber);
    return { partNumber, size: Number.isInteger(size) ? size! : uploadPartSize(fileSize, partNumber) };
  });
}

/**
 * PUT every requested part straight to its signed Storage URL as a Blob body.
 *
 * The media bytes never travel through the Next/Vercel API and are never wrapped in
 * FormData: each part is one `PUT` of a Blob to the presigned S3 `UploadPart` URL.
 * Resolves with the actual byte length of every part that was uploaded.
 */
export async function uploadParts(
  file: Blob,
  uploadId: string,
  partNumbers: number[],
  onPartComplete: (bytes: number) => void,
  partsEndpoint?: string,
): Promise<DeclaredUploadPart[]> {
  const queue = [...partNumbers];
  const uploaded: DeclaredUploadPart[] = [];
  const run = async () => {
    while (queue.length) {
      const partNumber = queue.shift()!;
      const blob = slicePart(file, partNumber);
      let done = false;
      for (let attempt = 0; attempt < PART_ATTEMPTS && !done; attempt += 1) {
        const startedAt = Date.now();
        if (process.env.NODE_ENV !== 'production') console.debug(`[media-upload] Storage PUT part ${partNumber} started`);
        try {
          // The signed URL is requested per attempt: a retry after a slow failure must not
          // reuse a URL that may already be expired, and the offsets are re-derived from the
          // shared partition every time, so a retry can never send a stale byte range.
          const ticket = await api(partsEndpoint ?? `/api/admin/media/uploads/${uploadId}/parts`, { method: 'POST', body: jsonBody({ partNumbers: [partNumber] }) });
          const partUrl = ticket.urls?.[partNumber];
          if (typeof partUrl !== 'string' || !partUrl) throw new Error(`لم يُرجع الخادم رابط رفع للجزء ${partNumber}.`);
          const response = await withRequestTimeout(`رفع جزء التخزين ${partNumber}`, PART_UPLOAD_TIMEOUT_MS, async signal => {
            const storageResponse = await fetch(partUrl, { method: 'PUT', body: blob, signal });
            if (!storageResponse.ok) {
              const detail = process.env.NODE_ENV !== 'production'
                ? (await storageResponse.text().catch(() => ''))
                    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL redacted]')
                    .replace(/(authorization|access[_ -]?key|secret|token|signature|password)(\s*[:=]\s*|\s+)[^\s,;<>"']+/gi, '$1$2[redacted]')
                    .slice(0, 500)
                : '';
              throw new Error(`رفض تخزين الجزء ${partNumber} (HTTP ${storageResponse.status})${detail ? `: ${detail}` : ''}`);
            }
            return storageResponse;
          });
          done = true;
          // Report the length of the Blob that was really sent, not an arithmetic expectation.
          uploaded.push({ partNumber, size: blob.size });
          onPartComplete(blob.size);
          if (process.env.NODE_ENV !== 'production') console.debug(`[media-upload] Storage PUT part ${partNumber} finished`, { status: response.status, elapsedMs: Date.now() - startedAt });
        } catch (error) {
          // A timed-out PUT has an unknown outcome; don't retry blindly. The upload session is
          // retained and the next attempt first asks Storage which part numbers actually landed.
          if (error instanceof RequestTimeoutError || attempt === PART_ATTEMPTS - 1) throw error;
          await new Promise(resolve => setTimeout(resolve, 700 * (attempt + 1)));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, queue.length) }, () => run()));
  return uploaded.sort((left, right) => left.partNumber - right.partNumber);
}
