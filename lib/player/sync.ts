'use client';

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { ScreenManifest } from '@/lib/shared';
import {
  activateManifest, clearStalePartial, deleteUnreferencedAssets, finalizeAsset, getActiveManifest,
  getLastSyncAt, getPartialInfo, getStorageStats, getStoredParts, hasCompleteAsset, requestPersistentStorage, saveChunk,
  setLastSyncAt,
} from '@/lib/player/storage';

const CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_RETRIES = 3;
export type SyncProgress = {
  phase: 'manifest' | 'checking' | 'downloading' | 'verifying' | 'activating' | 'ready';
  message: string;
  totalBytes: number;
  downloadedBytes: number;
  currentName?: string;
};

export class PlayerSyncError extends Error {
  constructor(message: string, public code = 'sync_failed') { super(message); this.name = 'PlayerSyncError'; }
}

function isManifest(value: any): value is ScreenManifest {
  return Boolean(value && value.schemaVersion === 1 && value.screen?.id && typeof value.manifestHash === 'string'
    && Array.isArray(value.playlists) && Array.isArray(value.assets) && Array.isArray(value.schedules));
}
function protectedHashes(manifest: ScreenManifest | null) {
  return manifest?.assets.map(asset => asset.hash) ?? [];
}
function uniqueByHash(manifest: ScreenManifest) {
  const result = new Map<string, ScreenManifest['assets'][number]>();
  for (const asset of manifest.assets) {
    if (!/^[a-f0-9]{64}$/.test(asset.hash) || !Number.isSafeInteger(asset.size) || asset.size < 1) {
      throw new PlayerSyncError('البيان يحتوي على ملف أو حجم غير صالح.', 'invalid_manifest');
    }
    if (!result.has(asset.hash)) result.set(asset.hash, asset);
  }
  return [...result.values()];
}
function hasPlayableContent(manifest: ScreenManifest) {
  return manifest.playlists.some(playlist => playlist.enabled && playlist.items.length > 0)
    && (Boolean(manifest.defaultPlaylistId) || manifest.schedules.length > 0);
}
async function authorizedFetch(path: string, token: string, init: RequestInit = {}) {
  let response: Response;
  try {
    response = await fetch(path, { ...init, cache: 'no-store', headers: { ...init.headers, Authorization: `Bearer ${token}` } });
  } catch {
    throw new PlayerSyncError('تعذر الاتصال بالخادم. سيستمر العرض المحلي.', 'network_offline');
  }
  if (response.status === 401) throw new PlayerSyncError('تم إلغاء ربط هذه الشاشة. أعد ربطها من لوحة الإدارة.', 'screen_unauthorized');
  if (response.status === 403) throw new PlayerSyncError('الشاشة معطّلة على الخادم. يستمر المحتوى المحلي حتى يتوفر اتصال.', 'screen_disabled');
  return response;
}
async function getFreshUrl(token: string, mediaId: string): Promise<string> {
  const response = await authorizedFetch('/api/player/media-urls', token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaIds: [mediaId] }),
  });
  if (!response.ok) throw new PlayerSyncError('تعذر الحصول على رابط تنزيل آمن.', 'url_unavailable');
  const value = await response.json();
  const url = value?.urls?.[mediaId];
  if (typeof url !== 'string') throw new PlayerSyncError('رابط الوسيط غير موجود في استجابة الخادم.', 'url_unavailable');
  return url;
}

async function downloadRange(url: string, start: number, end: number): Promise<Response> {
  try {
    return await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, cache: 'no-store' });
  } catch {
    throw new PlayerSyncError('انقطع الاتصال أثناء تنزيل الوسيط.', 'download_interrupted');
  }
}

// Same-origin fallback for TVs that cannot use the cross-origin signed storage URL (restricted
// CORS, an old webOS network stack, an expired signature or a blocked host). The server re-checks
// the screen credential and the published manifest on every range request, so the private bucket
// stays private. Returns null when the fallback itself is unreachable.
async function downloadFallback(token: string, mediaId: string, start: number, end: number): Promise<Response | null> {
  try {
    return await fetch(`/api/player/media/${mediaId}`, {
      headers: { Range: `bytes=${start}-${end}`, Authorization: `Bearer ${token}` }, cache: 'no-store',
    });
  } catch { return null; }
}

// Statuses that mean "this URL cannot serve the range for this client" rather than a transient
// failure: the caller retries through the same-origin fallback instead of giving up.
function unusableUrl(status: number) {
  return status === 400 || status === 401 || status === 403 || status === 404 || status === 405 || status === 501;
}

async function storeStream(response: Response, asset: ScreenManifest['assets'][number], startIndex: number, onBytes: (count: number) => void) {
  const reader = response.body?.getReader();
  if (!reader) {
    // Compatibility fallback for older WebOS browsers without ReadableStream. Range requests remain preferred.
    const blob = await response.blob();
    if (blob.size !== asset.size) throw new PlayerSyncError('حجم الملف الذي تم تنزيله غير مكتمل.', 'size_mismatch');
    for (let offset = 0, index = 0; offset < blob.size; offset += CHUNK_SIZE, index += 1) {
      const part = blob.slice(offset, Math.min(offset + CHUNK_SIZE, blob.size), asset.mimeType);
      await saveChunk(asset.hash, index, part, asset.size, asset.mimeType, CHUNK_SIZE);
      onBytes(part.size);
    }
    return;
  }
  let buffer = new Uint8Array(CHUNK_SIZE);
  let bufferLength = 0;
  let index = startIndex;
  let total = startIndex * CHUNK_SIZE;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      let position = 0;
      while (position < value.length) {
        const copy = Math.min(CHUNK_SIZE - bufferLength, value.length - position);
        buffer.set(value.subarray(position, position + copy), bufferLength);
        bufferLength += copy;
        position += copy;
        total += copy;
        onBytes(copy);
        if (bufferLength === CHUNK_SIZE) {
          await saveChunk(asset.hash, index, new Blob([buffer], { type: asset.mimeType }), asset.size, asset.mimeType, CHUNK_SIZE);
          index += 1;
          buffer = new Uint8Array(CHUNK_SIZE);
          bufferLength = 0;
        }
      }
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* ignored */ }
    throw error;
  }
  if (bufferLength) await saveChunk(asset.hash, index, new Blob([buffer.slice(0, bufferLength)], { type: asset.mimeType }), asset.size, asset.mimeType, CHUNK_SIZE);
  if (total !== asset.size) throw new PlayerSyncError('انتهى التنزيل قبل اكتمال الملف.', 'size_mismatch');
}

async function verifyStoredAsset(asset: ScreenManifest['assets'][number], onProgress: (phase: SyncProgress['phase'], increment: number) => void) {
  const parts = await getStoredParts(asset.hash);
  const digest = sha256.create();
  let size = 0;
  for (const part of parts) {
    const data = new Uint8Array(await part.blob.arrayBuffer());
    digest.update(data);
    size += data.byteLength;
    onProgress('verifying', data.byteLength);
  }
  if (size !== asset.size) throw new PlayerSyncError('فشل فحص حجم الملف بعد التنزيل.', 'size_mismatch');
  if (bytesToHex(digest.digest()) !== asset.hash) throw new PlayerSyncError('فشل التحقق من بصمة الملف. يحتفظ المشغل بالقائمة السابقة.', 'hash_mismatch');
}

async function downloadAsset(token: string, asset: ScreenManifest['assets'][number], onProgress: (count: number) => void) {
  const info = await getPartialInfo(asset.hash);
  if (info && (info.expectedSize !== asset.size || info.mimeType !== asset.mimeType || info.chunkSize !== CHUNK_SIZE)) {
    await clearStalePartial(asset.hash);
  }
  let parts = await getStoredParts(asset.hash);
  let offset = 0;
  let index = 0;
  for (const part of parts) {
    if (part.index !== index || part.size <= 0 || (index < parts.length - 1 && part.size !== CHUNK_SIZE)) {
      await clearStalePartial(asset.hash);
      parts = [];
      break;
    }
    offset += part.size;
    index += 1;
  }
  if (offset > asset.size || (parts.length && offset < asset.size && parts.at(-1)?.size !== CHUNK_SIZE)) {
    await clearStalePartial(asset.hash);
    offset = 0;
    index = 0;
  }
  await requestPersistentStorage();
  let url = await getFreshUrl(token, asset.mediaId);
  let refreshedUrl = false;
  let failures = 0;
  while (offset < asset.size) {
    const end = Math.min(offset + CHUNK_SIZE, asset.size) - 1;
    let response: Response;
    try {
      response = await downloadRange(url, offset, end);
    } catch (error) {
      // A network-level failure (unreachable storage host, CORS block, offline moment) gets one
      // same-origin attempt before it counts as a retry.
      const fallback = await downloadFallback(token, asset.mediaId, offset, end);
      if (!fallback) {
        failures += 1;
        if (failures >= MAX_RETRIES) throw error;
        await new Promise(resolve => setTimeout(resolve, 500 * (2 ** (failures - 1))));
        continue;
      }
      response = fallback;
    }
    if ((response.status === 401 || response.status === 403) && !refreshedUrl) {
      url = await getFreshUrl(token, asset.mediaId);
      refreshedUrl = true;
      try { response = await downloadRange(url, offset, end); } catch { /* handled by the same-origin fallback below */ }
    }
    if (unusableUrl(response.status)) {
      const fallback = await downloadFallback(token, asset.mediaId, offset, end);
      if (!fallback) throw new PlayerSyncError('تعذر الوصول إلى الوسيط من الخادم أو من التخزين.', 'download_rejected');
      response = fallback;
    }
    if (unusableUrl(response.status)) {
      throw new PlayerSyncError(`رفض خادم الملفات طلب التنزيل (${response.status}).`, 'download_rejected');
    }
    if (response.status === 206) {
      const chunk = await response.blob();
      const expected = end - offset + 1;
      // Some S3-compatible gateways ignore the requested end bound and return the rest of the
      // object. Keep only the requested window so the part bookkeeping stays exact: the final
      // SHA-256 verification still covers the complete file before it is activated.
      const part = chunk.size > expected ? chunk.slice(0, expected) : chunk;
      if (part.size !== expected) throw new PlayerSyncError('حجم جزء التنزيل غير مطابق.', 'range_size_mismatch');
      await saveChunk(asset.hash, index, part, asset.size, asset.mimeType, CHUNK_SIZE);
      offset += part.size;
      index += 1;
      onProgress(part.size);
      failures = 0;
      continue;
    }
    if (response.status === 200 && offset > 0) {
      await clearStalePartial(asset.hash);
      offset = 0;
      index = 0;
      parts = [];
      continue;
    }
    if (response.status === 200 && offset === 0) {
      await storeStream(response, asset, 0, onProgress);
      offset = asset.size;
      break;
    }
    if (response.status === 416 && offset === asset.size) break;
    if (response.status >= 500 || response.status === 429) {
      failures += 1;
      if (failures >= MAX_RETRIES) throw new PlayerSyncError('تعذر تنزيل الوسيط بعد عدة محاولات. ستُحفظ الأجزاء المكتملة لإعادة المحاولة.', 'download_retries_exhausted');
      await new Promise(resolve => setTimeout(resolve, 500 * (2 ** (failures - 1))));
      continue;
    }
    throw new PlayerSyncError(`رفض خادم الملفات طلب التنزيل (${response.status}).`, 'download_rejected');
  }
  try {
    await verifyStoredAsset(asset, () => undefined);
  } catch (error) {
    await clearStalePartial(asset.hash);
    throw error;
  }
  const chunkCount = Math.ceil(asset.size / CHUNK_SIZE);
  await finalizeAsset(asset.hash, asset.size, asset.mimeType, chunkCount);
}

export async function synchronizePlayer(
  token: string,
  onProgress: (progress: SyncProgress) => void,
): Promise<{ manifest: ScreenManifest; changed: boolean; lastSyncAt: string }> {
  onProgress({ phase: 'manifest', message: 'التحقق من تحديثات المحتوى…', totalBytes: 0, downloadedBytes: 0 });
  const previous = await getActiveManifest();
  const headers: Record<string, string> = {};
  if (previous?.manifestHash) headers['If-None-Match'] = `"${previous.manifestHash}"`;
  let response = await authorizedFetch('/api/player/manifest', token, { headers });
  if (response.status === 304 && previous) {
    const complete = await Promise.all(previous.assets.map(asset => hasCompleteAsset(asset.hash, asset.size, asset.mimeType)));
    if (complete.every(Boolean)) {
      onProgress({ phase: 'ready', message: 'المحتوى المحلي محدث.', totalBytes: 0, downloadedBytes: 0 });
      return { manifest: previous, changed: false, lastSyncAt: (await getStoredLastSync(previous)) };
    }
    response = await authorizedFetch('/api/player/manifest', token);
  }
  if (!response.ok) throw new PlayerSyncError('تعذر قراءة بيان المحتوى من الخادم.', 'manifest_unavailable');
  const incoming = await response.json();
  if (!isManifest(incoming)) throw new PlayerSyncError('بيان المحتوى غير مكتمل أو غير صالح.', 'invalid_manifest');
  if (!hasPlayableContent(incoming)) {
    if (previous) return { manifest: previous, changed: false, lastSyncAt: await getStoredLastSync(previous) };
    throw new PlayerSyncError('لم يتم نشر قائمة تشغيل تحتوي على وسائط لهذه الشاشة.', 'no_published_content');
  }
  const assets = uniqueByHash(incoming);
  const previousHashes = protectedHashes(previous);
  const targetHashes = assets.map(asset => asset.hash);
  await deleteUnreferencedAssets([...new Set([...previousHashes, ...targetHashes])]);
  onProgress({ phase: 'checking', message: 'فحص التخزين المحلي والوسائط المطلوبة…', totalBytes: 0, downloadedBytes: 0 });
  const missing: typeof assets = [];
  for (const asset of assets) {
    if (!await hasCompleteAsset(asset.hash, asset.size, asset.mimeType)) missing.push(asset);
  }
  const totalBytes = missing.reduce((sum, asset) => sum + asset.size, 0);
  if (totalBytes > 0) {
    const stats = await getStorageStats();
    if (stats.quota !== null && stats.usage !== null) {
      const free = Math.max(0, stats.quota - stats.usage);
      const reserve = Math.max(16 * 1024 * 1024, Math.ceil(stats.quota * 0.03));
      if (free < totalBytes + reserve) {
        throw new PlayerSyncError(`المساحة المحلية غير كافية. يلزم ${Math.ceil(totalBytes / 1048576)} ميجابايت إضافية تقريباً. القائمة الحالية لم تتغير.`, 'storage_quota');
      }
    }
  }
  let completedBytes = 0;
  for (const asset of missing) {
    onProgress({ phase: 'downloading', message: 'تنزيل الوسائط إلى التخزين المحلي…', totalBytes, downloadedBytes: completedBytes, currentName: asset.name });
    await downloadAsset(token, asset, count => {
      completedBytes += count;
      onProgress({ phase: 'downloading', message: 'تنزيل الوسائط إلى التخزين المحلي…', totalBytes, downloadedBytes: completedBytes, currentName: asset.name });
    });
  }
  onProgress({ phase: 'activating', message: 'التحقق من الملفات وتجهيز القائمة الجديدة…', totalBytes, downloadedBytes: completedBytes });
  // Re-check every reference before the active manifest pointer is atomically switched.
  for (const asset of assets) {
    if (!await hasCompleteAsset(asset.hash, asset.size, asset.mimeType)) throw new PlayerSyncError('لم تكتمل مزامنة كل الوسائط. تبقى قائمة التشغيل السابقة نشطة.', 'partial_sync');
  }
  await activateManifest(incoming);
  const now = new Date().toISOString();
  await setLastSyncAt(now);
  await deleteUnreferencedAssets(targetHashes);
  onProgress({ phase: 'ready', message: 'اكتملت المزامنة. يمكن الآن التشغيل دون إنترنت.', totalBytes, downloadedBytes: totalBytes });
  return { manifest: incoming, changed: !previous || previous.manifestHash !== incoming.manifestHash, lastSyncAt: now };
}

async function getStoredLastSync(manifest: ScreenManifest) {
  return await getLastSyncAt() ?? manifest.generatedAt;
}
