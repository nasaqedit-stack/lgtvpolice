import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, HttpError, requireAdmin, readJson } from '@/lib/server/http';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  timezone: z.string().optional(),
  enabled: z.boolean().optional(),
  assignedPlaylistId: z.string().uuid().nullable().optional(),
  unpair: z.boolean().optional(),
}).strict();

export async function PATCH(request: NextRequest, context: Context) {
  try {
    const { db } = await requireAdmin(request);
    const { id } = await context.params;
    const parsed = patchSchema.safeParse(await readJson(request));
    if (!parsed.success || Object.values(parsed.data).every(value => value === undefined)) throw new HttpError(400, 'لا توجد تغييرات صالحة.', 'validation_error');
    const input = parsed.data;
    const update: Record<string, unknown> = {};
    if (input.name !== undefined) update.name = input.name;
    if (input.enabled !== undefined) update.enabled = input.enabled;
    if (input.timezone !== undefined) {
      try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }); } catch { throw new HttpError(400, 'المنطقة الزمنية غير معروفة.', 'invalid_timezone'); }
      update.timezone = input.timezone;
    }
    if (input.assignedPlaylistId !== undefined) {
      if (input.assignedPlaylistId) {
        const { data: playlist, error: playlistError } = await db.from('playlists').select('id,enabled,published_version').eq('id', input.assignedPlaylistId).maybeSingle();
        if (playlistError) throw playlistError;
        if (!playlist || !playlist.enabled || !playlist.published_version) throw new HttpError(400, 'يجب نشر القائمة وتفعيلها قبل التعيين.', 'playlist_not_ready');
      }
      update.assigned_playlist_id = input.assignedPlaylistId;
    }
    let screen: any = null;
    if (Object.keys(update).length) {
      update.updated_at = new Date().toISOString();
      const result = await db.from('screens').update(update).eq('id', id).select('*').maybeSingle();
      if (result.error) throw result.error;
      screen = result.data;
    } else {
      const result = await db.from('screens').select('*').eq('id', id).maybeSingle();
      if (result.error) throw result.error;
      screen = result.data;
    }
    if (!screen) throw new HttpError(404, 'الشاشة غير موجودة.', 'not_found');
    if (input.unpair) {
      const now = new Date().toISOString();
      const { error: revokeError } = await db.from('screen_credentials').update({ revoked_at: now }).eq('screen_id', id).is('revoked_at', null);
      if (revokeError) throw revokeError;
      await db.from('screens').update({ paired_at: null }).eq('id', id);
    }
    return NextResponse.json({ screen });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: NextRequest, context: Context) {
  try {
    const { db } = await requireAdmin(request);
    const { id } = await context.params;
    const { error } = await db.from('screens').delete().eq('id', id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
