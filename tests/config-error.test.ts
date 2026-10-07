import { describe, expect, it } from 'vitest';
import { errorResponse, HttpError } from '../lib/server/http';
import { ConfigError } from '../lib/server/config-error';

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

  it('falls back to a generic internal_error for anything else (unchanged behaviour)', async () => {
    const response = errorResponse(new Error('boom'));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.code).toBe('internal_error');
  });
});
