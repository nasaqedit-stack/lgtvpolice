import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CONSENT_TEXT_AR,
  CONSENT_VERSION,
  SUBMISSION_MAX_FILE_SIZE,
  SUBMISSION_STATES,
  canTransition,
  isPublicState,
} from '../lib/shared/submissions';
import { createSubmissionSchema, isConsentIssue } from '../lib/server/submissions';
import { generateSubmissionToken, hashSubmissionToken, isSubmissionTokenShape, submissionPath } from '../lib/server/submission-links';
import { sanitizeFileName, signatureMatches, validateSubmissionFileMeta } from '../lib/server/file-validation';

const validPayload = {
  fileName: 'poster.png',
  fileSize: 1024,
  mimeType: 'image/png',
  title: 'حملة توعية أمنية',
  description: 'ملصق توعوي',
  contributorName: 'أحمد محمد',
  contributorContact: 'ahmad@example.org',
  consentAccepted: true,
  consentVersion: CONSENT_VERSION,
  consentText: CONSENT_TEXT_AR,
};

describe('submission state machine', () => {
  it('covers exactly the required states', () => {
    expect([...SUBMISSION_STATES].sort()).toEqual([
      'APPROVED', 'ARCHIVED', 'DRAFT', 'PROCESSING', 'PUBLISHED',
      'READY_FOR_REVIEW', 'REJECTED', 'SUBMITTED', 'UNDER_REVIEW',
    ]);
  });

  it('never allows DRAFT/UPLOAD to become APPROVED directly, and only APPROVED becomes PUBLISHED', () => {
    expect(canTransition('DRAFT', 'APPROVED')).toBe(false);
    expect(canTransition('SUBMITTED', 'APPROVED')).toBe(false);
    expect(canTransition('READY_FOR_REVIEW', 'APPROVED')).toBe(true);
    expect(canTransition('UNDER_REVIEW', 'APPROVED')).toBe(true);
    expect(canTransition('APPROVED', 'PUBLISHED')).toBe(true);
    expect(canTransition('READY_FOR_REVIEW', 'PUBLISHED')).toBe(false);
    expect(canTransition('DRAFT', 'PUBLISHED')).toBe(false);
    expect(canTransition('ARCHIVED', 'PUBLISHED')).toBe(false);
    expect(canTransition('PUBLISHED', 'APPROVED')).toBe(true); // unpublish
  });

  it('keeps the public visibility OFF for every state except PUBLISHED', () => {
    for (const state of SUBMISSION_STATES) {
      expect(isPublicState(state)).toBe(state === 'PUBLISHED');
    }
  });

  it('supports review, rejection, retry and archival branches', () => {
    expect(canTransition('READY_FOR_REVIEW', 'UNDER_REVIEW')).toBe(true);
    expect(canTransition('UNDER_REVIEW', 'READY_FOR_REVIEW')).toBe(true); // changes requested
    expect(canTransition('UNDER_REVIEW', 'REJECTED')).toBe(true);
    expect(canTransition('READY_FOR_REVIEW', 'REJECTED')).toBe(true);
    expect(canTransition('REJECTED', 'PROCESSING')).toBe(true); // safe retry
    expect(canTransition('READY_FOR_REVIEW', 'PROCESSING')).toBe(true);
    expect(canTransition('APPROVED', 'PROCESSING')).toBe(false); // reprocess needs reject first
    expect(canTransition('PUBLISHED', 'ARCHIVED')).toBe(false); // unpublish first
    expect(canTransition('APPROVED', 'ARCHIVED')).toBe(true);
  });
});

describe('consent requirement', () => {
  it('accepts a fully valid payload', () => {
    expect(createSubmissionSchema.safeParse(validPayload).success).toBe(true);
  });

  it('rejects a missing consent checkbox (never accept without explicit consent)', () => {
    const withoutConsent: Record<string, unknown> = { ...validPayload };
    delete withoutConsent.consentAccepted;
    const result = createSubmissionSchema.safeParse(withoutConsent);
    expect(result.success).toBe(false);
    if (!result.success) expect(isConsentIssue(result.error)).toBe(true);
  });

  it('rejects consentAccepted=false', () => {
    const result = createSubmissionSchema.safeParse({ ...validPayload, consentAccepted: false });
    expect(result.success).toBe(false);
    if (!result.success) expect(isConsentIssue(result.error)).toBe(true);
  });

  it('rejects a tampered consent text or version (exact wording is enforced)', () => {
    expect(createSubmissionSchema.safeParse({ ...validPayload, consentText: `${CONSENT_TEXT_AR} ` }).success).toBe(false);
    expect(createSubmissionSchema.safeParse({ ...validPayload, consentVersion: '1999-01-01.v0' }).success).toBe(false);
  });

  it('rejects unknown extra fields (a client cannot smuggle approval flags)', () => {
    expect(createSubmissionSchema.safeParse({ ...validPayload, isApproved: true, state: 'APPROVED' }).success).toBe(false);
  });

  it('requires a title, contributor name and an email-or-phone contact', () => {
    expect(createSubmissionSchema.safeParse({ ...validPayload, title: 'ab' }).success).toBe(false);
    expect(createSubmissionSchema.safeParse({ ...validPayload, contributorName: 'x' }).success).toBe(false);
    expect(createSubmissionSchema.safeParse({ ...validPayload, contributorContact: 'not a contact' }).success).toBe(false);
    expect(createSubmissionSchema.safeParse({ ...validPayload, contributorContact: '+966501234567' }).success).toBe(true);
  });
});

describe('public submission link tokens', () => {
  it('generates 256-bit base64url tokens that are never predictable', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      const { token, tokenHash } = generateSubmissionToken();
      expect(isSubmissionTokenShape(token)).toBe(true);
      expect(token).toHaveLength(43);
      expect(seen.has(token)).toBe(false);
      seen.add(token);
      expect(tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
      expect(submissionPath(token)).toBe(`/submit/${token}`);
    }
  });

  it('rejects predictable IDs as tokens', () => {
    for (const predictable of ['1', 'submission-1', '00000000-0000-4000-8000-000000000001', '../etc/passwd', 'short', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']) {
      expect(isSubmissionTokenShape(predictable)).toBe(false);
    }
  });

  it('a constant 43-char string passes the shape check but fails the hash lookup (not a stored link)', () => {
    const constant = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(isSubmissionTokenShape(constant)).toBe(true);
    // The link is looked up by SHA-256(token): an attacker-guessed constant never matches a real
    // link's stored hash, so the route answers 404. Verified end-to-end in submission-api tests.
    expect(hashSubmissionToken(constant)).not.toBe(hashSubmissionToken(generateSubmissionToken().token));
  });

  it('hashes tokens deterministically for lookup', () => {
    const { token } = generateSubmissionToken();
    expect(hashSubmissionToken(token)).toBe(hashSubmissionToken(token));
    expect(hashSubmissionToken(token)).not.toBe(hashSubmissionToken('other'));
  });
});

describe('file validation', () => {
  it('validates magic bytes per MIME type', () => {
    expect(signatureMatches('image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(signatureMatches('image/png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    expect(signatureMatches('image/webp', new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe(true);
    const ftyp = new Uint8Array(32);
    ftyp.set([0x66, 0x74, 0x79, 0x70], 4); // "ftyp" at offset 4
    expect(signatureMatches('video/mp4', ftyp)).toBe(true);
    expect(signatureMatches('video/quicktime', ftyp)).toBe(true);
    expect(signatureMatches('image/png', new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(false);
    expect(signatureMatches('image/svg+xml', new Uint8Array([0x3c, 0x73, 0x76, 0x67]))).toBe(false);
    expect(signatureMatches('text/html', new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c]))).toBe(false);
  });

  it('rejects oversized, unsupported and mismatched files', () => {
    expect(validateSubmissionFileMeta({ fileName: 'big.mp4', fileSize: SUBMISSION_MAX_FILE_SIZE + 1, mimeType: 'video/mp4' })).toMatch(/حجم الملف/);
    expect(validateSubmissionFileMeta({ fileName: 'vector.svg', fileSize: 100, mimeType: 'image/png' })).toMatch(/امتداد/);
    expect(validateSubmissionFileMeta({ fileName: 'page.html', fileSize: 100, mimeType: 'image/png' })).toMatch(/امتداد/);
    expect(validateSubmissionFileMeta({ fileName: 'photo.png', fileSize: 100, mimeType: 'image/jpeg' })).toMatch(/يطابق/);
    expect(validateSubmissionFileMeta({ fileName: 'photo.png', fileSize: 100, mimeType: 'image/png' })).toBeNull();
    expect(validateSubmissionFileMeta({ fileName: 'clip.mov', fileSize: 100, mimeType: 'video/quicktime' })).toBeNull();
    expect(validateSubmissionFileMeta({ fileName: 'noext', fileSize: 100, mimeType: 'image/png' })).toMatch(/امتداد/);
  });

  it('sanitizes contributor file names to a safe ASCII fallback', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('my poster (final).png')).toBe('my-poster-final-.png');
    expect(sanitizeFileName('')).toBe('file');
    const arabic = sanitizeFileName('ملف.png');
    expect(arabic).not.toContain('/');
    expect(arabic.endsWith('.png')).toBe(true);
  });
});
