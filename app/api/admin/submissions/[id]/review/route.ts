import { NextRequest, NextResponse } from 'next/server';
import { errorResponse, HttpError, readJson } from '@/lib/server/http';
import { loadSubmission, requestChanges, reviewSchema, requireAdmin, startReview } from '@/lib/server/submissions';

export const runtime = 'nodejs';
export const maxDuration = 60;
type Context = { params: Promise<{ id: string }> };

/**
 * Review actions for the ADMIN REVIEWER (admin or operator):
 *   { action: 'start' }            READY_FOR_REVIEW -> UNDER_REVIEW (audit REVIEW_STARTED)
 *   { action: 'request_changes' }  UNDER_REVIEW -> READY_FOR_REVIEW (audit CHANGES_REQUESTED)
 */
export async function POST(request: NextRequest, context: Context) {
  try {
    const { user, role, db } = await requireAdmin(request);
    const { id } = await context.params;
    const parsed = reviewSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'إجراء المراجعة غير صالح.', 'validation_error');
    const submission = await loadSubmission(db, id);
    const reviewer = { id: user.id, role };
    const updated = parsed.data.action === 'start'
      ? await startReview(db, submission, reviewer)
      : await requestChanges(db, submission, reviewer, parsed.data.notes ?? '');
    return NextResponse.json({ ok: true, submission: updated }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error, { route: 'POST /api/admin/submissions/[id]/review' }); }
}
