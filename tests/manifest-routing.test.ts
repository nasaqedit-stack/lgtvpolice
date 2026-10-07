import { describe, expect, it } from 'vitest';
import { buildManifestBase } from '../lib/server/manifest';

type Row = Record<string, any>;

/** Minimal stand-in for the supabase-js query builder used by buildManifestBase. */
function fakeDb(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const builder: any = {
        select: () => builder,
        eq: (column: string, value: unknown) => { rows = rows.filter(row => row[column] === value); return builder; },
        in: (column: string, values: unknown[]) => { rows = rows.filter(row => values.includes(row[column])); return builder; },
        not: (column: string, operator: string, value: unknown) => {
          if (operator === 'is' && value === null) rows = rows.filter(row => row[column] !== null && row[column] !== undefined);
          return builder;
        },
        order: (column: string, options?: { ascending?: boolean }) => {
          const ascending = options?.ascending !== false;
          rows.sort((left, right) => (left[column] > right[column] ? 1 : left[column] < right[column] ? -1 : 0) * (ascending ? 1 : -1));
          return builder;
        },
        limit: (count: number) => { rows = rows.slice(0, count); return builder; },
        then: (resolve: (value: { data: Row[]; error: null }) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve),
      };
      return builder;
    },
  };
}

const screenId = '00000000-0000-4000-8000-0000000000a1';
const oldPlaylist = '00000000-0000-4000-8000-0000000000a2';
const newPlaylist = '00000000-0000-4000-8000-0000000000a3';
const draftPlaylist = '00000000-0000-4000-8000-0000000000a4';
const mediaId = '00000000-0000-4000-8000-0000000000a5';
const item = (position: number) => ({
  id: `item-${position}`, mediaId, name: 'notice.png', hash: 'a'.repeat(64), size: 1024,
  mimeType: 'image/png', kind: 'image', durationMs: 10000, loop: false, position,
});

function fixtures() {
  return fakeDb({
    schedule_entries: [],
    playlists: [
      { id: oldPlaylist, name: 'Old', enabled: true, published_version: 3, updated_at: '2026-10-01T00:00:00.000Z' },
      { id: newPlaylist, name: 'New', enabled: true, published_version: 1, updated_at: '2026-10-07T00:00:00.000Z' },
      { id: draftPlaylist, name: 'Draft', enabled: true, published_version: null, updated_at: '2026-10-08T00:00:00.000Z' },
    ],
    playlist_versions: [
      { playlist_id: oldPlaylist, version: 3, manifest: { name: 'Old', items: [item(0)] }, published_at: '2026-10-01T00:00:00.000Z' },
      { playlist_id: newPlaylist, version: 1, manifest: { name: 'New', items: [item(0)] }, published_at: '2026-10-07T00:00:00.000Z' },
    ],
  });
}

const screen = (assigned: string | null) => ({ id: screenId, name: 'Lobby', timezone: 'Asia/Riyadh', assigned_playlist_id: assigned, sync_command_version: 0, reload_command_version: 0 });

describe('manifest playlist routing', () => {
  it('routes the most recently published playlist to a screen without an assignment or schedule', async () => {
    const { base } = await buildManifestBase(fixtures(), screen(null));
    expect(base.defaultPlaylistId).toBe(newPlaylist);
    expect(base.playlists.map((playlist: any) => playlist.id)).toEqual([newPlaylist]);
    expect(base.assets).toHaveLength(1);
  });

  it('keeps an explicit assignment even when a newer playlist was published', async () => {
    const { base } = await buildManifestBase(fixtures(), screen(oldPlaylist));
    expect(base.defaultPlaylistId).toBe(oldPlaylist);
    expect(base.playlists.map((playlist: any) => playlist.id)).toEqual([oldPlaylist]);
  });

  it('does not route an unpublished draft to an unassigned screen', async () => {
    const draftOnly = fakeDb({
      schedule_entries: [],
      playlists: [{ id: draftPlaylist, name: 'Draft', enabled: true, published_version: null, updated_at: '2026-10-08T00:00:00.000Z' }],
      playlist_versions: [],
    });
    const { base } = await buildManifestBase(draftOnly, screen(null));
    expect(base.defaultPlaylistId).toBeNull();
    expect(base.playlists).toEqual([]);
    expect(base.assets).toEqual([]);
  });

  it('includes the scheduled playlist when an enabled schedule exists', async () => {
    const tables = {
      schedule_entries: [{ id: 'rule-1', screen_id: screenId, playlist_id: oldPlaylist, weekdays: [1, 2, 3, 4, 5, 6, 7], start_time: '08:00', end_time: '12:00', timezone: 'Asia/Riyadh', enabled: true, priority: 1 }],
      playlists: [
        { id: oldPlaylist, name: 'Old', enabled: true, published_version: 3, updated_at: '2026-10-01T00:00:00.000Z' },
        { id: newPlaylist, name: 'New', enabled: true, published_version: 1, updated_at: '2026-10-07T00:00:00.000Z' },
      ],
      playlist_versions: [{ playlist_id: oldPlaylist, version: 3, manifest: { name: 'Old', items: [item(0)] }, published_at: '2026-10-01T00:00:00.000Z' }],
    };
    const { base } = await buildManifestBase(fakeDb(tables), screen(null));
    expect(base.playlists.map((playlist: any) => playlist.id)).toEqual([oldPlaylist]);
    expect(base.schedules).toHaveLength(1);
    expect(base.schedules[0].playlistId).toBe(oldPlaylist);
    // A schedule is explicit routing: the unassigned newest-published fallback stays out of it.
    expect(base.defaultPlaylistId).toBeNull();
  });
});
