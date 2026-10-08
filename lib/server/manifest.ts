import { createHash } from 'node:crypto';
import type { ScreenManifest, PlaylistSnapshot, ScheduleRule } from '@/lib/shared';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export function hashManifest(value: unknown) {
  return createHash('sha256').update(stable(value)).digest('hex');
}

export async function buildManifestBase(db: any, screen: any) {
  const { data: scheduleRows, error: scheduleError } = await db.from('schedule_entries')
    .select('id,playlist_id,weekdays,start_time,end_time,timezone,enabled,priority')
    .eq('screen_id', screen.id).eq('enabled', true).order('priority', { ascending: false }).order('start_time', { ascending: true }).order('id', { ascending: true });
  if (scheduleError) throw scheduleError;
  const schedules = (scheduleRows ?? []) as any[];
  const scheduledPlaylistIds = schedules.map(row => row.playlist_id).filter(Boolean) as string[];
  const ids = [...new Set([screen.assigned_playlist_id, ...scheduledPlaylistIds].filter(Boolean))];
  // A screen that has neither an explicit assignment nor an enabled schedule follows the most
  // recently published playlist. Publishing is therefore enough for content to reach a paired TV
  // (the target flow: upload -> add to playlist -> publish -> /player), while an explicit
  // assignment or a schedule always wins over this fallback.
  let fallbackPlaylistId: string | null = null;
  if (!screen.assigned_playlist_id && scheduledPlaylistIds.length === 0) {
    const { data: latestPublished, error: latestError } = await db.from('playlists')
      .select('id').eq('enabled', true).not('published_version', 'is', null)
      .order('updated_at', { ascending: false }).limit(1);
    if (latestError) throw latestError;
    fallbackPlaylistId = latestPublished?.[0]?.id ?? null;
    if (fallbackPlaylistId) ids.push(fallbackPlaylistId);
  }
  let playlistRows: any[] = [];
  let revisionRows: any[] = [];
  if (ids.length) {
    const { data: foundPlaylists, error: playlistError } = await db.from('playlists')
      .select('id,name,enabled,published_version').in('id', ids).eq('enabled', true).not('published_version', 'is', null).order('id', { ascending: true });
    if (playlistError) throw playlistError;
    playlistRows = foundPlaylists ?? [];
    const current = playlistRows.filter(row => row.published_version != null);
    if (current.length) {
      const { data: revisions, error: revisionError } = await db.from('playlist_versions')
        .select('playlist_id,version,manifest,published_at')
        .in('playlist_id', current.map(row => row.id));
      if (revisionError) throw revisionError;
      revisionRows = revisions ?? [];
    }
  }
  const playlists: PlaylistSnapshot[] = playlistRows.map((playlist: any) => {
    const revision = revisionRows.find((row: any) => row.playlist_id === playlist.id && row.version === playlist.published_version);
    if (!revision) return null;
    const snapshot = revision.manifest as any;
    return {
      id: playlist.id,
      name: snapshot.name ?? playlist.name,
      version: Number(revision.version),
      enabled: true,
      items: Array.isArray(snapshot.items) ? [...snapshot.items].sort((a: any, b: any) => a.position - b.position) : [],
    };
  }).filter(Boolean) as PlaylistSnapshot[];
  const readyIds = new Set(playlists.map(playlist => playlist.id));
  const usableSchedules: ScheduleRule[] = schedules
    .filter(row => readyIds.has(row.playlist_id))
    .map(row => ({
      id: row.id,
      playlistId: row.playlist_id,
      weekdays: Array.isArray(row.weekdays) ? row.weekdays.map(Number) : [1, 2, 3, 4, 5, 6, 7],
      startTime: row.start_time,
      endTime: row.end_time,
      timezone: row.timezone || screen.timezone || 'Asia/Riyadh',
      enabled: Boolean(row.enabled),
    }));
  const assignedPlaylistId = screen.assigned_playlist_id && readyIds.has(screen.assigned_playlist_id) ? screen.assigned_playlist_id : null;
  const defaultPlaylistId = assignedPlaylistId ?? (fallbackPlaylistId && readyIds.has(fallbackPlaylistId) ? fallbackPlaylistId : null);
  const byMedia = new Map<string, { mediaId: string; hash: string; size: number; mimeType: string; name: string }>();
  for (const playlist of playlists) {
    for (const item of playlist.items) {
      if (!byMedia.has(item.mediaId)) byMedia.set(item.mediaId, {
        mediaId: item.mediaId, hash: item.hash, size: Number(item.size), mimeType: item.mimeType, name: item.name,
      });
    }
  }
  const base = {
    schemaVersion: 1 as const,
    screen: { id: screen.id, name: screen.name, timezone: screen.timezone || 'Asia/Riyadh' },
    defaultPlaylistId,
    playlists,
    schedules: usableSchedules,
    assets: [...byMedia.values()].sort((a, b) => a.mediaId.localeCompare(b.mediaId)),
    commands: {
      syncVersion: Number(screen.sync_command_version || 0),
      reloadVersion: Number(screen.reload_command_version || 0),
      // The versions the television has already ACKnowledged. Echoing them lets the player detect a
      // command it has already executed without having to trust its own storage alone, which is the
      // only defence against a reload replaying a reload.
      applied: {
        syncVersion: Number(screen.last_applied_sync_version || 0),
        reloadVersion: Number(screen.last_applied_reload_version || 0),
      },
    },
  };
  return { base, hash: hashManifest(base) };
}

export async function versionAndFormatManifest(db: any, screen: any) {
  const { base, hash } = await buildManifestBase(db, screen);
  const { data, error } = await db.rpc('save_sync_manifest', {
    p_screen_id: screen.id,
    p_hash: hash,
    p_manifest: base,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  const version = Number(row?.manifest_version ?? row?.version ?? 1);
  const manifest: ScreenManifest = {
    ...base,
    manifestVersion: version,
    manifestHash: hash,
    generatedAt: new Date().toISOString(),
  };
  return { manifest, changed: Boolean(row?.changed), etag: `"${hash}"` };
}
