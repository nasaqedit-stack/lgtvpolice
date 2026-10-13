import { NextResponse, type NextRequest } from 'next/server';
import { errorResponse, HttpError } from '@/lib/server/http';
import { requireGitHubOidc } from '@/lib/server/github-oidc';
import { readDeviceStatus } from '@/lib/server/device-status';
import { createSupabaseAdmin } from '@/lib/server/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/*
 * Read-only device diagnostics for CI.
 *
 * The production database is unreachable from anywhere but the application itself: RLS denies
 * every public read and the service role key stays on the server. A GitHub Actions workflow can
 * therefore never inspect the state of a paired television — which is exactly the evidence needed
 * to prove a player fix reached a real device.
 *
 * Instead of a shared secret (which would have to be stored in the repository or pasted into a
 * chat), this route authenticates the caller with the signed, short-lived OIDC identity token that
 * GitHub issues to every workflow run. The token is verified against GitHub's public JWKS and must
 * name this repository, so a fork, another project, or anyone without write access to this
 * repository is refused. See lib/server/github-oidc.ts for the exact checks.
 *
 * The response is a redacted snapshot: operational state only, no credentials, no tokens, no
 * signed URLs, no download links. Nothing here mutates anything.
 *
 * Remove it with `DEVICE_DIAG_DISABLED=1` (or delete the directory) — no other code depends on it.
 */

async function handle(request: NextRequest) {
  try {
    if (process.env.DEVICE_DIAG_DISABLED === '1') {
      throw new HttpError(404, 'غير متوفر.', 'not_found');
    }
    const identity = await requireGitHubOidc(request);
    const db = createSupabaseAdmin();
    const status = await readDeviceStatus(db);
    return NextResponse.json({
      ...status,
      caller: {
        repository: identity.repository,
        workflowRef: identity.workflowRef,
        subject: identity.subject,
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error, { route: '/api/diag/device' }); }
}

export async function GET(request: NextRequest) { return handle(request); }
export async function POST(request: NextRequest) { return handle(request); }
