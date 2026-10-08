/**
 * Admin review + FINAL APPROVAL workflow tests against the real route handlers:
 *
 *   - admin authentication and authorization (viewer/operator/admin separation)
 *   - final approval: explicit confirmation, consent/processing validation, idempotency,
 *     immutable audit events
 *   - rejection, review actions, archival
 *   - publication: APPROVED -> PUBLISHED only, media-library registration, public visibility
 *     toggling, unpublish guards
 *   - client-side approval flags can never authorize publication
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createFakeDb, type Row } from './helpers/fake-db';
import { startFakeStorage } from './helpers/fake-storage';
import { CONSENT_TEXT_AR, CONSENT_VERSION } from '../lib/shared/submissions';

/* ------------------------------------------------------------------ seams */

const ADMIN_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const OPERATOR_ID = 'aaaaaaaa-0000-4000-8000-000000000002';
const VIEWER_ID = 'aaaaaaaa-0000-4000-8000-000000000003';

let db = createFakeDb();
let currentUser: { id: string } | null = { id: ADMIN_ID };
let mediaUsage = 0;

/** Mock media optimization so reprocess tests do not need ffmpeg/storage. It mirrors the
 * real processSubmissionMedia contract: PROCESSING -> READY_FOR_REVIEW + audit event. */
const processMediaMock = vi.fn(async (database: any, submission: any) => {
  const now = new Date().toISOString();
  const { data: updated, error } = await database.from('submissions').update({
    state: 'READY_FOR_REVIEW',
    processing_status: 'completed',
    processing_error: null,
    processing_completed_at: now,
    updated_at: now,
  }).eq('id', submission.id).eq('state', 'PROCESSING').select('*').maybeSingle();
  if (error) throw error;
  await database.from('submission_events').insert({
    submission_id: submission.id,
    event: 'PROCESSING_COMPLETED',
    actor_role: 'system',
    state_after: 'READY_FOR_REVIEW',
    details: { version: submission.version },
  });
  return { ok: true, submission: updated };
});

vi.mock('@/lib/server/supabase', () => ({
  createSupabaseServer: () => ({ auth: { getUser: async () => ({ data: { user: currentUser }, error: null }) } }),
  createSupabaseAdmin: () => db,
  getSupabasePublicConfig: () => ({ url: 'http://supabase.test', anonKey: 'anon' }),
}));

vi.mock('@/lib/server/media-optimization', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  processSubmissionMedia: (...args: unknown[]) => processMediaMock(...(args as [any, any])),
}));

import { GET as listSubmissions } from '../app/api/admin/submissions/route';
import { GET as getSubmission } from '../app/api/admin/submissions/[id]/route';
import { POST as approve } from '../app/api/admin/submissions/[id]/approve/route';
import { POST as reject } from '../app/api/admin/submissions/[id]/reject/route';
import { POST as review } from '../app/api/admin/submissions/[id]/review/route';
import { POST as publish } from '../app/api/admin/submissions/[id]/publish/route';
import { POST as unpublish } from '../app/api/admin/submissions/[id]/unpublish/route';
import { POST as archive } from '../app/api/admin/submissions/[id]/archive/route';
import { POST as reprocess } from '../app/api/admin/submissions/[id]/reprocess/route';
import { GET as submissionLinks, POST as createLink, PATCH as updateLink } from '../app/api/admin/submission-links/route';
import { GET as publicMedia } from '../app/api/public/submissions/[id]/media/route';
import { GET as publicMeta } from '../app/api/public/submissions/[id]/route';

/* ------------------------------------------------------------------ fixtures */

const SUBMISSION_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const OPTIMIZED_SHA = createHash('sha256').update('optimized-web-bytes').digest('hex');

function seedProfiles() {
  db.state.profiles = [
    { id: ADMIN_ID, role: 'admin', disabled: false },
    { id: OPERATOR_ID, role: 'operator', disabled: false },
    { id: VIEWER_ID, role: 'viewer', disabled: false },
  ];
}

function seedSubmission(overrides: Row = {}) {
  const row: Row = {
    id: SUBMISSION_ID,
    link_id: 'link-1',
    title: 'فيديو توعوي',
    description: '',
    contributor_name: 'سارة',
    contributor_contact: 'sara@example.org',
    state: 'READY_FOR_REVIEW',
    version: 1,
    consent_accepted: true,
    consent_text: CONSENT_TEXT_AR,
    consent_version: CONSENT_VERSION,
    consent_at: new Date().toISOString(),
    kind: 'image',
    mime_type: 'image/png',
    original_storage_path: `submissions/${SUBMISSION_ID}/original`,
    file_size: 1000,
    sha256: createHash('sha256').update('original-bytes').digest('hex'),
    width: 800,
    height: 600,
    duration_ms: null,
    processing_status: 'completed',
    processing_error: null,
    processing_attempts: 1,
    optimized_storage_path: `submissions/${SUBMISSION_ID}/optimized-v1.webp`,
    optimized_mime_type: 'image/webp',
    optimized_file_size: 500,
    optimized_sha256: OPTIMIZED_SHA,
    thumbnail_storage_path: `submissions/${SUBMISSION_ID}/thumbnail-v1.webp`,
    thumbnail_mime_type: 'image/webp',
    thumbnail_file_size: 100,
    reviewed_by: null,
    reviewed_at: null,
    review_notes: null,
    approved_by: null,
    approved_at: null,
    approved_version: null,
    rejection_reason: null,
    published_media_id: null,
    published_by: null,
    published_at: null,
    unpublished_at: null,
    archived_at: null,
    ip_hash: 'abc123',
    user_agent: 'test-agent',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
  const existing = db.state.submissions.findIndex((entry: Row) => entry.id === row.id);
  if (existing >= 0) db.state.submissions[existing] = row;
  else db.state.submissions.push(row);
  return row;
}

function request(path: string, init: { method?: string; body?: unknown; user?: { id: string } | null; role?: 'admin' | 'operator' | 'viewer' } = {}) {
  currentUser = init.user === undefined ? { id: ADMIN_ID } : init.user;
  return new NextRequest(`http://localhost${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      origin: 'http://localhost',
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

function ctx(id = SUBMISSION_ID) {
  return { params: Promise.resolve({ id }) };
}

function eventsFor(id = SUBMISSION_ID) {
  return db.state.submission_events.filter((event: Row) => event.submission_id === id);
}

let storage: Awaited<ReturnType<typeof startFakeStorage>>;

beforeAll(async () => {
  storage = await startFakeStorage();
  process.env.SUPABASE_S3_ENDPOINT = storage.endpoint;
  process.env.SUPABASE_S3_REGION = 'us-east-1';
  process.env.SUPABASE_S3_ACCESS_KEY_ID = 'fake-access-key';
  process.env.SUPABASE_S3_SECRET_ACCESS_KEY = 'fake-secret-key';
  process.env.SIGNAGE_STORAGE_BUCKET = 'signage-media';
});

afterAll(async () => {
  await new Promise(resolve => storage.server.close(resolve));
});

beforeEach(() => {
  db = createFakeDb();
  seedProfiles();
  seedSubmission();
  // The optimized delivery object exists in storage (500 bytes, matching the fixture).
  storage.objects.set(`submissions/${SUBMISSION_ID}/optimized-v1.webp`, {
    bytes: new Uint8Array(500).fill(0x52),
    contentType: 'image/webp',
    cacheControl: 'public, max-age=31536000, immutable',
  });
  storage.objects.set(`submissions/${SUBMISSION_ID}/thumbnail-v1.webp`, {
    bytes: new Uint8Array(100).fill(0x54),
    contentType: 'image/webp',
  });
  mediaUsage = 0;
  processMediaMock.mockClear();
  db.setRpc('consume_submission_rate_limit', () => true);
  db.setRpc('get_media_usage_counts', (args: any) => (args.p_media_ids as string[]).map(media_id => ({ media_id, usage_count: mediaUsage })));
});

/* ------------------------------------------------------------------ authentication & authorization */

describe('admin authentication and authorization', () => {
  it('rejects unauthenticated approval attempts', async () => {
    const response = await approve(request(`/api/admin/submissions/${SUBMISSION_ID}/approve`, { method: 'POST', body: { confirm: true }, user: null }), ctx());
    expect(response.status).toBe(401);
  });

  it('rejects cross-origin approval attempts', async () => {
    const req = new NextRequest(`http://localhost/api/admin/submissions/${SUBMISSION_ID}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ confirm: true }),
    });
    const response = await approve(req, ctx());
    expect(response.status).toBe(403);
  });

  it('forbids viewers and operators from final approval (FINAL APPROVER = admin only)', async () => {
    const asViewer = await approve(request(`/api/admin/submissions/${SUBMISSION_ID}/approve`, { method: 'POST', body: { confirm: true }, user: { id: VIEWER_ID }, role: 'viewer' }), ctx());
    expect(asViewer.status).toBe(403);
    const asOperator = await approve(request(`/api/admin/submissions/${SUBMISSION_ID}/approve`, { method: 'POST', body: { confirm: true }, user: { id: OPERATOR_ID }, role: 'operator' }), ctx());
    expect(asOperator.status).toBe(403);
    expect((await asOperator.json()).code).toBe('approver_required');
    expect(db.state.submissions[0].state).toBe('READY_FOR_REVIEW');
  });

  it('allows operators to review but not to publish', async () => {
    const started = await review(request(`/api/admin/submissions/${SUBMISSION_ID}/review`, { method: 'POST', body: { action: 'start' }, user: { id: OPERATOR_ID }, role: 'operator' }), ctx());
    expect(started.status).toBe(200);
    expect(db.state.submissions[0].state).toBe('UNDER_REVIEW');
    const publishAttempt = await publish(request(`/api/admin/submissions/${SUBMISSION_ID}/publish`, { method: 'POST', body: { confirm: true }, user: { id: OPERATOR_ID }, role: 'operator' }), ctx());
    expect(publishAttempt.status).toBe(403);
  });
});

/* ------------------------------------------------------------------ final approval */

describe('final admin approval', () => {
  it('requires an explicit confirmation (the UI dialog is enforced server-side)', async () => {
    const missing = await approve(request(`/api/admin/submissions/${SUBMISSION_ID}/approve`, { method: 'POST', body: {} }), ctx());
    expect(missing.status).toBe(400);
    expect((await missing.json()).code).toBe('confirmation_required');
    const wrongFlag = await approve(request(`/api/admin/submissions/${SUBMISSION_ID}/approve`, { method: 'POST', body: { confirm: 'yes' } }), ctx());
    expect(wrongFlag.status).toBe(400);
  });

  it('never trusts client-side approval flags', async () => {
    const response = await approve(request(`/api/admin/submissions/${SUBMISSION_ID}/approve`, { method: 'POST', body: { isApproved: true, state: 'APPROVED', approved: true } }), ctx());
    expect(response.status).toBe(400);
    expect(db.state.submissions[0].state).toBe('READY_FOR_REVIEW');
  });

  it('approves: records admin, timestamp, version, moves to APPROVED and writes one audit event', async () => {
    const response = await approve(request(`/api/admin/submissions/${SUBMISSION_ID}/approve`, { method: 'POST', body: { confirm: true } }), ctx());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.message).toBe('تم اعتماد المشاركة نهائيًا.');
    expect(body.alreadyApproved).toBe(false);
    const submission = db.state.submissions[0];
    expect(submission.state).toBe('APPROVED');
    expect(submission.approved_by).toBe(ADMIN_ID);
    expect(submission.approved_version).toBe(1);
    expect(submission.approved_at).toBeTruthy();
    // The submission is eligible for publication but NOT published and NOT public.
    expect(submission.state).not.toBe('PUBLISHED');
    const approvalEvents = eventsFor().filter((event: Row) => event.event === 'APPROVED');
    expect(approvalEvents).toHaveLength(1);
    expect(approvalEvents[0].actor_user_id).toBe(ADMIN_ID);
    expect(approvalEvents[0].actor_role).toBe('admin');
    expect(approvalEvents[0].state_after).toBe('APPROVED');
    expect(approvalEvents[0].details.submissionVersion).toBe(1);
    expect(approvalEvents[0].details.consentVersion).toBe(CONSENT_VERSION);
  });

  it('is idempotent: repeated approval clicks return the same approval without duplicate audit events', async () => {
    const first = await approve(request(`/api/admin/submissions/${SUBMISSION_ID}/approve`, { method: 'POST', body: { confirm: true } }), ctx());
    const second = await approve(request(`/api/admin/submissions/${SUBMISSION_ID}/approve`, { method: 'POST', body: { confirm: true } }), ctx());
    const third = await approve(request(`/api/admin/submissions/${SUBMISSION_ID}/approve`, { method: 'POST', body: { confirm: true } }), ctx());
    const firstBody = await first.json();
    const secondBody = await second.json();
    const thirdBody = await third.json();
    expect(firstBody.alreadyApproved).toBe(false);
    expect(secondBody.alreadyApproved).toBe(true);
    expect(thirdBody.alreadyApproved).toBe(true);
    const submission = db.state.submissions[0];
    expect(submission.state).toBe('APPROVED');
    expect(eventsFor().filter((event: Row) => event.event === 'APPROVED')).toHaveLength(1);
    // Same approval timestamp (the original one is returned, not a new approval).
    expect(secondBody.submission.approved_at).toBe(firstBody.submission.approved_at);
  });

  it('refuses approval when contributor consent is missing', async () => {
    seedSubmission({ consent_accepted: false, consent_text: null, consent_version: null });
    const response = await approve(request(`/api/admin/submissions/${SUBMISSION_ID}/approve`, { method: 'POST', body: { confirm: true } }), ctx());
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('consent_missing');
    expect(db.state.submissions[0].state).toBe('READY_FOR_REVIEW');
  });

  it('refuses approval when media processing failed or is incomplete', async () => {
    seedSubmission({ processing_status: 'failed', processing_error: 'boom' });
    const failed = await approve(request(`/api/admin/submissions/${SUBMISSION_ID}/approve`, { method: 'POST', body: { confirm: true } }), ctx());
    expect(failed.status).toBe(409);
    expect((await failed.json()).code).toBe('processing_incomplete');

    seedSubmission({ processing_status: 'completed', optimized_storage_path: null });
    const noOptimized = await approve(request(`/api/admin/submissions/${SUBMISSION_ID}/approve`, { method: 'POST', body: { confirm: true } }), ctx());
    expect(noOptimized.status).toBe(409);
  });

  it('refuses approval from terminal or invalid states', async () => {
    seedSubmission({ state: 'ARCHIVED' });
    const response = await approve(request(`/api/admin/submissions/${SUBMISSION_ID}/approve`, { method: 'POST', body: { confirm: true } }), ctx());
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('invalid_state_transition');
  });
});

/* ------------------------------------------------------------------ review actions */

describe('review actions', () => {
  it('start review -> UNDER_REVIEW with REVIEW_STARTED audit', async () => {
    const response = await review(request(`/api/admin/submissions/${SUBMISSION_ID}/review`, { method: 'POST', body: { action: 'start' }, user: { id: OPERATOR_ID }, role: 'operator' }), ctx());
    expect(response.status).toBe(200);
    expect(db.state.submissions[0].state).toBe('UNDER_REVIEW');
    expect(db.state.submissions[0].reviewed_by).toBe(OPERATOR_ID);
    expect(eventsFor().map((event: Row) => event.event)).toContain('REVIEW_STARTED');
  });

  it('request changes -> back to READY_FOR_REVIEW with notes', async () => {
    seedSubmission({ state: 'UNDER_REVIEW' });
    const response = await review(request(`/api/admin/submissions/${SUBMISSION_ID}/review`, { method: 'POST', body: { action: 'request_changes', notes: 'عدّل العنوان' } }), ctx());
    expect(response.status).toBe(200);
    expect(db.state.submissions[0].state).toBe('READY_FOR_REVIEW');
    expect(db.state.submissions[0].review_notes).toBe('عدّل العنوان');
    expect(eventsFor().map((event: Row) => event.event)).toContain('CHANGES_REQUESTED');
  });

  it('rejects with a reason (final approver only) and audits it', async () => {
    const asOperator = await reject(request(`/api/admin/submissions/${SUBMISSION_ID}/reject`, { method: 'POST', body: { reason: 'غير مناسب' }, user: { id: OPERATOR_ID }, role: 'operator' }), ctx());
    expect(asOperator.status).toBe(403);
    const noReason = await reject(request(`/api/admin/submissions/${SUBMISSION_ID}/reject`, { method: 'POST', body: {} }), ctx());
    expect(noReason.status).toBe(400);
    const response = await reject(request(`/api/admin/submissions/${SUBMISSION_ID}/reject`, { method: 'POST', body: { reason: 'المحتوى غير مناسب' } }), ctx());
    expect(response.status).toBe(200);
    expect(db.state.submissions[0].state).toBe('REJECTED');
    expect(db.state.submissions[0].rejection_reason).toBe('المحتوى غير مناسب');
    const rejected = eventsFor().filter((event: Row) => event.event === 'REJECTED');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].details.reason).toBe('المحتوى غير مناسب');
  });

  it('archives submissions and audits it', async () => {
    const response = await archive(request(`/api/admin/submissions/${SUBMISSION_ID}/archive`, { method: 'POST' }), ctx());
    expect(response.status).toBe(200);
    expect(db.state.submissions[0].state).toBe('ARCHIVED');
    expect(db.state.submissions[0].archived_at).toBeTruthy();
    expect(eventsFor().map((event: Row) => event.event)).toContain('ARCHIVED');
  });

  it('refuses to archive a published submission (unpublish first)', async () => {
    seedSubmission({ state: 'PUBLISHED', published_media_id: 'media-1' });
    const response = await archive(request(`/api/admin/submissions/${SUBMISSION_ID}/archive`, { method: 'POST' }), ctx());
    expect(response.status).toBe(409);
  });
});

/* ------------------------------------------------------------------ publication & public visibility */

describe('publication and public visibility', () => {
  async function approveFirst() {
    const response = await approve(request(`/api/admin/submissions/${SUBMISSION_ID}/approve`, { method: 'POST', body: { confirm: true } }), ctx());
    expect(response.status).toBe(200);
  }

  it('refuses to publish before final approval', async () => {
    const response = await publish(request(`/api/admin/submissions/${SUBMISSION_ID}/publish`, { method: 'POST', body: { confirm: true } }), ctx());
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('not_approved');
    expect(db.state.submissions[0].state).toBe('READY_FOR_REVIEW');
  });

  it('publishes an approved submission: media-library registration + PUBLISHED + audit', async () => {
    await approveFirst();
    const response = await publish(request(`/api/admin/submissions/${SUBMISSION_ID}/publish`, { method: 'POST', body: { confirm: true } }), ctx());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.message).toBe('تم نشر المشاركة.');
    const submission = db.state.submissions[0];
    expect(submission.state).toBe('PUBLISHED');
    expect(submission.published_by).toBe(ADMIN_ID);
    expect(submission.published_at).toBeTruthy();
    // The optimized delivery version is registered in the media library for playlists/player.
    expect(db.state.media).toHaveLength(1);
    const media = db.state.media[0];
    expect(media.storage_path).toBe(submission.optimized_storage_path);
    expect(media.sha256).toBe(OPTIMIZED_SHA);
    expect(media.mime_type).toBe('image/webp');
    expect(media.metadata.source).toBe('public-submission');
    expect(media.metadata.submissionId).toBe(SUBMISSION_ID);
    expect(submission.published_media_id).toBe(media.id);
    expect(eventsFor().map((event: Row) => event.event)).toContain('PUBLISHED');
  });

  it('publish is idempotent', async () => {
    await approveFirst();
    await publish(request(`/api/admin/submissions/${SUBMISSION_ID}/publish`, { method: 'POST', body: { confirm: true } }), ctx());
    const again = await publish(request(`/api/admin/submissions/${SUBMISSION_ID}/publish`, { method: 'POST', body: { confirm: true } }), ctx());
    expect(again.status).toBe(200);
    expect((await again.json()).alreadyPublished).toBe(true);
    expect(db.state.media).toHaveLength(1);
    expect(eventsFor().filter((event: Row) => event.event === 'PUBLISHED')).toHaveLength(1);
  });

  it('serves optimized media publicly only while PUBLISHED (immutable cache, range support)', async () => {
    // Before approval: invisible.
    let response = await publicMedia(request(`/api/public/submissions/${SUBMISSION_ID}/media`), ctx());
    expect(response.status).toBe(404);
    // Approved but not published: still invisible.
    await approveFirst();
    response = await publicMedia(request(`/api/public/submissions/${SUBMISSION_ID}/media`), ctx());
    expect(response.status).toBe(404);
    const metaBefore = await publicMeta(request(`/api/public/submissions/${SUBMISSION_ID}`), ctx());
    expect(metaBefore.status).toBe(404);
    // Published: visible.
    await publish(request(`/api/admin/submissions/${SUBMISSION_ID}/publish`, { method: 'POST', body: { confirm: true } }), ctx());
    response = await publicMedia(request(`/api/public/submissions/${SUBMISSION_ID}/media`), ctx());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect((await response.arrayBuffer()).byteLength).toBe(500);
    // HTTP Range support for video-style seeking.
    const ranged = await publicMedia(new NextRequest(`http://localhost/api/public/submissions/${SUBMISSION_ID}/media`, { headers: { range: 'bytes=0-99' } }), ctx());
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe('bytes 0-99/500');
    // The thumbnail variant is public too.
    const thumb = await publicMedia(request(`/api/public/submissions/${SUBMISSION_ID}/media?variant=thumbnail`), ctx());
    expect(thumb.status).toBe(200);
    expect((await thumb.arrayBuffer()).byteLength).toBe(100);
    const meta = await publicMeta(request(`/api/public/submissions/${SUBMISSION_ID}`), ctx());
    expect(meta.status).toBe(200);
    const metaBody = await meta.json();
    expect(metaBody.submission.title).toBe('فيديو توعوي');
    // Contributor contact information is never exposed publicly.
    expect(JSON.stringify(metaBody)).not.toContain('sara@example.org');
    expect(JSON.stringify(metaBody)).not.toContain('contributor');
  });

  it('unpublish hides the content again and removes the unused library media', async () => {
    await approveFirst();
    await publish(request(`/api/admin/submissions/${SUBMISSION_ID}/publish`, { method: 'POST', body: { confirm: true } }), ctx());
    const response = await unpublish(request(`/api/admin/submissions/${SUBMISSION_ID}/unpublish`, { method: 'POST', body: { confirm: true } }), ctx());
    expect(response.status).toBe(200);
    const submission = db.state.submissions[0];
    expect(submission.state).toBe('APPROVED');
    expect(submission.published_media_id ?? null).toBeNull();
    expect(db.state.media).toHaveLength(0);
    expect(eventsFor().map((event: Row) => event.event)).toContain('UNPUBLISHED');
    const mediaResponse = await publicMedia(request(`/api/public/submissions/${SUBMISSION_ID}/media`), ctx());
    expect(mediaResponse.status).toBe(404);
  });

  it('refuses unpublish while the published media is used in playlists', async () => {
    await approveFirst();
    await publish(request(`/api/admin/submissions/${SUBMISSION_ID}/publish`, { method: 'POST', body: { confirm: true } }), ctx());
    mediaUsage = 2;
    const response = await unpublish(request(`/api/admin/submissions/${SUBMISSION_ID}/unpublish`, { method: 'POST', body: { confirm: true } }), ctx());
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('media_in_use');
    expect(db.state.submissions[0].state).toBe('PUBLISHED');
  });
});

/* ------------------------------------------------------------------ processing retry */

describe('processing failure recovery', () => {
  it('reprocess bumps the version, clears the approval and re-runs processing (safe retry)', async () => {
    seedSubmission({ state: 'REJECTED', processing_status: 'failed', processing_error: 'boom', version: 1 });
    const response = await reprocess(request(`/api/admin/submissions/${SUBMISSION_ID}/reprocess`, { method: 'POST' }), ctx());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.processing).toBe('completed');
    const submission = db.state.submissions[0];
    expect(submission.version).toBe(2);
    expect(submission.processing_attempts).toBe(2);
    expect(submission.processing_error).toBeNull();
    expect(eventsFor().map((event: Row) => event.event)).toContain('PROCESSING_STARTED');
    expect(eventsFor().map((event: Row) => event.event)).toContain('PROCESSING_COMPLETED');
  });

  it('refuses reprocessing an approved submission', async () => {
    seedSubmission({ state: 'APPROVED', approved_by: ADMIN_ID, approved_at: new Date().toISOString(), approved_version: 1 });
    const response = await reprocess(request(`/api/admin/submissions/${SUBMISSION_ID}/reprocess`, { method: 'POST' }), ctx());
    expect(response.status).toBe(409);
  });
});

/* ------------------------------------------------------------------ queue, detail, links */

describe('queue, detail and submission links', () => {
  it('lists the queue with per-filter counts', async () => {
    seedSubmission({ id: 'cccccccc-0000-4000-8000-000000000001', state: 'REJECTED', title: 'مرفوضة' });
    const response = await listSubmissions(request('/api/admin/submissions?filter=ready'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.submissions).toHaveLength(1);
    expect(body.submissions[0].id).toBe(SUBMISSION_ID);
    expect(body.filterCounts.ready).toBe(1);
    expect(body.filterCounts.rejected).toBe(1);
    expect(body.filterCounts.approved).toBe(0);
  });

  it('detail returns the submission with its full audit history', async () => {
    const response = await getSubmission(request(`/api/admin/submissions/${SUBMISSION_ID}`), ctx());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.submission.id).toBe(SUBMISSION_ID);
    expect(body.submission.consent_text).toBe(CONSENT_TEXT_AR);
    expect(Array.isArray(body.events)).toBe(true);
  });

  it('creates a public submission link (token shown once) and manages it', async () => {
    const created = await createLink(request('/api/admin/submission-links', { method: 'POST', body: { label: 'حملة 2026' } }));
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.url).toMatch(/^http:\/\/localhost\/submit\/[A-Za-z0-9_-]{43}$/);
    expect(body.token).toHaveLength(43);
    expect(db.state.submission_links).toHaveLength(1);
    // Only the hash is stored.
    expect(db.state.submission_links[0].token_hash).toBe(createHash('sha256').update(body.token).digest('hex'));
    expect(db.state.submission_links[0].token_hash).not.toBe(body.token);

    // Operators cannot create links.
    const denied = await createLink(request('/api/admin/submission-links', { method: 'POST', body: { label: 'x' }, user: { id: OPERATOR_ID }, role: 'operator' }));
    expect(denied.status).toBe(403);

    // Listing never returns raw tokens.
    const list = await submissionLinks(request('/api/admin/submission-links'));
    const listBody = await list.json();
    expect(listBody.links).toHaveLength(1);
    expect(JSON.stringify(listBody)).not.toContain(body.token);

    // Revoke.
    const linkId = db.state.submission_links[0].id;
    const patched = await updateLink(request('/api/admin/submission-links', { method: 'PATCH', body: { id: linkId, active: false } }));
    expect(patched.status).toBe(200);
    expect(db.state.submission_links[0].active).toBe(false);
  });
});
