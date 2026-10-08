import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { ConfigError } from '@/lib/server/config-error';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new ConfigError(name);
  return value;
}

export function getSubmissionRateLimitSalt(): string {
  // Falls back to PAIRING_RATE_LIMIT_SALT when unset
  return process.env.SUBMISSION_RATE_LIMIT_SALT || required('PAIRING_RATE_LIMIT_SALT');
}

const SUPABASE_REQUEST_TIMEOUT_MS = 15_000;

function supabaseFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const timeout = AbortSignal.timeout(SUPABASE_REQUEST_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  // Supabase JS/PostgREST uses this for Auth and database HTTP calls. Keep the timeout signal
  // attached after headers arrive as well, so a stalled response body is bounded too.
  return fetch(input, { ...init, signal });
}

export function getSupabasePublicConfig() {
  return {
    url: required('NEXT_PUBLIC_SUPABASE_URL'),
    anonKey: required('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
  };
}

export async function createSupabaseServer() {
  const { url, anonKey } = getSupabasePublicConfig();
  const cookieStore = await cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Server Components cannot mutate cookies; the auth middleware/API refreshes them.
        }
      },
    },
    global: { fetch: supabaseFetch },
  });
}

export function createSupabaseAdmin() {
  return createClient(
    required('NEXT_PUBLIC_SUPABASE_URL'),
    required('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: { fetch: supabaseFetch },
    },
  );
}
