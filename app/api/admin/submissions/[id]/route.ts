import { NextRequest, NextResponse } from 'next/server';
import { errorResponse, requireAdmin } from '@/lib/server/http';
import { loadSubmission } from '@/lib/server/submissions';

export const runtime = 'nodejs';
export const maxDuration = 60;
type Context = { params: Promise<{ id: string }> };

/**
 * Submission detail for the admin review screen: the submission row, the full append-only audit
 * history (review + approval history) and, when published, the library usage of the published
 * media so unpublish can be guarded.
 */
export async function GET(request: NextRequest, context: Context) {
  try {
    const { db } = await requireAdmin(request);
    const { id } = await context.params;
    const submission = await loadSubmission(db, id);
    const { data: events, error: eventsError } = await db.from('submission_events')
      .select('*')
      .eq('submission_id', id)
      .order('id', { ascending: true })
      .limit(500);
    if (eventsError) throw eventsError;
    let mediaUsage = 0;
    if (submission.published_media_id) {
      const { data: usageRows, error: usageError } = await db.rpc('get_media_usage_counts', { p_media_ids: [submission.published_media_id] });
      if (usageError) throw usageError;
      mediaUsage = Number(usageRows?.[0]?.usage_count ?? 0);
    }
    return NextResponse.json({ submission, events: events ?? [], mediaUsage }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error, { route: 'GET /api/admin/submissions/[id]' }); }
}
