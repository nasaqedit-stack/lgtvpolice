'use client';

import type { ScreenManifest } from '@/lib/shared';

const DB_NAME = 'digital-signage-player';
const DB_VERSION = 1;
const CHUNK_INDEX = 'by-hash';

type AssetRecord = { hash: string; size: number; mimeType: string; chunkCount: number; verifiedAt: string; complete: true };
type PartRecord = { key: string; hash: string; index: number; blob: Blob; size: number };
type PartialRecord = { hash: string; expectedSize: number; mimeType: string; chunkSize: number; updatedAt: string };
type KeyValue = { key: string; value: unknown };

type PlayerDB = IDBDatabase;
let dbPromise: Promise<PlayerDB> | undefined;

function openDatabase(): Promise<PlayerDB> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB غير متاح في هذا المتصفح.'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('credentials')) db.createObjectStore('credentials', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'hash' });
      if (!db.objectStoreNames.contains('parts')) {
        const store = db.createObjectStore('parts', { keyPath: 'key' });
        store.createIndex(CHUNK_INDEX, 'hash', { unique: false });
      }
      if (!db.objectStoreNames.contains('partials')) db.createObjectStore('partials', { keyPath: 'hash' });
      if (!db.objectStoreNames.contains('manifests')) db.createObjectStore('manifests', { keyPath: 'manifestHash' });
    };
    open.onsuccess = () => {
      const db = open.result;
      db.onversionchange = () => { db.close(); dbPromise = undefined; };
      resolve(db);
    };
    open.onerror = () => { dbPromise = undefined; reject(open.error ?? new Error('تعذر فتح التخزين المحلي.')); };
    open.onblocked = () => reject(new Error('التخزين المحلي مشغول في نافذة أخرى.'));
  });
  return dbPromise;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('تعذر قراءة التخزين المحلي.'));
  });
}
function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('أُلغيت عملية التخزين المحلي.'));
    transaction.onerror = () => reject(transaction.error ?? new Error('فشلت عملية التخزين المحلي.'));
  });
}

async function getOne<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDatabase();
  const tx = db.transaction(storeName, 'readonly');
  const result = await requestResult(tx.objectStore(storeName).get(key)) as T | undefined;
  await transactionDone(tx);
  return result;
}
async function getAll<T>(storeName: string): Promise<T[]> {
  const db = await openDatabase();
  const tx = db.transaction(storeName, 'readonly');
  const result = await requestResult(tx.objectStore(storeName).getAll()) as T[];
  await transactionDone(tx);
  return result;
}

export async function storeCredential(token: string) {
  const db = await openDatabase();
  const tx = db.transaction('credentials', 'readwrite');
  tx.objectStore('credentials').put({ key: 'screen', token, savedAt: new Date().toISOString() });
  await transactionDone(tx);
}
export async function readCredential(): Promise<string | null> {
  const record = await getOne<{ key: string; token: string }>('credentials', 'screen');
  return record?.token ?? null;
}
export async function clearCredential() {
  const db = await openDatabase();
  const tx = db.transaction('credentials', 'readwrite');
  tx.objectStore('credentials').delete('screen');
  await transactionDone(tx);
}

export async function getActiveManifest(): Promise<ScreenManifest | null> {
  const pointer = await getOne<KeyValue>('meta', 'activeManifest');
  if (typeof pointer?.value !== 'string') return null;
  const row = await getOne<{ manifestHash: string; manifest: ScreenManifest }>('manifests', pointer.value);
  return row?.manifest ?? null;
}

export async function activateManifest(manifest: ScreenManifest) {
  const db = await openDatabase();
  const check = db.transaction('assets', 'readonly');
  const store = check.objectStore('assets');
  let missingHash: string | null = null;
  for (const hash of new Set(manifest.assets.map(asset => asset.hash))) {
    const asset = await requestResult(store.get(hash)) as AssetRecord | undefined;
    if (!asset?.complete && !missingHash) missingHash = hash;
  }
  await transactionDone(check);
  if (missingHash) throw new Error(`لا يمكن تفعيل قائمة ناقصة: الملف ${missingHash.slice(0, 8)} غير مكتمل.`);
  const tx = db.transaction(['manifests', 'meta'], 'readwrite');
  tx.objectStore('manifests').put({ manifestHash: manifest.manifestHash, manifest, activatedAt: new Date().toISOString() });
  tx.objectStore('meta').put({ key: 'activeManifest', value: manifest.manifestHash });
  await transactionDone(tx);
}

export async function getLastSyncAt(): Promise<string | null> {
  const row = await getOne<KeyValue>('meta', 'lastSyncAt');
  return typeof row?.value === 'string' ? row.value : null;
}
export async function setLastSyncAt(value: string) {
  const db = await openDatabase();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key: 'lastSyncAt', value });
  await transactionDone(tx);
}
export async function getSeenReloadVersion(): Promise<number> {
  const row = await getOne<KeyValue>('meta', 'seenReloadVersion');
  return Number(row?.value ?? 0);
}
export async function setSeenReloadVersion(value: number) {
  const db = await openDatabase();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key: 'seenReloadVersion', value });
  await transactionDone(tx);
}
export async function getAudioEnabled(): Promise<boolean> {
  const row = await getOne<KeyValue>('meta', 'audioEnabled');
  return row?.value === true;
}
export async function setAudioEnabled(value: boolean) {
  const db = await openDatabase();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key: 'audioEnabled', value: Boolean(value) });
  await transactionDone(tx);
}

export async function getAssetRecord(hash: string): Promise<AssetRecord | undefined> {
  return getOne<AssetRecord>('assets', hash);
}
export async function hasCompleteAsset(hash: string, expectedSize: number, mimeType: string) {
  const record = await getAssetRecord(hash);
  if (!record?.complete || record.size !== expectedSize || record.mimeType !== mimeType) {
    if (record) await deleteHash(hash);
    return false;
  }
  const parts = await getStoredParts(hash);
  const intact = parts.length === record.chunkCount
    && parts.every((part, index) => part.index === index && part.size === part.blob.size)
    && parts.reduce((sum, part) => sum + part.size, 0) === expectedSize;
  if (intact) return true;
  await deleteHash(hash);
  return false;
}
export async function getPartialInfo(hash: string): Promise<PartialRecord | undefined> {
  return getOne<PartialRecord>('partials', hash);
}
export async function getStoredParts(hash: string): Promise<PartRecord[]> {
  const db = await openDatabase();
  const tx = db.transaction('parts', 'readonly');
  const request = tx.objectStore('parts').index(CHUNK_INDEX).getAll(IDBKeyRange.only(hash));
  const result = await requestResult(request) as PartRecord[];
  await transactionDone(tx);
  return result.sort((a, b) => a.index - b.index);
}
export async function savePartialMetadata(record: PartialRecord) {
  const db = await openDatabase();
  const tx = db.transaction('partials', 'readwrite');
  tx.objectStore('partials').put(record);
  await transactionDone(tx);
}
export async function saveChunk(hash: string, index: number, blob: Blob, expectedSize: number, mimeType: string, chunkSize: number) {
  const db = await openDatabase();
  const tx = db.transaction(['parts', 'partials'], 'readwrite');
  tx.objectStore('parts').put({ key: `${hash}:${index}`, hash, index, blob, size: blob.size } satisfies PartRecord);
  tx.objectStore('partials').put({ hash, expectedSize, mimeType, chunkSize, updatedAt: new Date().toISOString() } satisfies PartialRecord);
  await transactionDone(tx);
}
export async function finalizeAsset(hash: string, expectedSize: number, mimeType: string, expectedChunkCount: number) {
  const parts = await getStoredParts(hash);
  if (parts.length !== expectedChunkCount) throw new Error('عدد الأجزاء المحلية غير مكتمل.');
  const size = parts.reduce((total, part, index) => {
    if (part.index !== index) throw new Error('تسلسل أجزاء الملف المحلي غير مكتمل.');
    return total + part.size;
  }, 0);
  if (size !== expectedSize) throw new Error('حجم الملف المحلي لا يطابق البيان.');
  const db = await openDatabase();
  const tx = db.transaction(['assets', 'partials'], 'readwrite');
  tx.objectStore('assets').put({ hash, size, mimeType, chunkCount: expectedChunkCount, verifiedAt: new Date().toISOString(), complete: true } satisfies AssetRecord);
  tx.objectStore('partials').delete(hash);
  await transactionDone(tx);
}

export async function getAssetBlob(hash: string): Promise<Blob | null> {
  const asset = await getAssetRecord(hash);
  if (!asset?.complete) return null;
  const parts = await getStoredParts(hash);
  if (parts.length !== asset.chunkCount || parts.some((part, index) => part.index !== index)) return null;
  const blob = new Blob(parts.map(part => part.blob), { type: asset.mimeType });
  if (blob.size !== asset.size) return null;
  return blob;
}

async function deleteHash(hash: string) {
  const db = await openDatabase();
  const tx = db.transaction(['assets', 'parts', 'partials'], 'readwrite');
  tx.objectStore('assets').delete(hash);
  tx.objectStore('partials').delete(hash);
  const cursorRequest = tx.objectStore('parts').index(CHUNK_INDEX).openCursor(IDBKeyRange.only(hash));
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (cursor) { cursor.delete(); cursor.continue(); }
  };
  await transactionDone(tx);
}
export async function deleteUnreferencedAssets(protectedHashes: string[]) {
  const protect = new Set(protectedHashes);
  const assets = await getAll<AssetRecord>('assets');
  const partials = await getAll<PartialRecord>('partials');
  for (const asset of assets) if (!protect.has(asset.hash)) await deleteHash(asset.hash);
  for (const partial of partials) if (!protect.has(partial.hash)) await deleteHash(partial.hash);
}
export async function getStorageStats(): Promise<{ usage: number | null; quota: number | null; persisted: boolean | null }> {
  let usage: number | null = null;
  let quota: number | null = null;
  let persisted: boolean | null = null;
  try {
    if (navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate();
      usage = estimate.usage ?? null;
      quota = estimate.quota ?? null;
    }
    if (navigator.storage?.persisted) persisted = await navigator.storage.persisted();
  } catch { /* Browser reports storage estimates as best-effort data. */ }
  return { usage, quota, persisted };
}
export async function requestPersistentStorage(): Promise<boolean | null> {
  try {
    if (!navigator.storage?.persist) return null;
    return await navigator.storage.persist();
  } catch { return false; }
}
export async function countCachedAssets() {
  return (await getAll<AssetRecord>('assets')).filter(record => record.complete).length;
}
export async function clearStalePartial(hash: string) {
  await deleteHash(hash);
}
