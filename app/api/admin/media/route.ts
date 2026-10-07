import { NextRequest, NextResponse } from 'next/server';
import { errorResponse, HttpError, requireAdmin } from '@/lib/server/http';

export const runtime = 'nodejs';
export async function GET(request: NextRequest) {
  try {
    const { db } = await requireAdmin(request);
    const params = request.nextUrl.searchParams;
    const hash = params.get('hash');
    if (hash && !/^[a-f0-9]{64}$/.test(hash)) throw new HttpError(400, 'بصمة الملف غير صالحة.', 'invalid_hash');
    let query = db.from('media').select('*');
    if (hash) query = query.eq('sha256', hash);
    else {
      const kind = params.get('kind');
      if (kind === 'image' || kind === 'video') query = query.eq('kind', kind);
      const search = params.get('q')?.trim().slice(0, 100);
      if (search) query = query.ilike('display_name', `%${search.replace(/[,%_]/g, '\\$&')}%`);
      const sort = params.get('sort');
      if (sort === 'name') query = query.order('display_name', { ascending: true });
      else if (sort === 'size') query = query.order('file_size', { ascending: false });
      else query = query.order('created_at', { ascending: false });
      query = query.limit(250);
    }
    const { data: media, error } = await query;
    if (error) throw error;
    const ids = (media ?? []).map((row: any) => row.id);
    const usage = new Map<string, number>();
    if (ids.length) {
      const { data: rows, error: usageError } = await db.rpc('get_media_usage_counts', { p_media_ids: ids });
      if (usageError) throw usageError;
      for (const row of rows ?? []) usage.set(row.media_id, Number(row.usage_count ?? 0));
    }
    return NextResponse.json({ media: (media ?? []).map((row: any) => ({ ...row, usageCount: usage.get(row.id) ?? 0 })) });
  } catch (error) { return errorResponse(error); }
}
