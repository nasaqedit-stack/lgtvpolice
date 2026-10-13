/*
 * Verification of GitHub Actions OIDC identity tokens.
 *
 * Why this exists: the production database is only reachable from the application itself (RLS
 * denies every public read and the service role key never leaves Vercel). A CI job therefore
 * cannot read the state of a paired television. Instead of inventing a shared secret, the
 * diagnostic route authenticates the CALLER with the short-lived, signed identity token GitHub
 * issues to every workflow run (`permissions: id-token: write`). The token is verified here
 * against GitHub's public JWKS, so nothing secret is stored in the repository and nothing is
 * transmitted that could be replayed later.
 *
 * Verification is deliberately strict:
 *   - RS256 only, key selected by `kid` from GitHub's JWKS (refreshed, never pinned statically).
 *   - `iss` must be GitHub's OIDC issuer.
 *   - `aud` must be the audience this deployment expects.
 *   - `repository` / `repository_owner` must match the allow list (a fork or another repository
 *     gets a valid GitHub token, but must never be able to read this deployment's data).
 *   - `exp` / `iat` bounds keep a stolen token useful for minutes, not forever.
 */
import { createPublicKey, createVerify, type JsonWebKey, type KeyObject } from 'node:crypto';
import { HttpError } from '@/lib/server/http';

export const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
export const GITHUB_OIDC_JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;

/** A token older than this (issued-at) is refused even if `exp` is far in the future. */
export const OIDC_MAX_AGE_MS = 60 * 60_000;
/** Clock skew tolerated in both directions when checking `exp`/`nbf`. */
export const OIDC_SKEW_MS = 60_000;

export type OidcJwks = Map<string, JsonWebKey>;

export type GitHubOidcClaims = {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  repository?: string;
  repository_owner?: string;
  repository_owner_id?: string;
  workflow_ref?: string;
  job_workflow_ref?: string;
  event_name?: string;
  ref?: string;
  [key: string]: unknown;
};

export type VerifiedOidcIdentity = {
  subject: string | null;
  repository: string | null;
  repositoryOwner: string | null;
  workflowRef: string | null;
  claims: GitHubOidcClaims;
};

let cachedJwks: { url: string; at: number; keys: OidcJwks } | null = null;
const JWKS_TTL_MS = 6 * 60 * 60_000;

export function resetJwksCache(): void {
  cachedJwks = null;
}

/**
 * Fetches GitHub's OIDC signing keys. Cached per serverless instance; a `kid` the cache does not
 * know forces one refresh so a key rotation can never wedge the endpoint.
 */
export async function fetchGitHubJwks(
  url: string = GITHUB_OIDC_JWKS_URL,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = (input, init) => fetch(input, init),
): Promise<OidcJwks> {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new HttpError(502, 'تعذر جلب مفاتيح التوثيق.', 'oidc_jwks_unreachable');
  let body: { keys?: JsonWebKey[] } | null = null;
  try { body = await response.json() as { keys?: JsonWebKey[] }; } catch { body = null; }
  const keys = new Map<string, JsonWebKey>();
  const list = Array.isArray(body?.keys) ? body!.keys! : [];
  for (const key of list) {
    if (key && typeof key.kid === 'string' && key.kty === 'RSA') keys.set(key.kid, key);
  }
  if (!keys.size) throw new HttpError(502, 'مفاتيح التوثيق غير صالحة.', 'oidc_jwks_invalid');
  cachedJwks = { url, at: Date.now(), keys };
  return keys;
}

async function resolveJwks(kid: string, options: { url?: string; fetchImpl?: (input: string, init?: RequestInit) => Promise<Response> } = {}): Promise<JsonWebKey | null> {
  const fresh = cachedJwks && Date.now() - cachedJwks.at < JWKS_TTL_MS && cachedJwks.url === (options.url || GITHUB_OIDC_JWKS_URL);
  if (fresh && cachedJwks!.keys.has(kid)) return cachedJwks!.keys.get(kid)!;
  const keys = await fetchGitHubJwks(options.url, options.fetchImpl);
  return keys.get(kid) || null;
}

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const json = Buffer.from(segment, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function audienceMatches(claim: unknown, expected: string): boolean {
  if (typeof claim === 'string') return claim === expected;
  if (Array.isArray(claim)) return claim.some(value => value === expected);
  return false;
}

/**
 * Verifies one GitHub Actions OIDC token.
 *
 * `options.jwks` (a `kid -> JWK` map) makes this pure and lets the test suite exercise every
 * rejection path without network access.
 */
export async function verifyGitHubOidcToken(token: string, options: {
  audience: string;
  repositories: string[];
  now?: number;
  jwks?: OidcJwks;
  jwksUrl?: string;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}): Promise<VerifiedOidcIdentity> {
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new HttpError(401, 'رمز الهوية غير صالح.', 'oidc_malformed');
  }
  const header = decodeSegment(parts[0]);
  const claims = decodeSegment(parts[1]) as GitHubOidcClaims | null;
  if (!header || !claims) throw new HttpError(401, 'رمز الهوية غير صالح.', 'oidc_malformed');
  // Only RS256 with a declared key id: `none`, HS256 (using the public key as an HMAC secret) and
  // algorithm confusion are all refused before any cryptographic work happens.
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
    throw new HttpError(401, 'خوارزمية توقيع الهوية غير مدعومة.', 'oidc_bad_algorithm');
  }
  let jwk: JsonWebKey | null = null;
  if (options.jwks) jwk = options.jwks.get(header.kid) || null;
  else jwk = await resolveJwks(header.kid, { url: options.jwksUrl, fetchImpl: options.fetchImpl });
  if (!jwk) throw new HttpError(401, 'مفتاح توقيع الهوية غير معروف.', 'oidc_unknown_key');

  let publicKey: KeyObject;
  try { publicKey = createPublicKey({ key: jwk, format: 'jwk' }); }
  catch { throw new HttpError(401, 'مفتاح توقيع الهوية غير صالح.', 'oidc_bad_key'); }
  if (publicKey.asymmetricKeyType !== 'rsa') throw new HttpError(401, 'مفتاح توقيع الهوية غير صالح.', 'oidc_bad_key');

  const signingInput = `${parts[0]}.${parts[1]}`;
  let valid = false;
  try {
    valid = createVerify('RSA-SHA256').update(signingInput).verify(publicKey, Buffer.from(parts[2], 'base64url'));
  } catch { valid = false; }
  if (!valid) throw new HttpError(401, 'توقيع الهوية غير صالح.', 'oidc_bad_signature');

  if (claims.iss !== GITHUB_OIDC_ISSUER) throw new HttpError(403, 'جهة إصدار الهوية غير موثوقة.', 'oidc_bad_issuer');
  if (!audienceMatches(claims.aud, options.audience)) throw new HttpError(403, 'جمهور الهوية غير مطابق.', 'oidc_bad_audience');
  if (typeof claims.exp !== 'number' || now - OIDC_SKEW_MS > claims.exp * 1000) {
    throw new HttpError(401, 'انتهت صلاحية رمز الهوية.', 'oidc_expired');
  }
  if (typeof claims.nbf === 'number' && now + OIDC_SKEW_MS < claims.nbf * 1000) {
    throw new HttpError(401, 'رمز الهوية غير ساري بعد.', 'oidc_not_yet_valid');
  }
  if (typeof claims.iat !== 'number' || now - claims.iat * 1000 > OIDC_MAX_AGE_MS) {
    throw new HttpError(401, 'رمز الهوية قديم.', 'oidc_stale');
  }
  const repository = typeof claims.repository === 'string' ? claims.repository : null;
  if (!repository || !options.repositories.includes(repository)) {
    throw new HttpError(403, 'مستودع الهوية غير مسموح.', 'oidc_repository_denied');
  }
  const owner = typeof claims.repository_owner === 'string' ? claims.repository_owner : null;
  const expectedOwners = options.repositories.map(value => value.split('/')[0]);
  if (!owner || !expectedOwners.includes(owner)) throw new HttpError(403, 'مالك الهوية غير مسموح.', 'oidc_owner_denied');

  return {
    subject: typeof claims.sub === 'string' ? claims.sub : null,
    repository,
    repositoryOwner: owner,
    workflowRef: typeof claims.job_workflow_ref === 'string'
      ? claims.job_workflow_ref
      : (typeof claims.workflow_ref === 'string' ? claims.workflow_ref : null),
    claims,
  };
}

/** Reads `Authorization: Bearer <token>` and verifies it against the configured policy. */
export async function requireGitHubOidc(request: Request): Promise<VerifiedOidcIdentity> {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(\S+)$/.exec(header.trim());
  if (!match) throw new HttpError(401, 'يلزم تقديم هوية CI صالحة.', 'oidc_missing');
  const audience = process.env.DEVICE_DIAG_AUDIENCE || 'lgtvpolice-device-diag';
  const configured = (process.env.DEVICE_DIAG_REPOSITORIES || 'nasaqedit-stack/lgtvpolice')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  return verifyGitHubOidcToken(match[1], { audience, repositories: configured });
}
