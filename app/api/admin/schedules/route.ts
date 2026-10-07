import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, HttpError, requireAdmin, readJson } from '@/lib/server/http';
import { assertNoOverlap } from '@/lib/server/schedule-validation';

export const runtime = 'nodejs';
const base = {
  screenId: z.string().uuid(),
  playlistId: z.string().uuid(),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  startTime: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
  endTime: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
  timezone: z.string().min(1).max(100).default('Asia/Riyadh'),
  enabled: z.boolean().default(true),
};
const schema = z.object(base).strict();
function checkTimezone(tz: string) { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }
async function verifyRefs(db: any, input: z.infer<typeof schema>) {
  if (input.startTime === input.endTime) throw new HttpError(400, 'وقت البداية والنهاية لا يمكن أن يتطابقا.', 'invalid_schedule');
  if (!checkTimezone(input.timezone)) throw new HttpError(400, 'المنطقة الزمنية غير صالحة.', 'invalid_timezone');
  if (new Set(input.weekdays).size !== input.weekdays.length) throw new HttpError(400, 'الأيام مكررة.', 'invalid_schedule');
  const [{ data: screen, error: screenError }, { data: playlist, error: playlistError }] = await Promise.all([
    db.from('screens').select('id').eq('id', input.screenId).maybeSingle(),
    db.from('playlists').select('id,enabled,published_version').eq('id', input.playlistId).maybeSingle(),
  ]);
  if (screenError) throw screenError;
  if (playlistError) throw playlistError;
  if (!screen) throw new HttpError(404, 'الشاشة غير موجودة.', 'screen_not_found');
  if (!playlist || !playlist.enabled || !playlist.published_version) throw new HttpError(400, 'انشر قائمة تشغيل مفعّلة قبل جدولتها.', 'playlist_not_ready');
}

export async function GET(request: NextRequest) {
  try {
    const { db } = await requireAdmin(request);
    const { data: schedules, error } = await db.from('schedule_entries').select('*').order('priority', { ascending: false }).order('start_time');
    if (error) throw error;
    const screenIds = [...new Set((schedules ?? []).map((row: any) => row.screen_id))];
    const playlistIds = [...new Set((schedules ?? []).map((row: any) => row.playlist_id))];
    const [{ data: screens, error: screenError }, { data: playlists, error: playlistError }] = await Promise.all([
      screenIds.length ? db.from('screens').select('id,name').in('id', screenIds) : { data: [], error: null },
      playlistIds.length ? db.from('playlists').select('id,name').in('id', playlistIds) : { data: [], error: null },
    ]);
    if (screenError) throw screenError;
    if (playlistError) throw playlistError;
    const screenMap = new Map((screens ?? []).map((row: any) => [row.id, row.name]));
    const playlistMap = new Map((playlists ?? []).map((row: any) => [row.id, row.name]));
    return NextResponse.json({ schedules: (schedules ?? []).map((row: any) => ({
      ...row, screenName: screenMap.get(row.screen_id) ?? '', playlistName: playlistMap.get(row.playlist_id) ?? '',
    })) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest) {
  try {
    const { db } = await requireAdmin(request);
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'بيانات الجدولة غير صالحة.', 'validation_error');
    await verifyRefs(db, parsed.data);
    if (parsed.data.enabled) {
      const { data: existing, error: overlapError } = await db.from('schedule_entries').select('weekdays,start_time,end_time,timezone,enabled').eq('screen_id', parsed.data.screenId).eq('enabled', true);
      if (overlapError) throw overlapError;
      assertNoOverlap({ weekdays: parsed.data.weekdays, startTime: parsed.data.startTime, endTime: parsed.data.endTime, timezone: parsed.data.timezone, enabled: parsed.data.enabled }, (existing ?? []).map((row: any) => ({ weekdays: row.weekdays, startTime: row.start_time, endTime: row.end_time, timezone: row.timezone, enabled: row.enabled })));
    }
    const { data, error } = await db.from('schedule_entries').insert({
      screen_id: parsed.data.screenId,
      playlist_id: parsed.data.playlistId,
      weekdays: parsed.data.weekdays,
      start_time: parsed.data.startTime,
      end_time: parsed.data.endTime,
      timezone: parsed.data.timezone,
      enabled: parsed.data.enabled,
    }).select('*').single();
    if (error) throw error;
    return NextResponse.json({ schedule: data }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
