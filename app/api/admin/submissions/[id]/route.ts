import { NextRequest, NextResponse } from 'next/server';
import { errorResponse, HttpError, requireAdmin } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context) {
  try {
    const { db } = await requireAdmin(request);
    const { id } = await context.params;
    const { data, error } = await db.from('submissions').select(`
      *,
      original_media:media!submissions_original_media_id_fkey(id, display_name, mime_type, kind, file_size, thumbnail_data, storage_path, width, height, duration_ms),
      optimized_media:media!submissions_optimized_media_id_fkey(id, display_name, mime_type, kind, file_size, thumbnail_data, storage_path, width, height, duration_ms),
      thumbnail_media:media!submissions_thumbnail_media_id_fkey(id, display_name, mime_type, kind, file_size, thumbnail_data, storage_path, width, height, duration_ms),
      approver:profiles!submissions_approved_by_fkey(id, email),
      reviewer:profiles!submissions_reviewed_by_fkey(id, email),
      token:submission_tokens!submissions_token_hash_fkey(id, name)
    `).eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) throw new HttpError(404, 'المشاركة غير موجودة.', 'submission_not_found');

    const { data: events, error: eventsError } = await db.from('submission_events').select(`
      *,
      actor_profile:profiles!submission_events_actor_fkey(id, email)
    `).eq('submission_id', id).order('created_at', { ascending: true });
    if (eventsError) throw eventsError;

    return NextResponse.json({ submission: data, events: events ?? [] });
  } catch (error) { return errorResponse(error); }
}