/**
 * Thrown when a required server environment variable is missing or empty (e.g. the Supabase S3
 * credentials the admin upload pipeline needs, or the Supabase project URL/keys).
 *
 * Carries only the variable NAME, never a value, so it is always safe to surface in an API
 * response: it turns what used to be a silent, generic 500 ("تعذر إكمال الطلب. حاول مرة أخرى.")
 * into an actionable message that names the exact Vercel Production environment variable to set.
 * The variable names themselves are not secret (they are visible in this public repository's
 * source and in `.env.example`); only their values are sensitive, and those are never included.
 */
export class ConfigError extends Error {
  constructor(public readonly variable: string) {
    super(`Missing server configuration: ${variable}`);
    this.name = 'ConfigError';
  }
}
