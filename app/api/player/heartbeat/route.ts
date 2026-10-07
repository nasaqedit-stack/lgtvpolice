import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, HttpError, readJson, requireScreen } from '@/lib/server/http';
import { deviceInfoSchema } from '@/lib/server/pairing';

export const runtime = 'nodejs';
const schema = z.object({
  currentPlaylistId: z.string().uuid().nullable().optional(),
  currentPlaylistVersion: z.number().int().nonnegative().nullable().optional(),
  currentItemId: z.string().uuid().nullable().optional(),
  syncStatus: z.enum(['ready', 'syncing', 'failed']).default('ready'),
  syncError: z.string().max(300).nullable().optional(),
  cachedMediaCount: z.number().int().min(0).max(10000).default(0),
  storageUsageBytes: z.number().int().nonnegative().nullable().optional(),
  storageQuotaBytes: z.number().int().nonnegative().nullable().optional(),
  lastSyncAt: z.string().datetime().nullable().optional(),
  deviceInfo: deviceInfoSchema.optional(),
}).strict();

export async function POST(request: NextRequest) {
  try {
    const { db, screen } = await requireScreen(request);
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'بيانات نبض الشاشة غير صالحة.', 'validation_error');
    const value = parsed.data;
    const now = new Date().toISOString();
    const update: Record<string, unknown> = {
      last_seen_at: now,
      last_sync_status: value.syncStatus,
      last_sync_error: value.syncError ?? null,
      current_playlist_id: value.currentPlaylistId ?? null,
      current_playlist_version: value.currentPlaylistVersion ?? null,
      current_item_id: value.currentItemId ?? null,
      cached_media_count: value.cachedMediaCount,
      updated_at: now,
    };
    if (value.lastSyncAt) {
      const claimed = new Date(value.lastSyncAt).getTime();
      if (claimed <= Date.now() + 60_000) update.last_sync_at = new Date(Math.min(claimed, Date.now())).toISOString();
    }
    if (value.deviceInfo) update.device_info = value.deviceInfo;
    const { error: updateError } = await db.from('screens').update(update).eq('id', screen.id);
    if (updateError) throw updateError;
    const { data: recentHeartbeat, error: recentError } = await db.from('screen_heartbeats').select('received_at').eq('screen_id', screen.id).order('received_at', { ascending: false }).limit(1).maybeSingle();
    if (recentError) throw recentError;
    if (!recentHeartbeat || Date.now() - new Date(recentHeartbeat.received_at).getTime() >= 5 * 60_000) {
      const { error: insertError } = await db.from('screen_heartbeats').insert({
        screen_id: screen.id,
        received_at: now,
        current_playlist_id: value.currentPlaylistId ?? null,
        current_playlist_version: value.currentPlaylistVersion ?? null,
        current_item_id: value.currentItemId ?? null,
        sync_status: value.syncStatus,
        sync_error: value.syncError ?? null,
        cached_media_count: value.cachedMediaCount,
        storage_usage_bytes: value.storageUsageBytes ?? null,
        storage_quota_bytes: value.storageQuotaBytes ?? null,
        device_info: value.deviceInfo ?? {},
      });
      if (insertError) throw insertError;
    }
    return NextResponse.json({ ok: true, serverTime: now }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}
