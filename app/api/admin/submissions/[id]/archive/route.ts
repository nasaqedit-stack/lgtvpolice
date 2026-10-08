import { NextRequest, NextResponse } from 'next/server';
import { errorResponse } from '@/lib/server/http';
import { archiveSubmission, loadSubmission, requireAdmin } from '@/lib/server/submissions';

export const runtime = 'nodejs';
export const maxDuration = 60;
type Context = { params: Promise<{ id: string }> };

/** Archive a submission (admin or operator). Published submissions must be unpublished first. */
export async function POST(request: NextRequest, context: Context) {
  try {
    const { user, role, db } = await requireAdmin(request);
    const { id } = await context.params;
    const submission = await loadSubmission(db, id);
    const updated = await archiveSubmission(db, submission, { id: user.id, role });
    return NextResponse.json({ ok: true, submission: updated, message: 'تمت أرشفة المشاركة.' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error, { route: 'POST /api/admin/submissions/[id]/archive' }); }
}
