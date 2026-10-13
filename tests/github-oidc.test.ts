/*
 * Verification of GitHub Actions OIDC identity tokens.
 *
 * The diagnostic route is the only way CI can read the state of a paired television, so its
 * authentication has to be airtight: it stands between the public internet and a read-only view of
 * the production database. These tests mint real RSA-signed tokens and walk every rejection path —
 * including the classic JWT attacks (algorithm confusion, `alg: none`, a key that is not the one
 * that signed the token, a valid token from another repository).
 */
import { createSign, generateKeyPairSync, createHash } from 'node:crypto';
import { describe, expect, it, beforeAll } from 'vitest';
import { HttpError } from '@/lib/server/http';
import {
  GITHUB_OIDC_ISSUER,
  OIDC_MAX_AGE_MS,
  verifyGitHubOidcToken,
} from '@/lib/server/github-oidc';

type Pair = { publicJwk: any; privateKey: any };

const REPO = 'nasaqedit-stack/lgtvpolice';
const AUDIENCE = 'lgtvpolice-device-diag';

let pair: Pair;
let otherPair: Pair;
const NOW = 1_800_000_000_000;

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function jwkOf(publicKey: any, kid: string) {
  const jwk = publicKey.export({ format: 'jwk' });
  return { ...jwk, kid, alg: 'RS256', use: 'sig' };
}

function mint(claims: Record<string, unknown>, options: { key?: any; kid?: string; alg?: string; omitSignature?: boolean; fakeSignature?: boolean } = {}) {
  const header = { alg: options.alg || 'RS256', typ: 'JWT', kid: options.kid || 'test-key-1' };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  if (options.omitSignature) return `${signingInput}.`;
  if (options.fakeSignature) return `${signingInput}.${base64url('not-a-real-signature')}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(options.key || pair.privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

function validClaims(overrides: Record<string, unknown> = {}) {
  return {
    iss: GITHUB_OIDC_ISSUER,
    aud: AUDIENCE,
    sub: `repo:${REPO}:environment:Production`,
    repository: REPO,
    repository_owner: 'nasaqedit-stack',
    job_workflow_ref: `${REPO}/.github/workflows/device-status.yml@refs/heads/main`,
    iat: Math.floor(NOW / 1000),
    exp: Math.floor(NOW / 1000) + 300,
    ...overrides,
  };
}

function expectRejection(token: string, code: string, overrides: Record<string, unknown> = {}) {
  return expect(verifyGitHubOidcToken(token, {
    audience: AUDIENCE,
    repositories: [REPO],
    now: NOW,
    jwks: new Map([['test-key-1', pair.publicJwk], ['attacker-key', otherPair.publicJwk]]),
    ...overrides,
  })).rejects.toMatchObject({ code });
}

beforeAll(() => {
  const first = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const second = generateKeyPairSync('rsa', { modulusLength: 2048 });
  pair = { publicJwk: jwkOf(first.publicKey, 'test-key-1'), privateKey: first.privateKey };
  otherPair = { publicJwk: jwkOf(second.publicKey, 'attacker-key'), privateKey: second.privateKey };
});

describe('GitHub Actions OIDC verification', () => {
  it('accepts a token GitHub would issue for this repository', async () => {
    const identity = await verifyGitHubOidcToken(mint(validClaims()), {
      audience: AUDIENCE,
      repositories: [REPO],
      now: NOW,
      jwks: new Map([['test-key-1', pair.publicJwk]]),
    });
    expect(identity.repository).toBe(REPO);
    expect(identity.repositoryOwner).toBe('nasaqedit-stack');
    expect(identity.workflowRef).toContain('device-status.yml');
    expect(identity.subject).toBe(`repo:${REPO}:environment:Production`);
  });

  it('refuses a token whose signature does not match the published key', async () => {
    // Signed with a different key but presented under the legitimate key id.
    await expectRejection(mint(validClaims(), { key: otherPair.privateKey }), 'oidc_bad_signature');
  });

  it('refuses algorithm confusion: the public key used as an HMAC secret', async () => {
    const header = { alg: 'HS256', typ: 'JWT', kid: 'test-key-1' };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(validClaims()))}`;
    const forged = createHash('sha256').update(signingInput).update('public-key-material').digest();
    await expectRejection(`${signingInput}.${base64url(forged)}`, 'oidc_bad_algorithm');
  });

  it('refuses an unsigned token (alg: none)', async () => {
    await expectRejection(mint(validClaims(), { alg: 'none', fakeSignature: true }), 'oidc_bad_algorithm');
    await expectRejection(mint(validClaims(), { alg: 'none', omitSignature: true }), 'oidc_malformed');
  });

  it('refuses a token whose key id the issuer does not publish', async () => {
    await expectRejection(mint(validClaims(), { key: otherPair.privateKey, kid: 'kid-not-in-jwks' }), 'oidc_unknown_key');
  });

  it('refuses a malformed token', async () => {
    await expectRejection('not-a-token', 'oidc_malformed');
    await expectRejection('a.b', 'oidc_malformed');
  });

  it('refuses another issuer even with a valid signature', async () => {
    await expectRejection(mint(validClaims({ iss: 'https://evil.example.com' })), 'oidc_bad_issuer');
  });

  it('refuses a token minted for a different audience', async () => {
    await expectRejection(mint(validClaims({ aud: 'something-else' })), 'oidc_bad_audience');
  });

  it('refuses an expired token (but tolerates a minute of clock skew)', async () => {
    await expectRejection(mint(validClaims({ exp: Math.floor(NOW / 1000) - 3600 })), 'oidc_expired');
    const withinSkew = mint(validClaims({ exp: Math.floor(NOW / 1000) - 30 }));
    await expect(verifyGitHubOidcToken(withinSkew, {
      audience: AUDIENCE, repositories: [REPO], now: NOW,
      jwks: new Map([['test-key-1', pair.publicJwk]])
    })).resolves.toMatchObject({ repository: REPO });
  });

  it('refuses a token that is too old even when exp is far away', async () => {
    const iat = Math.floor((NOW - OIDC_MAX_AGE_MS - 60_000) / 1000);
    await expectRejection(mint(validClaims({ iat, exp: Math.floor(NOW / 1000) + 100_000 })), 'oidc_stale');
  });

  it('refuses a token from a fork of this repository', async () => {
    await expectRejection(mint(validClaims({
      repository: 'someone-else/lgtvpolice',
      repository_owner: 'someone-else',
      sub: 'repo:someone-else/lgtvpolice:ref:refs/heads/main'
    })), 'oidc_repository_denied');
  });

  it('refuses a token whose repository owner does not match the repository claim', async () => {
    await expectRejection(mint(validClaims({ repository_owner: 'nasaqedit-stack-evil' })), 'oidc_owner_denied');
  });

  it('every rejection is an HttpError with a 401 or 403 status, never a 500', async () => {
    const error = await verifyGitHubOidcToken(mint(validClaims({ aud: 'nope' })), {
      audience: AUDIENCE,
      repositories: [REPO],
      now: NOW,
      jwks: new Map([['test-key-1', pair.publicJwk]]),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpError);
    expect([401, 403]).toContain((error as HttpError).status);
  });
});
