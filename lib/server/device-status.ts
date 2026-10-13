/*
 * Read-only device diagnostics.
 *
 * This module answers one operational question that cannot be answered from HTTP status codes or
 * from unit tests: what is the real state of the paired television? Every field it returns is
 * either stored by the television itself (the heartbeat is the only writer of `last_seen_at`,
 * `last_sync_error`, `cached_media_count`, `current_item_id` …) or by the server while serving it
 * (`sync_manifests`).
 *
 * It is strictly read-only and redacted: no credentials, no tokens, no signed URLs and no
 * download links are ever included. `buildDeviceStatus` is a pure function of the rows it is
 * given so it can be unit tested with fixtures.
 */
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { PLAYER_RUNTIME_VERSION, PLAYER_VERSION } from '@/lib/player/standalone/shell';
import { deriveScreenHealth } from '@/lib/server/screen-health';
import { getS3Client, storageConfig, storageRequestOptions } from '@/lib/server/storage';

export const DEVICE_STATUS_SCHEMA = 1;

const HEARTBEAT_HISTORY_LIMIT = 8;

function iso(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function ageMs(value: unknown, now: number): number | null {
  const at = iso(value);
  return at ? Math.max(0, now - new Date(at).getTime()) : null;
}

function text(value: unknown, limit = 200): string | null {
  if (typeof value !== 'string' || !value) return null;
  return value.slice(0, limit);
}

/** The parts of `device_info` an operator may see; anything else the player sends is dropped. */
function deviceInfoView(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const keys = ['userAgent', 'platform', 'language', 'screenWidth', 'screenHeight', 'playerVersion', 'runtimeVersion'];
  for (const key of keys) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (key === 'userAgent') out.userAgent = text(value, 300);
    else if (key === 'playerVersion' || key === 'runtimeVersion') out[key] = text(value, 40);
    else out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

export type StorageReport = {
  bucket: string | null;
  objectCount: number | null;
  totalBytes: number | null;
  truncated?: boolean;
  objects: { key: string; bytes: number }[];
  error: string | null;
};

export type DeviceStatusInput = {
  screens?: unknown[] | null;
  heartbeats?: Record<string, unknown[]> | null;
  credentials?: unknown[] | null;
  manifests?: Record<string, unknown[]> | null;
  playlists?: unknown[] | null;
  playlistItems?: unknown[] | null;
  media?: unknown[] | null;
  storage?: StorageReport | null;
};

/**
 * Assembles the device snapshot. `now` is injected so the report is deterministic in tests.
 */
export function buildDeviceStatus(input: DeviceStatusInput, now: number = Date.now()) {
  const screens = Array.isArray(input.screens) ? input.screens as Record<string, any>[] : [];
  const heartbeats = input.heartbeats || {};
  const credentials = Array.isArray(input.credentials) ? input.credentials as Record<string, any>[] : [];
  const manifests = input.manifests || {};
  const playlists = Array.isArray(input.playlists) ? input.playlists as Record<string, any>[] : [];
  const items = Array.isArray(input.playlistItems) ? input.playlistItems as Record<string, any>[] : [];
  const media = Array.isArray(input.media) ? input.media as Record<string, any>[] : [];

  const mediaById = new Map<string, Record<string, any>>();
  for (const row of media) mediaById.set(String(row.id), row);
  const itemsByPlaylist = new Map<string, Record<string, any>[]>();
  for (const row of items) {
    const key = String(row.playlist_id);
    const list = itemsByPlaylist.get(key) || [];
    list.push(row);
    itemsByPlaylist.set(key, list);
  }
  const playlistById = new Map<string, Record<string, any>>();
  for (const row of playlists) playlistById.set(String(row.id), row);

  function playlistView(id: unknown) {
    const playlist = playlistById.get(String(id));
    if (!playlist) return null;
    const rows = [...(itemsByPlaylist.get(String(id)) || [])].sort((a, b) => Number(a.position) - Number(b.position));
    return {
      id: String(playlist.id),
      name: text(playlist.name, 120),
      enabled: Boolean(playlist.enabled),
      publishedVersion: playlist.published_version === null || playlist.published_version === undefined
        ? null
        : Number(playlist.published_version),
      draftVersion: Number(playlist.draft_version) || 0,
      itemCount: rows.length,
      items: rows.map((row) => {
        const asset = mediaById.get(String(row.media_id));
        return {
          position: Number(row.position),
          itemId: String(row.id),
          mediaId: String(row.media_id),
          name: asset ? text(asset.display_name, 120) : null,
          kind: asset ? text(asset.kind, 16) : null,
          mimeType: asset ? text(asset.mime_type, 64) : null,
          bytes: asset ? Number(asset.file_size) : null,
          durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
        };
      }),
    };
  }

  const screenReports = screens.map((screen) => {
    const id = String(screen.id);
    const history = (heartbeats[id] || []) as Record<string, any>[];
    const latest = history[0] || null;
    const screenCredentials = credentials.filter(row => String(row.screen_id) === id);
    const active = screenCredentials.filter(row => !row.revoked_at);
    const manifestRows = (manifests[id] || []) as Record<string, any>[];
    const latestManifest = manifestRows[0] || null;
    const manifestPayload = latestManifest && latestManifest.manifest && typeof latestManifest.manifest === 'object'
      ? latestManifest.manifest as Record<string, any>
      : null;
    const health = deriveScreenHealth(screen, now);
    const deviceInfo = deviceInfoView(screen.device_info);
    return {
      id,
      name: text(screen.name, 120),
      enabled: Boolean(screen.enabled),
      timezone: text(screen.timezone, 64),
      pairedAt: iso(screen.paired_at),
      createdAt: iso(screen.created_at),
      updatedAt: iso(screen.updated_at),
      // --- what the television reports about itself ---------------------------------------------
      health: {
        status: health.status,
        playerState: health.playerState,
        playerStateSince: health.playerStateSince,
        lastHeartbeatAt: health.lastHeartbeatAt,
        heartbeatAgeMs: health.heartbeatAgeMs,
        lastSyncAt: health.lastSyncAt,
        lastSyncAgeMs: ageMs(screen.last_sync_at, now),
        neverConnected: health.neverConnected,
        syncStatus: health.syncStatus,
        // `syncError` is what the user asked to see: the runtime tags it "stage:code"
        // (manifest / storage / download / verify / activate / render).
        syncError: health.syncError,
        cachedMediaCount: Number(screen.cached_media_count) || 0,
        currentPlaylistId: text(screen.current_playlist_id, 64),
        currentPlaylistVersion: screen.current_playlist_version === null || screen.current_playlist_version === undefined
          ? null
          : Number(screen.current_playlist_version),
        currentItemId: text(screen.current_item_id, 64),
        storageUsageBytes: latest && latest.storage_usage_bytes !== null && latest.storage_usage_bytes !== undefined
          ? Number(latest.storage_usage_bytes)
          : null,
        storageQuotaBytes: latest && latest.storage_quota_bytes !== null && latest.storage_quota_bytes !== undefined
          ? Number(latest.storage_quota_bytes)
          : null,
        boot: health.boot,
        recovery: health.recovery,
        selfCheck: health.health,
        commands: { pending: health.pendingCommands, issued: health.command, applied: health.applied },
      },
      deviceInfo,
      // The version the television is ACTUALLY running, as reported by its own heartbeat. The
      // player sends it inside `device_info`; a television that has not reloaded since a deploy
      // keeps reporting the old version, which is exactly what this field exists to reveal.
      reportedPlayerVersion: deviceInfo && typeof deviceInfo.playerVersion === 'string' ? deviceInfo.playerVersion : null,
      reportedRuntimeVersion: deviceInfo && typeof deviceInfo.runtimeVersion === 'string' ? deviceInfo.runtimeVersion : null,
      credentials: {
        active: active.length,
        revoked: screenCredentials.length - active.length,
        lastUsedAt: active.map(row => iso(row.last_used_at)).filter(Boolean).sort().reverse()[0] || null,
      },
      manifest: {
        latestVersion: latestManifest ? Number(latestManifest.version) : null,
        contentHash: latestManifest ? text(latestManifest.content_hash, 64) : null,
        createdAt: iso(latestManifest?.created_at),
        ageMs: ageMs(latestManifest?.created_at, now),
        assetCount: manifestPayload && Array.isArray(manifestPayload.assets) ? manifestPayload.assets.length : null,
        playlistIds: manifestPayload && Array.isArray(manifestPayload.playlists)
          ? manifestPayload.playlists.map((entry: any) => String(entry && entry.id))
          : null,
      },
      routing: {
        assignedPlaylistId: text(screen.assigned_playlist_id, 64),
        assignedPlaylist: playlistView(screen.assigned_playlist_id),
        activePlaylist: playlistView(screen.current_playlist_id),
      },
      heartbeats: history.slice(0, HEARTBEAT_HISTORY_LIMIT).map((row) => ({
        receivedAt: iso(row.received_at),
        ageMs: ageMs(row.received_at, now),
        syncStatus: text(row.sync_status, 24),
        syncError: text(row.sync_error, 300),
        cachedMediaCount: Number(row.cached_media_count) || 0,
        storageUsageBytes: row.storage_usage_bytes === null || row.storage_usage_bytes === undefined
          ? null
          : Number(row.storage_usage_bytes),
        storageQuotaBytes: row.storage_quota_bytes === null || row.storage_quota_bytes === undefined
          ? null
          : Number(row.storage_quota_bytes),
        currentPlaylistId: text(row.current_playlist_id, 64),
        currentPlaylistVersion: row.current_playlist_version === null || row.current_playlist_version === undefined
          ? null
          : Number(row.current_playlist_version),
        currentItemId: text(row.current_item_id, 64),
        deviceInfo: deviceInfoView(row.device_info),
      })),
    };
  });

  return {
    schema: DEVICE_STATUS_SCHEMA,
    generatedAt: new Date(now).toISOString(),
    deployment: {
      // What this deployment SERVES. Compare with `reportedPlayerVersion` above: a mismatch means
      // the television has not loaded the current build yet.
      playerVersion: PLAYER_VERSION,
      runtimeVersion: PLAYER_RUNTIME_VERSION,
      vercelEnv: process.env.VERCEL_ENV || null,
      gitSha: process.env.VERCEL_GIT_COMMIT_SHA ? String(process.env.VERCEL_GIT_COMMIT_SHA).slice(0, 40) : null,
    },
    counts: {
      screens: screens.length,
      playlists: playlists.length,
      media: media.length,
    },
    playlists: playlists.map(playlistView).filter(Boolean),
    media: media.map((row) => ({
      id: String(row.id),
      name: text(row.display_name, 120),
      mimeType: text(row.mime_type, 64),
      kind: text(row.kind, 16),
      bytes: Number(row.file_size),
      sha256Prefix: text(row.sha256, 12),
      compatibility: text(row.compatibility, 16),
      createdAt: iso(row.created_at),
    })),
    storage: input.storage || null,
    screens: screenReports,
  };
}

/**
 * Reads the production database and assembles the snapshot.
 *
 * Every query is best effort: a missing table or an unavailable storage endpoint is reported as an
 * error string instead of failing the whole report, so a partially configured project still
 * yields the evidence that exists.
 */
export async function readDeviceStatus(db: any, now: number = Date.now()) {
  const errors: string[] = [];
  const safe = async <T>(label: string, run: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await run(); }
    catch (error) {
      errors.push(`${label}: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`);
      return fallback;
    }
  };

  const screens = await safe('screens', async () => {
    const { data, error } = await db.from('screens').select('*').order('updated_at', { ascending: false });
    if (error) throw error;
    return (data || []) as Record<string, any>[];
  }, [] as Record<string, any>[]);

  const credentials = await safe('screen_credentials', async () => {
    const { data, error } = await db.from('screen_credentials').select('id, screen_id, created_at, last_used_at, revoked_at');
    if (error) throw error;
    return (data || []) as Record<string, any>[];
  }, [] as Record<string, any>[]);

  const heartbeats: Record<string, Record<string, any>[]> = {};
  for (const screen of screens) {
    const rows = await safe(`screen_heartbeats[${screen.id}]`, async () => {
      const { data, error } = await db
        .from('screen_heartbeats')
        .select('received_at, sync_status, sync_error, cached_media_count, storage_usage_bytes, storage_quota_bytes, current_playlist_id, current_playlist_version, current_item_id, device_info')
        .eq('screen_id', screen.id)
        .order('received_at', { ascending: false })
        .limit(HEARTBEAT_HISTORY_LIMIT);
      if (error) throw error;
      return (data || []) as Record<string, any>[];
    }, [] as Record<string, any>[]);
    heartbeats[String(screen.id)] = rows;
  }

  const manifests: Record<string, Record<string, any>[]> = {};
  for (const screen of screens) {
    const rows = await safe(`sync_manifests[${screen.id}]`, async () => {
      const { data, error } = await db
        .from('sync_manifests')
        .select('version, content_hash, manifest, created_at')
        .eq('screen_id', screen.id)
        .order('version', { ascending: false })
        .limit(2);
      if (error) throw error;
      return (data || []) as Record<string, any>[];
    }, [] as Record<string, any>[]);
    manifests[String(screen.id)] = rows;
  }

  const [playlists, playlistItems, media] = await Promise.all([
    safe('playlists', async () => {
      const { data, error } = await db.from('playlists')
        .select('id, name, enabled, draft_version, published_version, updated_at')
        .order('updated_at', { ascending: false });
      if (error) throw error;
      return (data || []) as Record<string, any>[];
    }, [] as Record<string, any>[]),
    safe('playlist_items', async () => {
      const { data, error } = await db.from('playlist_items').select('id, playlist_id, media_id, position, duration_ms');
      if (error) throw error;
      return (data || []) as Record<string, any>[];
    }, [] as Record<string, any>[]),
    safe('media', async () => {
      const { data, error } = await db.from('media')
        .select('id, display_name, mime_type, kind, file_size, sha256, compatibility, created_at')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data || []) as Record<string, any>[];
    }, [] as Record<string, any>[]),
  ]);

  // Storage: proves the media objects really exist in the bucket, independently of the database.
  const storage = await safe<StorageReport>('storage', async () => {
    const config = storageConfig();
    const client = getS3Client();
    const objects: { key: string; bytes: number }[] = [];
    let totalBytes = 0;
    let truncated = false;
    let token: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await client.send(new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: 'media/',
        MaxKeys: 200,
        ContinuationToken: token,
      }), storageRequestOptions(20_000));
      for (const entry of result.Contents || []) {
        totalBytes += Number(entry.Size || 0);
        objects.push({ key: String(entry.Key || ''), bytes: Number(entry.Size || 0) });
      }
      truncated = Boolean(result.IsTruncated);
      token = result.NextContinuationToken;
      if (!truncated || !token) break;
    }
    return {
      bucket: config.bucket,
      objectCount: objects.length,
      totalBytes,
      truncated,
      objects: objects.slice(0, 200),
      error: null,
    };
  }, { bucket: storageConfigSafe(), objectCount: null, totalBytes: null, objects: [], error: 'storage_unavailable' } as StorageReport);

  const status = buildDeviceStatus({ screens, heartbeats, credentials, manifests, playlists, playlistItems, media, storage }, now);
  return { ...status, errors: errors.length ? errors : null };
}

function storageConfigSafe() {
  try { return storageConfig().bucket; } catch { return null; }
}
