import { NextRequest, NextResponse } from 'next/server';
import { errorResponse, HttpError, readJson } from '@/lib/server/http';
import { loadSubmission, rejectSubmission, rejectSchema, requireApprover } from '@/lib/server/submissions';

export const runtime = 'nodejs';
export const maxDuration = 60;
type Context = { params: Promise<{ id: string }> };

/** Reject a submission (final approver only). A reason is required and audited. */
export async function POST(request: NextRequest, context: Context) {
  try {
    const { user, role, db } = await requireApprover(request);
    const { id } = await context.params;
    const parsed = rejectSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'سبب الرفض مطلوب.', 'validation_error');
    const submission = await loadSubmission(db, id);
    const updated = await rejectSubmission(db, submission, { id: user.id, role }, parsed.data.reason);
    return NextResponse.json({ ok: true, submission: updated, message: 'تم رفض المشاركة.' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error, { route: 'POST /api/admin/submissions/[id]/reject' }); }
}
