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
  commands: {
    syncVersion: number;
    reloadVersion: number;
    /**
     * The versions the server has already seen ACKnowledged by this screen. Echoed on every
     * manifest so a television that lost its local store cannot re-execute a command it already
     * ran. Absent on manifests generated before the field existed.
     */
    applied?: { syncVersion: number; reloadVersion: number };
  };
};

export type CachedManifest = Omit<ScreenManifest, 'manifestHash' | 'generatedAt'> & {
  manifestHash: string;
  generatedAt: string;
};

export type StorageStats = { usage: number | null; quota: number | null; persisted: boolean | null };

/* ---------------------------------------------------------------------------
 * Multipart upload partitioning.
 *
 * ONE implementation of the byte-range maths, imported by the browser (which
 * slices the File) and by the API routes (which presign parts, report session
 * state and validate finalization). Client and server can therefore not drift
 * apart about how large a part is supposed to be: `uploadPartRange()` is the
 * only place a part boundary is ever computed.
 * ------------------------------------------------------------------------ */

/** Configured length of every part except the last one. */
export const UPLOAD_PART_SIZE = 8 * 1024 * 1024;
/** Per-file ceiling enforced by the upload session and the media page. */
export const MAX_UPLOAD_FILE_SIZE = 2 * 1024 * 1024 * 1024;

export type UploadPartRange = { partNumber: number; start: number; end: number; size: number };

/** How many parts a file of `fileSize` bytes is split into (0 for an empty/invalid size). */
export function uploadPartCount(fileSize: number): number {
  if (!Number.isFinite(fileSize) || fileSize <= 0) return 0;
  return Math.ceil(fileSize / UPLOAD_PART_SIZE);
}

/**
 * Slice bounds of one part, 1-based.
 *
 * `start` is inclusive and `end` is exclusive, exactly like `Blob.slice(start, end)`,
 * so `end - start` is the byte length of the part. The final part is whatever bytes
 * remain, i.e. it is smaller than `UPLOAD_PART_SIZE` unless the file is an exact
 * multiple of it.
 */
export function uploadPartRange(fileSize: number, partNumber: number): UploadPartRange {
  const totalParts = uploadPartCount(fileSize);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > totalParts) {
    throw new RangeError(`partNumber ${partNumber} is outside the valid range 1..${totalParts}`);
  }
  const start = (partNumber - 1) * UPLOAD_PART_SIZE;
  const end = Math.min(start + UPLOAD_PART_SIZE, fileSize);
  return { partNumber, start, end, size: end - start };
}

/** Expected byte length of one part. */
export function uploadPartSize(fileSize: number, partNumber: number): number {
  return uploadPartRange(fileSize, partNumber).size;
}

/** The complete ordered partition of a file: `[{ partNumber, start, end, size }, …]`. */
export function uploadPartRanges(fileSize: number): UploadPartRange[] {
  return Array.from({ length: uploadPartCount(fileSize) }, (_unused, index) => uploadPartRange(fileSize, index + 1));
}

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
