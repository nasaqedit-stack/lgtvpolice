import { describe, it, expect } from 'vitest';
import { SUBMISSION_STATES, SUBMISSION_STATE_LABELS, SUBMISSION_STATE_TONES, VALID_TRANSITIONS, CONSENT_VERSION, CONSENT_TEXT, SUBMISSION_MAX_FILE_SIZE, SUBMISSION_ALLOWED_MIME_TYPES, SUBMISSION_OPTIMIZED_IMAGE_MAX_DIMENSION, SUBMISSION_THUMBNAIL_MAX_DIMENSION, SUBMISSION_VIDEO_MAX_WIDTH, SUBMISSION_VIDEO_MAX_HEIGHT } from '@/lib/shared';

describe('Shared Submission Constants', () => {
  it('should export all submission states', () => {
    expect(SUBMISSION_STATES).toEqual([
      'DRAFT',
      'SUBMITTED',
      'PROCESSING',
      'READY_FOR_REVIEW',
      'UNDER_REVIEW',
      'APPROVED',
      'REJECTED',
      'PUBLISHED',
      'ARCHIVED',
    ]);
  });

  it('should have Arabic labels for all states', () => {
    for (const state of SUBMISSION_STATES) {
      expect(SUBMISSION_STATE_LABELS[state]).toBeDefined();
      expect(typeof SUBMISSION_STATE_LABELS[state]).toBe('string');
      expect(SUBMISSION_STATE_LABELS[state].length).toBeGreaterThan(0);
    }
  });

  it('should have tones for all states', () => {
    for (const state of SUBMISSION_STATES) {
      expect(SUBMISSION_STATE_TONES[state]).toBeDefined();
      expect(['online', 'offline', 'pending', 'failed', 'neutral']).toContain(SUBMISSION_STATE_TONES[state]);
    }
  });

  it('should have valid transitions', () => {
    expect(VALID_TRANSITIONS.DRAFT).toContain('SUBMITTED');
    expect(VALID_TRANSITIONS.SUBMITTED).toContain('PROCESSING');
    expect(VALID_TRANSITIONS.PROCESSING).toContain('READY_FOR_REVIEW');
    expect(VALID_TRANSITIONS.READY_FOR_REVIEW).toContain('UNDER_REVIEW');
    expect(VALID_TRANSITIONS.UNDER_REVIEW).toContain('APPROVED');
    expect(VALID_TRANSITIONS.APPROVED).toContain('PUBLISHED');
  });

  it('should not allow transitions from ARCHIVED', () => {
    expect(VALID_TRANSITIONS.ARCHIVED).toEqual([]);
  });

  it('should have correct consent version and text', () => {
    expect(CONSENT_VERSION).toBe('1.0');
    expect(CONSENT_TEXT).toContain('للأغراض الأمنية');
    expect(CONSENT_TEXT).toContain('التوعوية');
    expect(CONSENT_TEXT).toContain('عدم رفع أي معلومات سرية');
    expect(CONSENT_TEXT.length).toBeGreaterThan(100);
  });

  it('should have correct file size limit (2 GiB)', () => {
    expect(SUBMISSION_MAX_FILE_SIZE).toBe(2 * 1024 * 1024 * 1024);
  });

  it('should have correct allowed MIME types', () => {
    expect(SUBMISSION_ALLOWED_MIME_TYPES).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
      'video/mp4',
      'video/quicktime',
    ]);
  });

  it('should have correct optimization dimensions', () => {
    expect(SUBMISSION_OPTIMIZED_IMAGE_MAX_DIMENSION).toBe(1920);
    expect(SUBMISSION_THUMBNAIL_MAX_DIMENSION).toBe(480);
    expect(SUBMISSION_VIDEO_MAX_WIDTH).toBe(1920);
    expect(SUBMISSION_VIDEO_MAX_HEIGHT).toBe(1080);
  });
});