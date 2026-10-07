import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, HttpError, requireAdmin, readJson } from '@/lib/server/http';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
const itemSchema = z.object({
  mediaId: z.string().uuid(),
  durationMs: z.number().int().min(1000).max(86400000).nullable().optional(),
  loop: z.boolean().optional().default(false),
}).strict();
const schema = z.object({
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean(),
  items: z.array(itemSchema).max(100),
  publish: z.boolean().default(true),
}).strict();

export async function PATCH(request: NextRequest, context: Context) {
  try {
    const { db, user } = await requireAdmin(request);
    const { id } = await context.params;
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'بيانات قائمة التشغيل غير صالحة.', 'validation_error');
    if (parsed.data.publish && parsed.data.items.length === 0) throw new HttpError(400, 'لا يمكن نشر قائمة فارغة.', 'empty_playlist');
    const { data: existing, error: loadError } = await db.from('playlists').select('id').eq('id', id).maybeSingle();
    if (loadError) throw loadError;
    if (!existing) throw new HttpError(404, 'قائمة التشغيل غير موجودة.', 'not_found');
    const { data: version, error } = await db.rpc('save_playlist_revision', {
      p_playlist_id: id,
      p_name: parsed.data.name,
      p_enabled: parsed.data.enabled,
      p_items: parsed.data.items,
      p_publish: parsed.data.publish,
      p_created_by: user.id,
    });
    if (error) throw error;
    return NextResponse.json({ ok: true, version, published: parsed.data.publish });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: NextRequest, context: Context) {
  try {
    const { db } = await requireAdmin(request);
    const { id } = await context.params;
    const [{ count: assigned, error: assignedError }, { count: scheduled, error: scheduledError }] = await Promise.all([
      db.from('screens').select('id', { count: 'exact', head: true }).eq('assigned_playlist_id', id),
      db.from('schedule_entries').select('id', { count: 'exact', head: true }).eq('playlist_id', id),
    ]);
    if (assignedError) throw assignedError;
    if (scheduledError) throw scheduledError;
    if ((assigned ?? 0) + (scheduled ?? 0) > 0) throw new HttpError(409, 'أزل تعيين القائمة من الشاشات والجداول قبل حذفها.', 'playlist_in_use');
    const { error } = await db.from('playlists').delete().eq('id', id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
