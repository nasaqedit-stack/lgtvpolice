import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, HttpError, requireAdmin, readJson } from '@/lib/server/http';
import { assertNoOverlap } from '@/lib/server/schedule-validation';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
const patchSchema = z.object({
  screenId: z.string().uuid().optional(),
  playlistId: z.string().uuid().optional(),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
  startTime: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/).optional(),
  endTime: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/).optional(),
  timezone: z.string().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
}).strict();

export async function PATCH(request: NextRequest, context: Context) {
  try {
    const { db } = await requireAdmin(request);
    const { id } = await context.params;
    const parsed = patchSchema.safeParse(await readJson(request));
    if (!parsed.success || Object.keys(parsed.data).length === 0) throw new HttpError(400, 'لا توجد تغييرات صالحة.', 'validation_error');
    const { data: existing, error: loadError } = await db.from('schedule_entries').select('*').eq('id', id).maybeSingle();
    if (loadError) throw loadError;
    if (!existing) throw new HttpError(404, 'الجدولة غير موجودة.', 'not_found');
    const value = {
      screenId: parsed.data.screenId ?? existing.screen_id,
      playlistId: parsed.data.playlistId ?? existing.playlist_id,
      weekdays: parsed.data.weekdays ?? existing.weekdays,
      startTime: parsed.data.startTime ?? existing.start_time,
      endTime: parsed.data.endTime ?? existing.end_time,
      timezone: parsed.data.timezone ?? existing.timezone,
      enabled: parsed.data.enabled ?? existing.enabled,
    };
    if (value.startTime === value.endTime || new Set(value.weekdays).size !== value.weekdays.length) throw new HttpError(400, 'تداخل أو تكرار في إعداد الجدولة.', 'invalid_schedule');
    try { new Intl.DateTimeFormat('en', { timeZone: value.timezone }); } catch { throw new HttpError(400, 'المنطقة الزمنية غير صالحة.', 'invalid_timezone'); }
    const [{ data: screen, error: screenError }, { data: playlist, error: playlistError }] = await Promise.all([
      db.from('screens').select('id').eq('id', value.screenId).maybeSingle(),
      db.from('playlists').select('id,enabled,published_version').eq('id', value.playlistId).maybeSingle(),
    ]);
    if (screenError) throw screenError;
    if (playlistError) throw playlistError;
    if (!screen) throw new HttpError(404, 'الشاشة غير موجودة.', 'screen_not_found');
    if (!playlist || !playlist.enabled || !playlist.published_version) throw new HttpError(400, 'انشر قائمة تشغيل مفعّلة قبل جدولتها.', 'playlist_not_ready');
    if (value.enabled) {
      const { data: others, error: overlapError } = await db.from('schedule_entries').select('weekdays,start_time,end_time,timezone,enabled').eq('screen_id', value.screenId).eq('enabled', true).neq('id', id);
      if (overlapError) throw overlapError;
      assertNoOverlap({ weekdays: value.weekdays, startTime: value.startTime, endTime: value.endTime, timezone: value.timezone, enabled: value.enabled }, (others ?? []).map((row: any) => ({ weekdays: row.weekdays, startTime: row.start_time, endTime: row.end_time, timezone: row.timezone, enabled: row.enabled })));
    }
    const { data, error } = await db.from('schedule_entries').update({
      screen_id: value.screenId,
      playlist_id: value.playlistId,
      weekdays: value.weekdays,
      start_time: value.startTime,
      end_time: value.endTime,
      timezone: value.timezone,
      enabled: value.enabled,
      updated_at: new Date().toISOString(),
    }).eq('id', id).select('*').single();
    if (error) throw error;
    return NextResponse.json({ schedule: data });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: NextRequest, context: Context) {
  try {
    const { db } = await requireAdmin(request);
    const { id } = await context.params;
    const { error } = await db.from('schedule_entries').delete().eq('id', id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
