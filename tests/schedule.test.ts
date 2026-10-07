import { describe, expect, it } from 'vitest';
import type { ScreenManifest } from '../lib/shared';
import { scheduledPlaylistId } from '../lib/player/schedule';

function makeManifest(): ScreenManifest {
  return {
    schemaVersion: 1,
    screen: { id: 'screen', name: 'Test', timezone: 'UTC' },
    manifestVersion: 1, manifestHash: 'a'.repeat(64), generatedAt: '2026-10-05T00:00:00Z',
    defaultPlaylistId: 'default', playlists: [], assets: [],
    schedules: [
      { id: 'morning', playlistId: 'morning-list', weekdays: [1], startTime: '08:00', endTime: '12:00', timezone: 'UTC', enabled: true },
      { id: 'night', playlistId: 'night-list', weekdays: [1], startTime: '22:00', endTime: '02:00', timezone: 'UTC', enabled: true },
    ],
    commands: { syncVersion: 0, reloadVersion: 0 },
  };
}

describe('offline schedule evaluation', () => {
  it('selects a weekday playlist using the configured local timezone', () => {
    const value = makeManifest();
    expect(scheduledPlaylistId(value, new Date('2026-10-05T09:30:00Z'))).toBe('morning-list');
    expect(scheduledPlaylistId(value, new Date('2026-10-05T13:00:00Z'))).toBe('default');
  });
  it('supports schedules that cross midnight and weekday rollover', () => {
    const value = makeManifest();
    expect(scheduledPlaylistId(value, new Date('2026-10-05T23:30:00Z'))).toBe('night-list');
    expect(scheduledPlaylistId(value, new Date('2026-10-06T01:30:00Z'))).toBe('night-list');
    expect(scheduledPlaylistId(value, new Date('2026-10-06T03:00:00Z'))).toBe('default');
  });
  it('falls back to the default when no schedule matches', () => {
    const value = makeManifest();
    expect(scheduledPlaylistId(value, new Date('2026-10-06T11:00:00Z'))).toBe('default');
  });
});
