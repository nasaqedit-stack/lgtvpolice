import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorResponse, HttpError } from '../lib/server/http';
import { ConfigError } from '../lib/server/config-error';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// Regression test for the admin media upload bug report: a missing server environment variable
// (e.g. SUPABASE_S3_ACCESS_KEY_ID) used to be masked behind a generic, unhelpful 500
// ("تعذر إكمال الطلب. حاول مرة أخرى.") with no indication of what was actually wrong. That made a
// misconfigured deployment indistinguishable from a transient failure. ConfigError must now
// surface a distinct, actionable 503 naming the missing variable (never its value).
describe('errorResponse', () => {
  it('reports a missing environment variable as a distinct, actionable 503', async () => {
    const response = errorResponse(new ConfigError('SUPABASE_S3_ACCESS_KEY_ID'));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.code).toBe('server_misconfigured');
    expect(body.missingVariable).toBe('SUPABASE_S3_ACCESS_KEY_ID');
    expect(body.error).toContain('SUPABASE_S3_ACCESS_KEY_ID');
  });

  it('still reports HttpError with its own status/code (unchanged behaviour)', async () => {
    const response = errorResponse(new HttpError(403, 'ممنوع', 'forbidden'));
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.code).toBe('forbidden');
  });

  it('keeps unexpected production errors generic', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = errorResponse(new Error('private storage diagnostic'));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.code).toBe('internal_error');
    expect(body.error).not.toContain('private storage diagnostic');
  });

  it('shows the real sanitized storage/database error in development without leaking a signed URL', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = errorResponse(
      Object.assign(new Error('Storage returned BadDigest at https://storage.example/object?X-Amz-Signature=secret-value'), { code: 'BadDigest' }),
      { route: 'POST /api/admin/media/uploads/[uploadId]/complete', stage: 'complete_storage_multipart' },
    );
    const body = await response.json();
    expect(body.error).toContain('Storage returned BadDigest');
    expect(body.error).not.toContain('secret-value');
    expect(body.error).not.toContain('storage.example');
    expect(body.code).toBe('BadDigest');
  });
});
