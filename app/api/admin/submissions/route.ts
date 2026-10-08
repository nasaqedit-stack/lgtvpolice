import { NextRequest, NextResponse } from 'next/server';
import { errorResponse, requireAdmin, HttpError } from '@/lib/server/http';
import { SUBMISSION_QUEUE_FILTERS, type SubmissionState } from '@/lib/shared/submissions';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Admin submissions queue. Returns submissions for one queue filter (or all) plus per-filter
 * counts for the tab badges. Requires an authenticated admin/operator session.
 */
export async function GET(request: NextRequest) {
  try {
    const { db } = await requireAdmin(request);
    const params = request.nextUrl.searchParams;
    const filterParam = params.get('filter') ?? 'new';
    const filter = SUBMISSION_QUEUE_FILTERS.find(entry => entry.id === filterParam) ?? SUBMISSION_QUEUE_FILTERS[0];
    const search = params.get('q')?.trim().slice(0, 100) ?? '';

    let query = db.from('submissions').select('*');
    if (filterParam === 'all') {
      // no state filter
    } else {
      query = query.in('state', [...filter.states] as string[]);
    }
    if (search) query = query.or(`title.ilike.%${search.replace(/[,%()]/g, '')}%,contributor_name.ilike.%${search.replace(/[,%()]/g, '')}%`);
    const { data: submissions, error } = await query.order('created_at', { ascending: false }).limit(200);
    if (error) throw error;

    // Per-state counts for the tab badges (one cheap head-count per state).
    const states = [...new Set(SUBMISSION_QUEUE_FILTERS.flatMap(entry => entry.states))] as SubmissionState[];
    const counts: Record<string, number> = {};
    await Promise.all(states.map(async state => {
      const { count, error: countError } = await db.from('submissions')
        .select('id', { count: 'exact', head: true })
        .eq('state', state);
      if (countError) throw countError;
      counts[state] = count ?? 0;
    }));
    const filterCounts = Object.fromEntries(SUBMISSION_QUEUE_FILTERS.map(entry => [
      entry.id,
      entry.states.reduce((sum, state) => sum + (counts[state] ?? 0), 0),
    ]));

    if (!['all', ...SUBMISSION_QUEUE_FILTERS.map(entry => entry.id)].includes(filterParam)) {
      throw new HttpError(400, 'مرشح غير صالح.', 'invalid_filter');
    }
    return NextResponse.json({
      submissions: submissions ?? [],
      filter: filter.id,
      filterCounts,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error, { route: 'GET /api/admin/submissions' }); }
}
