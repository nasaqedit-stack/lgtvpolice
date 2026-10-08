/*
 * Server-side player health.
 *
 * A television is NEVER reported as online because a row exists: `last_seen_at` is only ever
 * written by the authenticated heartbeat route (`requireScreen()` validates the screen credential
 * before any field is touched), so the age of that timestamp is the single source of truth.
 *
 * The player may additionally report a pessimistic state (`reconnecting`, `recovering`,
 * `auth_error`, `config_error`, `offline`). Pessimistic claims are trusted because a player cannot
 * gain anything by claiming to be broken; optimistic claims are not: `online` is only ever
 * derived here from a recent authenticated heartbeat.
 */

/** States the standalone player reports. Keep in sync with public/player/watchdog.js. */
export const PLAYER_STATES = [
  'boot', 'register', 'sync', 'online', 'degraded', 'reconnecting', 'recovering',
  'controlled_reload', 'offline', 'auth_error', 'config_error',
] as const;
export type PlayerState = (typeof PLAYER_STATES)[number];

/** Operational statuses shown to administrators. */
export const SCREEN_HEALTH_STATUSES = [
  'online', 'degraded', 'reconnecting', 'recovering', 'stale', 'offline', 'auth_error', 'config_error',
] as const;
export type ScreenHealthStatus = (typeof SCREEN_HEALTH_STATUSES)[number];

/**
 * Windows used to derive the status from the heartbeat age.
 *
 * The player heartbeats every 30 s, so ~3 missed beats still counts as ONLINE, ~7 as DEGRADED
 * (something is wrong but the player may still be showing cached content) and beyond that it is
 * STALE and then OFFLINE.
 */
export const HEALTH_WINDOWS = {
  onlineMs: 90_000,
  degradedMs: 210_000,
  staleMs: 900_000,
} as const;

/** Columns added by migration `20261008010000_player_health.sql`. Optional at runtime. */
export const SCREEN_HEALTH_COLUMNS = [
  'player_state',
  'player_state_since',
  'last_applied_sync_version',
  'last_applied_reload_version',
  'recovery_count',
  'last_recovery_at',
  'last_recovery_reason',
  'last_recovery_state',
  'last_health_status',
  'last_health_checked_at',
  'last_boot_at',
  'boot_count',
] as const;

/** Every other screen column the admin APIs need; always present. */
export const SCREEN_BASE_COLUMNS = [
  'id', 'name', 'timezone', 'enabled', 'paired_at', 'last_seen_at', 'last_sync_at', 'last_sync_status',
  'last_sync_error', 'current_playlist_id', 'current_playlist_version', 'current_item_id',
  'cached_media_count', 'device_info', 'sync_command_version', 'reload_command_version',
  'assigned_playlist_id', 'created_at', 'updated_at',
] as const;

export type ScreenHealth = {
  status: ScreenHealthStatus;
  heartbeatAgeMs: number | null;
  lastHeartbeatAt: string | null;
  lastSyncAt: string | null;
  neverConnected: boolean;
  playerState: PlayerState | null;
  playerStateSince: string | null;
  command: { sync: number; reload: number };
  applied: { sync: number | null; reload: number | null };
  pendingCommands: number;
  recovery: { state: string | null; count: number; lastAt: string | null; reason: string | null };
  health: { status: string | null; checkedAt: string | null };
  boot: { count: number; lastAt: string | null };
  syncStatus: string;
  syncError: string | null;
};

function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function nullableString(value: unknown, limit = 200): string | null {
  if (typeof value !== 'string' || !value) return null;
  return value.slice(0, limit);
}
function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function isPlayerState(value: unknown): value is PlayerState {
  return typeof value === 'string' && (PLAYER_STATES as readonly string[]).includes(value);
}

export function normalizePlayerState(value: unknown): PlayerState | null {
  return isPlayerState(value) ? value : null;
}

/**
 * Derives the operational status of one screen from its last authenticated heartbeat.
 *
 * `raw` is a `screens` row. The health columns may be absent (migration not applied yet); every
 * read goes through a nullable accessor so the route works either way.
 */
export function deriveScreenHealth(raw: Record<string, any>, now: number = Date.now()): ScreenHealth {
  const lastHeartbeatAt = isoOrNull(raw.last_seen_at);
  const lastSyncAt = isoOrNull(raw.last_sync_at);
  const heartbeatAgeMs = lastHeartbeatAt ? Math.max(0, now - new Date(lastHeartbeatAt).getTime()) : null;
  const reported = normalizePlayerState(raw.player_state);
  const neverConnected = !lastHeartbeatAt;

  let status: ScreenHealthStatus;
  if (reported === 'auth_error') status = 'auth_error';
  else if (reported === 'config_error') status = 'config_error';
  else if (heartbeatAgeMs === null) status = 'offline';
  else if (heartbeatAgeMs <= HEALTH_WINDOWS.onlineMs) {
    // A pessimistic report is honoured even inside the fresh window; an optimistic one is not.
    status = reported === 'reconnecting' || reported === 'recovering' || reported === 'offline'
      || reported === 'controlled_reload' || reported === 'degraded'
      ? (reported === 'controlled_reload' ? 'recovering' : reported)
      : 'online';
  } else if (heartbeatAgeMs <= HEALTH_WINDOWS.degradedMs) {
    status = reported === 'reconnecting' || reported === 'recovering' ? reported : 'degraded';
  } else if (heartbeatAgeMs <= HEALTH_WINDOWS.staleMs) {
    status = reported === 'reconnecting' || reported === 'recovering' ? reported : 'stale';
  } else {
    status = 'offline';
  }

  const command = {
    sync: Math.max(0, numberOr(raw.sync_command_version, 0)),
    reload: Math.max(0, numberOr(raw.reload_command_version, 0)),
  };
  const appliedSync = nullableNumber(raw.last_applied_sync_version);
  const appliedReload = nullableNumber(raw.last_applied_reload_version);
  const applied = { sync: appliedSync, reload: appliedReload };
  // A command is pending only when the player has actually acknowledged an older version. When the
  // migration is not applied yet the applied version is unknown and nothing is claimed as pending.
  const pendingCommands = [
    appliedSync === null ? 0 : Math.max(0, command.sync - appliedSync),
    appliedReload === null ? 0 : Math.max(0, command.reload - appliedReload),
  ].reduce((sum, value) => sum + value, 0);

  return {
    status,
    heartbeatAgeMs,
    lastHeartbeatAt,
    lastSyncAt,
    neverConnected,
    playerState: reported,
    playerStateSince: isoOrNull(raw.player_state_since),
    command,
    applied,
    pendingCommands,
    recovery: {
      state: nullableString(raw.last_recovery_state, 40),
      count: Math.max(0, numberOr(raw.recovery_count, 0)),
      lastAt: isoOrNull(raw.last_recovery_at),
      reason: nullableString(raw.last_recovery_reason, 120),
    },
    health: {
      status: nullableString(raw.last_health_status, 120),
      checkedAt: isoOrNull(raw.last_health_checked_at),
    },
    boot: { count: Math.max(0, numberOr(raw.boot_count, 0)), lastAt: isoOrNull(raw.last_boot_at) },
    syncStatus: typeof raw.last_sync_status === 'string' ? raw.last_sync_status : 'never',
    syncError: nullableString(raw.last_sync_error, 300),
  };
}

/**
 * True when the screen should be presented as "connected" to an administrator.
 *
 * DEGRADED/RECONNECTING/RECOVERING are deliberately not "online": the dashboard must not claim a
 * healthy player when the player itself has stopped confirming connectivity.
 */
export function isScreenOnline(health: ScreenHealth): boolean {
  return health.status === 'online';
}

const MISSING_COLUMN_CODES = new Set(['42703', 'PGRST204', 'PGRST202']);
let extendedColumnsSupported: boolean | null = null;

function missingColumn(error: any): boolean {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (MISSING_COLUMN_CODES.has(code)) return true;
  const message = typeof error?.message === 'string' ? error.message : '';
  return /Could not find the '[^']+' column of '[^']+' in the schema cache/i.test(message)
    || /column .* does not exist/i.test(message);
}

/**
 * Writes the heartbeat update, transparently dropping the columns that only exist once the player
 * health migration has been applied. The result is cached per serverless instance, so an unmigrated
 * project pays one extra failed write at most once per process, never per heartbeat.
 */
export async function updateScreenHeartbeat(
  db: any,
  screenId: string,
  base: Record<string, unknown>,
  extended: Record<string, unknown> | null,
): Promise<void> {
  if (extended && extendedColumnsSupported !== false) {
    const merged: Record<string, unknown> = { ...base };
    for (const key of Object.keys(extended)) {
      if (extended[key] !== undefined) merged[key] = extended[key];
    }
    const { error } = await db.from('screens').update(merged).eq('id', screenId);
    if (!error) { extendedColumnsSupported = true; return; }
    if (!missingColumn(error)) throw error;
    extendedColumnsSupported = false;
  }
  const { error } = await db.from('screens').update(base).eq('id', screenId);
  if (error) throw error;
}

export function resetScreenHealthColumnCache(): void {
  extendedColumnsSupported = null;
}
