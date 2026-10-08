import { createHash, randomBytes } from 'node:crypto';
import { SUBMISSION_TOKEN_BYTES, SUBMISSION_TOKEN_PATTERN } from '@/lib/shared/submissions';

/**
 * Public submission links (`/submit/<token>`).
 *
 * The token is 32 bytes of CSPRNG output, base64url-encoded — never a predictable or sequential
 * ID. Only its SHA-256 hash is stored, exactly like screen credentials and pairing codes, so a
 * database leak does not disclose usable links. The full URL is shown to the administrator once,
 * at creation time; afterwards the link is managed (and revoked) by ID.
 */

export function generateSubmissionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(SUBMISSION_TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashSubmissionToken(token) };
}

export function hashSubmissionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function isSubmissionTokenShape(token: string): boolean {
  return SUBMISSION_TOKEN_PATTERN.test(token);
}

export function submissionPath(token: string): string {
  return `/submit/${token}`;
}
