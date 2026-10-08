import { NextRequest, NextResponse } from 'next/server';
import { errorResponse, HttpError, readJson } from '@/lib/server/http';
import { confirmSchema, publishSubmission, requireApprover } from '@/lib/server/submissions';

export const runtime = 'nodejs';
export const maxDuration = 60;
type Context = { params: Promise<{ id: string }> };

/**
 * Publish an APPROVED submission (final approver only, explicit confirmation). Registers the
 * optimized delivery version in the media library (so playlists and the offline-first player
 * distribute it like any other media) and makes the submission publicly visible. APPROVED and
 * PUBLISHED remain separate, audited states; approval alone never publishes silently.
 */
export async function POST(request: NextRequest, context: Context) {
  try {
    const { user, role, db } = await requireApprover(request);
    const { id } = await context.params;
    const parsed = confirmSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'يتطلب النشر تأكيدًا صريحًا.', 'confirmation_required');
    const result = await publishSubmission(db, id, { id: user.id, role });
    return NextResponse.json({
      ok: true,
      alreadyPublished: result.alreadyPublished,
      submission: result.submission,
      media: result.media,
      message: result.alreadyPublished ? 'المشاركة منشورة مسبقًا.' : 'تم نشر المشاركة.',
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error, { route: 'POST /api/admin/submissions/[id]/publish' }); }
}
