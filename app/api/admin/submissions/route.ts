import { NextRequest, NextResponse } from 'next/server';
import { errorResponse, requireAdmin } from '@/lib/server/http';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  try {
    const { db } = await requireAdmin(request);
    const params = request.nextUrl.searchParams;
    const state = params.get('state');
    const organizationId = params.get('organizationId');
    const limit = Math.min(Number(params.get('limit') ?? '50'), 200);
    const offset = Number(params.get('offset') ?? '0');

    let query = db.from('submissions').select(`
      *,
      original_media:media!submissions_original_media_id_fkey(id, display_name, mime_type, kind, file_size, thumbnail_data, storage_path),
      optimized_media:media!submissions_optimized_media_id_fkey(id, display_name, mime_type, kind, file_size, thumbnail_data, storage_path),
      thumbnail_media:media!submissions_thumbnail_media_id_fkey(id, display_name, mime_type, kind, file_size, thumbnail_data, storage_path),
      approver:profiles!submissions_approved_by_fkey(id, email),
      reviewer:profiles!submissions_reviewed_by_fkey(id, email)
    `);

    if (state) query = query.eq('state', state);
    if (organizationId) query = query.eq('organization_id', organizationId);

    query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

    const { data, error } = await query;
    if (error) throw error;

    return NextResponse.json({ submissions: data ?? [] });
  } catch (error) { return errorResponse(error); }
}