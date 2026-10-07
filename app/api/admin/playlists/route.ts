import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, HttpError, requireAdmin, readJson } from '@/lib/server/http';

export const runtime = 'nodejs';
const itemSchema = z.object({
  mediaId: z.string().uuid(),
  durationMs: z.number().int().min(1000).max(86400000).nullable().optional(),
  loop: z.boolean().optional().default(false),
}).strict();
const schema = z.object({
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  items: z.array(itemSchema).max(100).default([]),
  publish: z.boolean().default(true),
}).strict();

export async function GET(request: NextRequest) {
  try {
    const { db } = await requireAdmin(request);
    const { data: playlists, error } = await db.from('playlists').select('*').order('updated_at', { ascending: false });
    if (error) throw error;
    const ids = (playlists ?? []).map((playlist: any) => playlist.id);
    const { data: items, error: itemError } = ids.length
      ? await db.from('playlist_items').select('id,playlist_id,media_id,position,duration_ms,loop_video').in('playlist_id', ids).order('position')
      : { data: [], error: null };
    if (itemError) throw itemError;
    const mediaIds = [...new Set((items ?? []).map((item: any) => item.media_id))];
    const { data: media, error: mediaError } = mediaIds.length
      ? await db.from('media').select('id,display_name,kind,mime_type,file_size,sha256,thumbnail_data,duration_ms,compatibility').in('id', mediaIds)
      : { data: [], error: null };
    if (mediaError) throw mediaError;
    const mediaMap = new Map((media ?? []).map((value: any) => [value.id, value]));
    const playlistItems = new Map<string, any[]>();
    for (const item of items ?? []) {
      const list = playlistItems.get(item.playlist_id) ?? [];
      list.push({ ...item, media: mediaMap.get(item.media_id) ?? null });
      playlistItems.set(item.playlist_id, list);
    }
    const { data: schedules, error: scheduleError } = await db.from('schedule_entries').select('playlist_id');
    if (scheduleError) throw scheduleError;
    const scheduledCounts = new Map<string, number>();
    for (const row of schedules ?? []) scheduledCounts.set(row.playlist_id, (scheduledCounts.get(row.playlist_id) ?? 0) + 1);
    return NextResponse.json({ playlists: (playlists ?? []).map((playlist: any) => ({
      ...playlist, items: playlistItems.get(playlist.id) ?? [], scheduledCount: scheduledCounts.get(playlist.id) ?? 0,
    })) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest) {
  try {
    const { db, user } = await requireAdmin(request);
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'بيانات قائمة التشغيل غير صالحة.', 'validation_error');
    if (parsed.data.publish && parsed.data.items.length === 0) throw new HttpError(400, 'أضف وسيطاً واحداً على الأقل قبل النشر.', 'empty_playlist');
    const { data: playlist, error } = await db.from('playlists').insert({
      name: parsed.data.name, enabled: parsed.data.enabled, created_by: user.id,
    }).select('id').single();
    if (error) throw error;
    const { data: version, error: saveError } = await db.rpc('save_playlist_revision', {
      p_playlist_id: playlist.id,
      p_name: parsed.data.name,
      p_enabled: parsed.data.enabled,
      p_items: parsed.data.items,
      p_publish: parsed.data.publish,
      p_created_by: user.id,
    });
    if (saveError) {
      await db.from('playlists').delete().eq('id', playlist.id);
      throw saveError;
    }
    return NextResponse.json({ playlist: { id: playlist.id, name: parsed.data.name, enabled: parsed.data.enabled, published_version: parsed.data.publish ? version : null }, version }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
