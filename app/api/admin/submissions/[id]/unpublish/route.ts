import { NextRequest, NextResponse } from 'next/server';
import { errorResponse, HttpError, readJson } from '@/lib/server/http';
import { confirmSchema, requireApprover, unpublishSubmission } from '@/lib/server/submissions';

export const runtime = 'nodejs';
export const maxDuration = 60;
type Context = { params: Promise<{ id: string }> };

/**
 * Unpublish a PUBLISHED submission (final approver only, explicit confirmation): public
 * visibility is switched OFF immediately and the state returns to APPROVED. The library media
 * row is removed only when no playlist uses it (same guard as media deletion).
 */
export async function POST(request: NextRequest, context: Context) {
  try {
    const { user, role, db } = await requireApprover(request);
    const { id } = await context.params;
    const parsed = confirmSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'يتطلب إلغاء النشر تأكيدًا صريحًا.', 'confirmation_required');
    const submission = await unpublishSubmission(db, id, { id: user.id, role });
    return NextResponse.json({ ok: true, submission, message: 'تم إلغاء نشر المشاركة.' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error, { route: 'POST /api/admin/submissions/[id]/unpublish' }); }
}
