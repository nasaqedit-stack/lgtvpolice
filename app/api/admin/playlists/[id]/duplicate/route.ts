import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, HttpError, requireAdmin, readJson } from '@/lib/server/http';

type Context = { params: Promise<{ id: string }> };
const schema = z.object({ name: z.string().trim().min(1).max(120).optional() }).strict();
export async function POST(request: NextRequest, context: Context) {
  try {
    const { db, user } = await requireAdmin(request);
    const { id } = await context.params;
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'اسم النسخة غير صالح.', 'validation_error');
    const { data: source, error } = await db.from('playlists').select('id,name,published_version').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!source) throw new HttpError(404, 'قائمة التشغيل غير موجودة.', 'not_found');
    const { data: rows, error: itemsError } = await db.from('playlist_items').select('media_id,duration_ms,loop_video').eq('playlist_id', id).order('position');
    if (itemsError) throw itemsError;
    const items = (rows ?? []).map((row: any) => ({ mediaId: row.media_id, durationMs: row.duration_ms, loop: row.loop_video }));
    const name = parsed.data.name ?? `نسخة من ${source.name}`.slice(0, 120);
    const enabled = true;
    const { data: clone, error: cloneError } = await db.from('playlists').insert({ name, enabled, created_by: user.id }).select('id').single();
    if (cloneError) throw cloneError;
    const publish = Boolean(source.published_version && items.length);
    const { data: version, error: saveError } = await db.rpc('save_playlist_revision', {
      p_playlist_id: clone.id, p_name: name, p_enabled: enabled, p_items: items,
      p_publish: publish, p_created_by: user.id,
    });
    if (saveError) {
      await db.from('playlists').delete().eq('id', clone.id);
      throw saveError;
    }
    return NextResponse.json({ playlist: { id: clone.id, name, enabled, published_version: publish ? version : null } }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
