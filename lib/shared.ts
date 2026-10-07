export type MediaKind = 'image' | 'video';

export type ManifestItem = {
  id: string;
  mediaId: string;
  name: string;
  hash: string;
  size: number;
  mimeType: string;
  kind: MediaKind;
  durationMs: number | null;
  loop: boolean;
  position: number;
};

export type PlaylistSnapshot = {
  id: string;
  name: string;
  version: number;
  enabled: boolean;
  items: ManifestItem[];
};

export type ScheduleRule = {
  id: string;
  playlistId: string;
  weekdays: number[];
  startTime: string;
  endTime: string;
  timezone: string;
  enabled: boolean;
};

export type ScreenManifest = {
  schemaVersion: 1;
  screen: { id: string; name: string; timezone: string };
  manifestVersion: number;
  manifestHash: string;
  generatedAt: string;
  defaultPlaylistId: string | null;
  playlists: PlaylistSnapshot[];
  schedules: ScheduleRule[];
  assets: Array<{ mediaId: string; hash: string; size: number; mimeType: string; name: string }>;
  commands: { syncVersion: number; reloadVersion: number };
};

export type CachedManifest = Omit<ScreenManifest, 'manifestHash' | 'generatedAt'> & {
  manifestHash: string;
  generatedAt: string;
};

export type StorageStats = { usage: number | null; quota: number | null; persisted: boolean | null };

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${value} بايت`;
  const units = ['كيلوبايت', 'ميجابايت', 'جيجابايت', 'تيرابايت'];
  let amount = value / 1024;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${new Intl.NumberFormat('ar', { maximumFractionDigits: 1 }).format(amount)} ${units[index]}`;
}
