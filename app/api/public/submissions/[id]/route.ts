import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseAdmin } from '@/lib/server/supabase';
import { HttpError, errorResponse } from '@/lib/server/http';
import { isPublicState } from '@/lib/shared/submissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
type Context = { params: Promise<{ id: string }> };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Public metadata for a PUBLISHED submission. Anything that is not PUBLISHED — including
 * APPROVED — is a 404: unapproved content is never publicly visible, and contributor contact
 * information is never exposed.
 */
export async function GET(request: NextRequest, context: Context) {
  try {
    const { id } = await context.params;
    if (!uuid.test(id)) throw new HttpError(400, 'معرّف غير صالح.', 'invalid_id');
    const db = createSupabaseAdmin();
    const { data: submission, error } = await db.from('submissions')
      .select('id,title,description,kind,state,version,published_at,optimized_mime_type,optimized_file_size,width,height,duration_ms,thumbnail_mime_type')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!submission || !isPublicState(submission.state)) {
      throw new HttpError(404, 'المحتوى غير متاح.', 'not_found');
    }
    return NextResponse.json({
      submission: {
        id: submission.id,
        title: submission.title,
        description: submission.description,
        kind: submission.kind,
        version: submission.version,
        publishedAt: submission.published_at,
        mimeType: submission.optimized_mime_type,
        fileSize: submission.optimized_file_size,
        width: submission.width,
        height: submission.height,
        durationMs: submission.duration_ms,
        mediaUrl: `/api/public/submissions/${id}/media`,
        thumbnailUrl: `/api/public/submissions/${id}/media?variant=thumbnail`,
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error, { route: 'GET /api/public/submissions/[id]' }); }
}
