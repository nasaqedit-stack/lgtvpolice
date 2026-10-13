/*
 * The device-status snapshot.
 *
 * This is the shape of the evidence used to decide whether a real television is healthy: the build
 * it reports, how old its last authenticated heartbeat is, the `stage:code` it reports when a
 * synchronization fails, how much media it holds, and which item it says it is rendering. The
 * builder is a pure function so the contract can be tested without a database — and so a future
 * change cannot silently drop the fields an operator depends on.
 */
import { describe, expect, it } from 'vitest';
import { buildDeviceStatus } from '@/lib/server/device-status';
import { PLAYER_RUNTIME_VERSION, PLAYER_VERSION } from '@/lib/player/standalone/shell';

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const RECENT = '2026-10-13T11:59:20.000Z'; // 40 s before NOW
const OLD = '2026-10-13T09:00:00.000Z';

const SCREEN_ID = '11111111-1111-4111-8111-111111111111';
const PLAYLIST_ID = '22222222-2222-4222-8222-222222222222';
const MEDIA_ID = '33333333-3333-4333-8333-333333333333';
const ITEM_ID = '44444444-4444-4444-8444-444444444444';

function screen(overrides: Record<string, unknown> = {}) {
  return {
    id: SCREEN_ID,
    name: 'استقبال',
    timezone: 'Asia/Riyadh',
    enabled: true,
    assigned_playlist_id: PLAYLIST_ID,
    paired_at: '2026-10-07T10:00:00.000Z',
    last_seen_at: RECENT,
    last_sync_at: RECENT,
    last_sync_status: 'ready',
    last_sync_error: null,
    current_playlist_id: PLAYLIST_ID,
    current_playlist_version: 3,
    current_item_id: ITEM_ID,
    cached_media_count: 2,
    device_info: {
      userAgent: 'Mozilla/5.0 (Web0S; Linux) AppleWebKit/537.36 Chrome/38.0.2125.122 Safari/537.36',
      platform: 'Web0S',
      screenWidth: 1920,
      screenHeight: 1080,
      language: 'ar-SA',
      playerVersion: '3.0.0-4',
      runtimeVersion: '2.1.0',
      // Anything a device tries to smuggle in is dropped before it reaches an operator.
      secretToken: 'must-not-appear',
    },
    sync_command_version: 1,
    reload_command_version: 0,
    last_applied_sync_version: 1,
    last_applied_reload_version: 0,
    player_state: 'online',
    player_state_since: RECENT,
    boot_count: 4,
    last_boot_at: '2026-10-13T08:00:00.000Z',
    recovery_count: 0,
    last_recovery_at: null,
    last_recovery_reason: null,
    last_recovery_state: null,
    last_health_status: 'ok',
    last_health_checked_at: RECENT,
    created_at: '2026-10-07T09:00:00.000Z',
    updated_at: RECENT,
    ...overrides,
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    screens: [screen(overrides.screen ? overrides.screen as Record<string, unknown> : undefined)],
    heartbeats: {
      [SCREEN_ID]: [{
        received_at: RECENT,
        sync_status: 'ready',
        sync_error: null,
        cached_media_count: 2,
        storage_usage_bytes: 8_500_000,
        storage_quota_bytes: 200_000_000,
        current_playlist_id: PLAYLIST_ID,
        current_playlist_version: 3,
        current_item_id: ITEM_ID,
        device_info: { playerVersion: '3.0.0-4', runtimeVersion: '2.1.0' },
      }],
    },
    credentials: [{ id: 'c1', screen_id: SCREEN_ID, created_at: RECENT, last_used_at: RECENT, revoked_at: null }],
    manifests: {
      [SCREEN_ID]: [{
        version: 7,
        content_hash: 'a'.repeat(64),
        created_at: RECENT,
        manifest: { assets: [{}, {}], playlists: [{ id: PLAYLIST_ID }] },
      }],
    },
    playlists: [{
      id: PLAYLIST_ID,
      name: 'الرئيسية',
      enabled: true,
      draft_version: 3,
      published_version: 3,
      updated_at: RECENT,
    }],
    playlistItems: [{ id: ITEM_ID, playlist_id: PLAYLIST_ID, media_id: MEDIA_ID, position: 0, duration_ms: 8000 }],
    media: [{
      id: MEDIA_ID,
      display_name: 'poster.png',
      mime_type: 'image/png',
      kind: 'image',
      file_size: 4_200_000,
      sha256: 'b'.repeat(64),
      compatibility: 'unknown',
      created_at: OLD,
    }],
    storage: { bucket: 'signage-media', objectCount: 1, totalBytes: 4_200_000, objects: [{ key: 'media/x.png', bytes: 4_200_000 }], error: null },
    ...overrides,
  };
}

describe('buildDeviceStatus', () => {
  it('reports both the build the deployment serves and the build the television runs', () => {
    const status = buildDeviceStatus(baseInput(), NOW);
    expect(status.deployment.playerVersion).toBe(PLAYER_VERSION);
    expect(status.deployment.runtimeVersion).toBe(PLAYER_RUNTIME_VERSION);
    const device = status.screens[0];
    expect(device.reportedPlayerVersion).toBe('3.0.0-4');
    expect(device.reportedRuntimeVersion).toBe('2.1.0');
    // The whole point of the report: this television is one build behind the deployment.
    expect(device.reportedPlayerVersion).not.toBe(status.deployment.playerVersion);
  });

  it('derives the operational status from the age of the authenticated heartbeat', () => {
    const status = buildDeviceStatus(baseInput(), NOW);
    expect(status.screens[0].health.status).toBe('online');
    expect(status.screens[0].health.heartbeatAgeMs).toBe(40_000);

    const stale = buildDeviceStatus(baseInput({ screen: { last_seen_at: OLD } }), NOW);
    expect(stale.screens[0].health.status).toBe('offline');
    expect(stale.screens[0].health.heartbeatAgeMs).toBe(3 * 60 * 60_000);
  });

  it('carries the syncError stage exactly as the television reported it', () => {
    const failing = buildDeviceStatus(baseInput({
      screen: { last_sync_status: 'failed', last_sync_error: 'download:range_missing', cached_media_count: 0 },
      heartbeats: {
        [SCREEN_ID]: [{
          received_at: RECENT, sync_status: 'failed', sync_error: 'download:range_missing',
          cached_media_count: 0, storage_usage_bytes: null, storage_quota_bytes: null,
          current_playlist_id: null, current_playlist_version: null, current_item_id: null,
          device_info: { playerVersion: '3.0.0-4', runtimeVersion: '2.1.0' },
        }],
      },
    }), NOW);
    expect(failing.screens[0].health.syncError).toBe('download:range_missing');
    expect(failing.screens[0].heartbeats[0].syncError).toBe('download:range_missing');
    expect(failing.screens[0].health.cachedMediaCount).toBe(0);
  });

  it('shows the download/store/activate/render evidence in one place', () => {
    const device = buildDeviceStatus(baseInput(), NOW).screens[0];
    // stored: the television's own count and its storage usage
    expect(device.health.cachedMediaCount).toBe(2);
    expect(device.health.storageUsageBytes).toBe(8_500_000);
    // activated: the playlist version it committed to
    expect(device.health.currentPlaylistId).toBe(PLAYLIST_ID);
    expect(device.health.currentPlaylistVersion).toBe(3);
    // rendered: the single item it says is on screen right now
    expect(device.health.currentItemId).toBe(ITEM_ID);
    // and what the server handed it
    expect(device.manifest.latestVersion).toBe(7);
    expect(device.manifest.assetCount).toBe(2);
    expect(device.routing.assignedPlaylist).toMatchObject({ id: PLAYLIST_ID, itemCount: 1, publishedVersion: 3 });
  });

  it('never leaks credentials, tokens or unrecognised device fields', () => {
    const serialized = JSON.stringify(buildDeviceStatus(baseInput(), NOW));
    expect(serialized).not.toContain('secretToken');
    expect(serialized).not.toContain('token_hash');
    expect(serialized).not.toContain('credential-');
    for (const key of Object.keys(buildDeviceStatus(baseInput(), NOW).screens[0].deviceInfo || {})) {
      expect(['userAgent', 'platform', 'language', 'screenWidth', 'screenHeight', 'playerVersion', 'runtimeVersion']).toContain(key);
    }
  });

  it('reports a screen that has never connected without inventing a heartbeat', () => {
    const status = buildDeviceStatus(baseInput({
      screen: { last_seen_at: null, last_sync_at: null, last_sync_status: 'never', paired_at: null, cached_media_count: 0 },
      heartbeats: { [SCREEN_ID]: [] },
    }), NOW);
    const device = status.screens[0];
    expect(device.health.neverConnected).toBe(true);
    expect(device.health.heartbeatAgeMs).toBeNull();
    expect(device.health.status).toBe('offline');
    expect(device.heartbeats).toEqual([]);
  });

  it('keeps the heartbeat history newest first with ages relative to now', () => {
    const status = buildDeviceStatus(baseInput({
      heartbeats: {
        [SCREEN_ID]: [
          { received_at: RECENT, sync_status: 'ready', sync_error: null, cached_media_count: 2, storage_usage_bytes: 1, storage_quota_bytes: 2, current_playlist_id: PLAYLIST_ID, current_playlist_version: 3, current_item_id: ITEM_ID, device_info: {} },
          { received_at: OLD, sync_status: 'failed', sync_error: 'verify:sha_mismatch', cached_media_count: 0, storage_usage_bytes: null, storage_quota_bytes: null, current_playlist_id: null, current_playlist_version: null, current_item_id: null, device_info: {} },
        ],
      },
    }), NOW);
    const history = status.screens[0].heartbeats;
    expect(history).toHaveLength(2);
    expect(history[0].ageMs).toBe(40_000);
    expect(history[1].syncError).toBe('verify:sha_mismatch');
    expect(history[0].ageMs!).toBeLessThan(history[1].ageMs!);
  });

  it('counts active and revoked credentials without exposing them', () => {
    const status = buildDeviceStatus(baseInput({
      credentials: [
        { id: 'c1', screen_id: SCREEN_ID, created_at: OLD, last_used_at: RECENT, revoked_at: null },
        { id: 'c2', screen_id: SCREEN_ID, created_at: OLD, last_used_at: OLD, revoked_at: OLD },
      ],
    }), NOW);
    expect(status.screens[0].credentials).toEqual({ active: 1, revoked: 1, lastUsedAt: RECENT });
  });
});
