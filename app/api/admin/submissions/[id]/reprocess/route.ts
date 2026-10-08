import { NextRequest, NextResponse } from 'next/server';
import { errorResponse } from '@/lib/server/http';
import { loadSubmission, requireAdmin, reprocessSubmission } from '@/lib/server/submissions';
import { processSubmissionMedia } from '@/lib/server/media-optimization';

export const runtime = 'nodejs';
// Re-runs media optimization (image re-encode / video transcode); allow a long deadline.
export const maxDuration = 300;
type Context = { params: Promise<{ id: string }> };

/**
 * Safe retry of media optimization after a processing failure (or to regenerate the delivery
 * version). Bumps the submission version and clears any previous approval, because the new
 * bytes are no longer the approved version. The original file is never touched.
 */
export async function POST(request: NextRequest, context: Context) {
  try {
    const { user, role, db } = await requireAdmin(request);
    const { id } = await context.params;
    const submission = await loadSubmission(db, id);
    const processing = await reprocessSubmission(db, submission, { id: user.id, role });
    const result = await processSubmissionMedia(db, processing);
    return NextResponse.json({
      ok: result.ok,
      submission: result.submission,
      processing: result.ok ? 'completed' : 'failed',
      processingError: result.ok ? null : result.error,
      message: result.ok ? 'اكتملت إعادة معالجة الوسائط.' : 'فشلت إعادة معالجة الوسائط. تم الاحتفاظ بالملف الأصلي.',
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error, { route: 'POST /api/admin/submissions/[id]/reprocess' }); }
}
