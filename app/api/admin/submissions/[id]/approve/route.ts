import { NextRequest, NextResponse } from 'next/server';
import { errorResponse, HttpError, readJson } from '@/lib/server/http';
import { approveSubmission, confirmSchema, requireApprover } from '@/lib/server/submissions';

export const runtime = 'nodejs';
export const maxDuration = 60;
type Context = { params: Promise<{ id: string }> };

/**
 * FINAL ADMIN APPROVAL — the only action that makes a submission eligible for publication.
 *
 * Requires an authenticated `admin`-role user and an explicit `confirm: true` (the admin UI
 * shows a confirmation dialog first). Server-side validation: the submission must exist, the
 * contributor consent must be recorded, media processing must have completed successfully and
 * the submission must not already be approved. Approval records the approving administrator,
 * the exact timestamp and the approved submission version, moves the state to APPROVED and
 * writes one immutable audit event.
 *
 * Idempotent: repeated clicks return the existing approval (`alreadyApproved: true`) and never
 * create a duplicate approval or audit event. Client-side flags such as `isApproved=true` are
 * not part of the schema and can never authorize publication.
 */
export async function POST(request: NextRequest, context: Context) {
  try {
    const { user, role, db } = await requireApprover(request);
    const { id } = await context.params;
    const parsed = confirmSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw new HttpError(400, 'يتطلب الاعتماد النهائي تأكيدًا صريحًا.', 'confirmation_required');
    }
    const result = await approveSubmission(db, id, { id: user.id, role });
    return NextResponse.json({
      ok: true,
      alreadyApproved: result.alreadyApproved,
      submission: result.submission,
      message: result.alreadyApproved ? 'المشاركة معتمدة مسبقًا.' : 'تم اعتماد المشاركة نهائيًا.',
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error, { route: 'POST /api/admin/submissions/[id]/approve' }); }
}
