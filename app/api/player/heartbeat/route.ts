import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, HttpError, readJson, requireScreen } from '@/lib/server/http';
import { deviceInfoSchema } from '@/lib/server/pairing';
import { isPlayerState, updateScreenHeartbeat } from '@/lib/server/screen-health';

export const runtime = 'nodejs';

/*
 * The heartbeat is the ONLY thing that marks a screen online.
 *
 * `requireScreen()` has already validated the screen credential (SHA-256 match against
 * `screen_credentials`, not revoked, screen enabled) before this handler runs, so writing
 * `last_seen_at` here means "this screen authenticated and talked to us just now". No other route
 * and no client claim can produce an online status: the player may only report *pessimistic*
 * states (reconnecting / recovering / offline / auth_error / config_error).
 */

const recovery = z.object({
  count: z.number().int().min(0).max(1_000_000).optional(),
  lastAt: z.string().datetime().nullable().optional(),
  reason: z.string().max(120).nullable().optional(),
  state: z.string().max(40).nullable().optional(),
}).strict();

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
  // --- 24/7 self-healing additions -------------------------------------------------------------
  playerState: z.enum([
    'boot', 'register', 'sync', 'online', 'degraded', 'reconnecting', 'recovering',
    'controlled_reload', 'offline', 'auth_error', 'config_error',
  ]).optional(),
  appliedSyncVersion: z.number().int().min(0).max(1_000_000).nullable().optional(),
  appliedReloadVersion: z.number().int().min(0).max(1_000_000).nullable().optional(),
  consecutiveFailures: z.number().int().min(0).max(10_000).optional(),
  recovery: recovery.optional(),
  healthStatus: z.string().max(120).nullable().optional(),
  healthCheckedAt: z.string().datetime().nullable().optional(),
  bootAt: z.string().datetime().nullable().optional(),
  lastSyncOkAt: z.string().datetime().nullable().optional(),
}).strict();

/** Accepts a client timestamp, clamped so a player with a wrong clock cannot poison reports. */
function clampPast(value: unknown, maxAgeMs: number, now: number): string | null {
  if (typeof value !== 'string' || !value) return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return null;
  if (time > now + 60_000) return new Date(now).toISOString();
  if (now - time > maxAgeMs) return null;
  return new Date(time).toISOString();
}

function safeReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // Diagnostics are operational codes only: no URLs, tokens or credentials are ever stored.
  const cleaned = value.replace(/[^a-zA-Z0-9_:.\- ]/g, '').trim().slice(0, 120);
  return cleaned || null;
}

export async function POST(request: NextRequest) {
  try {
    const { db, screen } = await requireScreen(request);
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'بيانات نبض الشاشة غير صالحة.', 'validation_error');
    const value = parsed.data;
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    const base: Record<string, unknown> = {
      last_seen_at: nowIso,
      last_sync_status: value.syncStatus,
      last_sync_error: value.syncError ?? null,
      current_playlist_id: value.currentPlaylistId ?? null,
      current_playlist_version: value.currentPlaylistVersion ?? null,
      current_item_id: value.currentItemId ?? null,
      cached_media_count: value.cachedMediaCount,
      updated_at: nowIso,
    };
    const claimedSyncAt = clampPast(value.lastSyncAt ?? value.lastSyncOkAt, 30 * 24 * 60 * 60_000, now);
    if (claimedSyncAt) base.last_sync_at = claimedSyncAt;
    if (value.deviceInfo) base.device_info = value.deviceInfo;

    const reportedState = isPlayerState(value.playerState) ? value.playerState : null;
    const extended: Record<string, unknown> = {
      player_state: reportedState,
      last_applied_sync_version: value.appliedSyncVersion ?? undefined,
      last_applied_reload_version: value.appliedReloadVersion ?? undefined,
      recovery_count: value.recovery?.count,
      last_recovery_at: clampPast(value.recovery?.lastAt, 30 * 24 * 60 * 60_000, now) ?? undefined,
      last_recovery_reason: safeReason(value.recovery?.reason),
      last_recovery_state: safeReason(value.recovery?.state)?.slice(0, 40),
      last_health_status: safeReason(value.healthStatus),
      last_health_checked_at: clampPast(value.healthCheckedAt, 30 * 24 * 60 * 60_000, now) ?? undefined,
      last_boot_at: clampPast(value.bootAt, 30 * 24 * 60 * 60_000, now) ?? undefined,
    };
    // Only move `player_state_since` when the reported state actually changed.
    if (reportedState && reportedState !== screen.player_state) extended.player_state_since = nowIso;

    await updateScreenHeartbeat(db, screen.id, base, extended);

    const { data: recentHeartbeat, error: recentError } = await db.from('screen_heartbeats').select('received_at').eq('screen_id', screen.id).order('received_at', { ascending: false }).limit(1).maybeSingle();
    if (recentError) throw recentError;
    if (!recentHeartbeat || Date.now() - new Date(recentHeartbeat.received_at).getTime() >= 5 * 60_000) {
      const { error: insertError } = await db.from('screen_heartbeats').insert({
        screen_id: screen.id,
        received_at: nowIso,
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
    return NextResponse.json({ ok: true, serverTime: nowIso }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}
