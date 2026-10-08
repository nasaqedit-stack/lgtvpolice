/*
 * Behaviour of the ES5 runtime under webOS-3.5-like conditions.
 *
 * Every test loads the shipped files (public/player/*.js) into a jsdom window, removes the APIs a
 * 2016 LG TV browser does not have, and drives the runtime with a transport that behaves like the
 * real /api/player routes — including their failure modes (rejected signed URLs, ignored Range
 * headers, corrupted downloads, exhausted quota, dead network).
 */
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildFixture,
  blobBytes,
  createPage,
  createTransport,
  installFakeCaches,
  jsonResponse,
  networkError,
  readPlayerScript,
  settle,
  sha256Hex,
  stripModernApis,
  undefine,
  waitFor,
  type FakePage,
  type Transport
} from './player-harness';

const openPages: FakePage[] = [];
afterEach(() => {
  while (openPages.length) {
    const page = openPages.pop();
    try { page?.dom.window.close(); } catch { /* jsdom teardown is best effort */ }
  }
});

function page(options: Parameters<typeof createPage>[0] = {}): FakePage {
  const created = createPage(options);
  openPages.push(created);
  return created;
}

function hdPage(options: Parameters<typeof createPage>[0] = {}): FakePage {
  return page({ ...options, indexedDb: new IDBFactory() });
}

async function openStorage(target: FakePage): Promise<any> {
  return target.runtime.createStorage(target.win, { Promise: target.win.Promise, log: () => undefined });
}

async function openSync(target: FakePage, storage: any, transport: Transport, options: { token?: string; chunkSize?: number } = {}): Promise<any> {
  const http = target.runtime.createHttp(target.win, { Promise: target.win.Promise, transport, log: () => undefined });
  const sync = target.runtime.createSync({
    win: target.win,
    storage,
    http,
    token: options.token === undefined ? 'credential-1' : options.token,
    chunkSize: options.chunkSize,
    Promise: target.win.Promise,
    log: () => undefined
  });
  return { sync, http };
}

function startEngine(target: FakePage, deps: { storage: any; sync: any; http: any; token?: string; options?: any }) {
  const stage = target.win.document.createElement('div');
  stage.className = 'sp-stage';
  target.win.document.body.appendChild(stage);
  return target.runtime.createEngine({
    win: target.win,
    doc: target.win.document,
    stage,
    storage: deps.storage,
    sync: deps.sync,
    http: deps.http,
    token: deps.token || 'credential-1',
    Promise: target.win.Promise,
    log: () => undefined,
    ...(deps.options || {})
  });
}

/**
 * Runs a sync (or any runtime operation that yields with window.setTimeout) while the virtual clock
 * keeps moving: the runtime deliberately yields between hash chunks so the TV never freezes.
 */
async function runToCompletion<T>(target: FakePage, operation: Promise<T>, rounds = 3000): Promise<T> {
  let settled = false;
  let value: T | undefined;
  let failure: any = null;
  operation.then((result) => { settled = true; value = result; }, (error) => { settled = true; failure = error; });
  for (let round = 0; round < rounds && !settled; round += 1) {
    await settle(target.win, target.clock, 1);
  }
  if (!settled) throw new Error('operation did not finish while the clock advanced');
  if (failure) throw failure;
  return value as T;
}

async function waitForElement(target: FakePage, selector: string): Promise<any> {
  await waitFor(target.win, target.clock, () => Boolean(target.win.document.querySelector(selector)));
  return target.win.document.querySelector(selector);
}

async function saveAsset(storage: any, hash: string, bytes: Uint8Array, mimeType: string, chunkSize = bytes.length): Promise<void> {
  const chunkCount = Math.max(1, Math.ceil(bytes.length / chunkSize));
  for (let index = 0; index < chunkCount; index += 1) {
    await storage.saveChunk(hash, index, bytes.slice(index * chunkSize, (index + 1) * chunkSize), {
      expectedSize: bytes.length, mimeType, chunkSize
    });
  }
  await storage.finalizeAsset(hash, bytes.length, mimeType, chunkCount, chunkSize);
}

describe('capability detection', () => {
  it('recognises webOS 3.5 / Chromium 38 and the APIs it lacks', () => {
    const target = page();
    stripModernApis(target.win);
    undefine(target.win, 'indexedDB');
    const caps = target.runtime.detectCapabilities(target.win);
    expect(caps.webos.detected).toBe(true);
    expect(caps.webos.version).toBe('3.5');
    expect(caps.chromium).toBe(38);
    expect(caps.features.xmlHttpRequest).toBe(true);
    expect(caps.features.fetch).toBe(false);
    expect(caps.features.abortController).toBe(false);
    expect(caps.features.readableStream).toBe(false);
    expect(caps.features.mediaSource).toBe(false);
    expect(caps.features.indexedDb).toBe(false);
    expect(caps.sha256).toBe('internal');
  });

  it('describes the running browser for the diagnostics screen', () => {
    const target = page();
    const report: any = target.runtime.collectDiagnostics(target.win, { storageBackend: 'memory', cachedCount: 0 });
    const features = report.features.map((entry: any) => entry.feature);
    for (const expected of ['xmlHttpRequest', 'fetch', 'blobUrl', 'indexedDb', 'cacheApi', 'fileReader', 'nativePromise']) {
      expect(features).toContain(expected);
    }
    expect(report.lines.join(' ')).toContain('Chromium: 38');
    expect(report.lines.join(' ')).toContain('webOS: 3.5');
  });
});

describe('storage adapters', () => {
  it('falls back to the in-memory store when neither IndexedDB nor Cache API exists', async () => {
    const target = page();
    undefine(target.win, 'indexedDB');
    const storage = await openStorage(target);

    expect(storage.backend).toBe('memory');
    expect(storage.notes.join(' ')).toContain('الذاكرة');

    await storage.setCredential('cred-1');
    expect(await storage.getCredential()).toBe('cred-1');

    const bytes = new TextEncoder().encode('offline-image');
    const hash = sha256Hex(bytes);
    await saveAsset(storage, hash, bytes, 'image/png');
    expect(await storage.countCachedAssets()).toBe(1);
    expect(await storage.hasCompleteAsset(hash, bytes.length, 'image/png')).toBe(true);
    expect(await blobBytes(target.win, await storage.getAssetBlob(hash))).toEqual(bytes);
  });

  it('uses the Cache API when IndexedDB is unavailable', async () => {
    const target = page();
    installFakeCaches(target.win);
    undefine(target.win, 'indexedDB');
    const storage = await openStorage(target);
    expect(storage.backend).toBe('cache-api');

    const bytes = new TextEncoder().encode('cached-bytes');
    const hash = sha256Hex(bytes);
    await saveAsset(storage, hash, bytes, 'image/png');
    expect(await storage.hasCompleteAsset(hash, bytes.length, 'image/png')).toBe(true);
    expect(await blobBytes(target.win, await storage.getAssetBlob(hash))).toEqual(bytes);

    await storage.deleteUnreferenced([]);
    expect(await storage.hasCompleteAsset(hash, bytes.length, 'image/png')).toBe(false);
  });

  it('uses IndexedDB when it is available and only activates complete manifests', async () => {
    const target = hdPage();
    const storage = await openStorage(target);
    expect(storage.backend).toBe('indexeddb');

    const bytes = new TextEncoder().encode('idb-bytes');
    const hash = sha256Hex(bytes);
    const manifest = {
      schemaVersion: 1, manifestHash: 'b'.repeat(64), generatedAt: 'now',
      assets: [{ mediaId: 'media-1', hash, size: bytes.length, mimeType: 'image/png' }]
    };

    await storage.saveChunk(hash, 0, bytes, { expectedSize: bytes.length, mimeType: 'image/png', chunkSize: bytes.length });
    await expect(storage.activateManifest(manifest)).rejects.toMatchObject({ code: 'partial_sync' });
    expect(await storage.getActiveManifest()).toBeNull();

    await storage.finalizeAsset(hash, bytes.length, 'image/png', 1, bytes.length);
    await storage.activateManifest(manifest);
    expect((await storage.getActiveManifest()).manifestHash).toBe('b'.repeat(64));
    expect(await storage.countCachedAssets()).toBe(1);
    expect(await blobBytes(target.win, await storage.getAssetBlob(hash))).toEqual(bytes);
  });

  it('reads part records in the shape the previous React player wrote (blob field)', async () => {
    const target = hdPage();
    const storage = await openStorage(target);
    const bytes = new TextEncoder().encode('legacy-player-chunk');
    const hash = sha256Hex(bytes);
    await saveAsset(storage, hash, bytes, 'image/png');

    // lib/player/storage.ts stored { key, hash, index, size, blob } records; present the same shape.
    const originalPartsOf = storage._partsOf.bind(storage);
    storage._partsOf = (value: string) => originalPartsOf(value).then((parts: any[]) => parts.map((part) => ({
      key: part.key, hash: part.hash, index: part.index, size: part.size,
      blob: new target.win.Blob([new Uint8Array(part.buffer)], { type: 'image/png' })
    })));

    expect(await storage.hasCompleteAsset(hash, bytes.length, 'image/png')).toBe(true);
    expect(await blobBytes(target.win, await storage.getAssetBlob(hash))).toEqual(bytes);
  });

  it('reads Blob bytes without Blob.prototype.arrayBuffer (FileReader path)', async () => {
    const target = page();
    const runtime = target.runtime;
    const bytes = new TextEncoder().encode('filereader-path');
    const blob = new target.win.Blob([bytes], { type: 'image/png' });
    // Chromium 38 has no Blob.arrayBuffer: the runtime must fall back to FileReader.
    const read = await runtime.readBlobBytes(target.win, blob);
    expect(new Uint8Array(read)).toEqual(bytes);
    expect(readPlayerScript('runtime.js')).toContain('readAsArrayBuffer');
  });

  it('treats a damaged asset as missing and clears it instead of failing', async () => {
    const target = hdPage();
    const storage = await openStorage(target);
    const bytes = new TextEncoder().encode('damaged-asset');
    const hash = sha256Hex(bytes);
    await saveAsset(storage, hash, bytes, 'image/png');

    // A part that disappeared (eviction, aborted write) must never be reported as complete.
    const db: any = await new target.win.Promise((resolve: any, reject: any) => {
      const open = target.win.indexedDB.open('digital-signage-player', 1);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    await new target.win.Promise((resolve: any, reject: any) => {
      const tx = db.transaction(['parts'], 'readwrite');
      tx.objectStore('parts').delete(hash + ':0');
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });

    expect(await storage.hasCompleteAsset(hash, bytes.length, 'image/png')).toBe(false);
    expect(await storage.countCachedAssets()).toBe(0);
  });

  it('never rejects creation, even with every optional API removed', async () => {
    const target = page();
    stripModernApis(target.win);
    undefine(target.win, 'indexedDB');
    const storage = await openStorage(target);
    expect(storage.backend).toBe('memory');
    expect(storage.notes.length).toBeGreaterThan(0);
    const stats = await storage.getStats();
    expect(stats.persisted).toBeFalsy();
  });
});

describe('sync against the player API', () => {
  it('downloads, verifies and activates a manifest with ranged requests', async () => {
    const fixture = buildFixture();
    const plan = createTransport(fixture);
    const target = page();
    const storage = await openStorage(target);
    const phases: string[] = [];
    const { sync } = await openSync(target, storage, plan.transport);
    const instrumented = target.runtime.createSync({
      win: target.win,
      storage,
      http: target.runtime.createHttp(target.win, { Promise: target.win.Promise, transport: plan.transport }),
      token: 'credential-1',
      Promise: target.win.Promise,
      onProgress: (progress: any) => phases.push(progress.phase)
    });
    void sync;

    const result: any = await runToCompletion(target, instrumented.run());
    await settle(target.win, target.clock);

    expect(result.changed).toBe(true);
    expect((await storage.getActiveManifest()).manifestHash).toBe(fixture.manifest.manifestHash);
    expect(await storage.countCachedAssets()).toBe(2);
    expect(await blobBytes(target.win, await storage.getAssetBlob(fixture.imageHash))).toEqual(fixture.imageBytes);
    expect(await blobBytes(target.win, await storage.getAssetBlob(fixture.videoHash))).toEqual(fixture.videoBytes);

    expect(plan.calls.some((call) => call.isRange)).toBe(true);
    expect(phases).toEqual(expect.arrayContaining(['manifest', 'downloading', 'verifying', 'activating', 'ready']));
    expect(await storage.getLastSyncAt()).toBeTruthy();
  });

  it('reuses the local copy on 304 without downloading again', async () => {
    const fixture = buildFixture();
    const plan = createTransport(fixture);
    const target = page();
    const storage = await openStorage(target);
    const { sync } = await openSync(target, storage, plan.transport);
    await runToCompletion(target, sync.run());
    await settle(target.win, target.clock);
    const before = plan.calls.length;

    const second: any = await runToCompletion(target, sync.run());
    await settle(target.win, target.clock);
    expect(second.changed).toBe(false);
    // Only the conditional manifest request goes out: the 304 path re-uses every cached asset.
    expect(plan.calls.length).toBe(before + 1);
    expect(plan.calls[before].url).toBe('/api/player/manifest');
    expect(plan.calls[before].headers['If-None-Match']).toBe(`"${fixture.manifest.manifestHash}"`);
    expect(plan.count('/api/player/media-urls')).toBe(1);
  });

  it('reports a failing manifest as manifest_unavailable and keeps the previous content', async () => {
    const fixture = buildFixture();
    const good = createTransport(fixture);
    const target = page();
    const storage = await openStorage(target);
    const { sync } = await openSync(target, storage, good.transport);
    await runToCompletion(target, sync.run());
    await settle(target.win, target.clock);

    const broken = createTransport(fixture, { manifestStatus: 500 });
    const failing = await openSync(target, storage, broken.transport);
    await expect(failing.sync.run()).rejects.toMatchObject({ code: 'manifest_unavailable' });
    expect((await storage.getActiveManifest()).manifestHash).toBe(fixture.manifest.manifestHash);
    expect(await storage.countCachedAssets()).toBe(2);
  });

  it('distinguishes a revoked credential (401) from a disabled screen (403)', async () => {
    const fixture = buildFixture();
    const target = page();
    const storage = await openStorage(target);

    const revoked = await openSync(target, storage, createTransport(fixture, { manifestStatus: 401 }).transport);
    await expect(revoked.sync.run()).rejects.toMatchObject({ code: 'screen_unauthorized' });

    const disabled = await openSync(target, storage, createTransport(fixture, { manifestStatus: 403 }).transport);
    await expect(disabled.sync.run()).rejects.toMatchObject({ code: 'screen_disabled' });
  });

  it('reports network_offline when the network is unreachable', async () => {
    const fixture = buildFixture();
    const { transport } = createTransport(fixture, { failTimes: 99 });
    const target = page();
    const storage = await openStorage(target);
    const { sync } = await openSync(target, storage, transport);
    await expect(sync.run()).rejects.toMatchObject({ code: 'network_offline' });
  });

  it('rejects an invalid manifest and reports an empty account distinctly', async () => {
    const fixture = buildFixture();
    const target = page();
    const storage = await openStorage(target);

    const invalid = await openSync(target, storage, createTransport(fixture, { manifestInvalid: true }).transport);
    await expect(invalid.sync.run()).rejects.toMatchObject({ code: 'invalid_manifest' });

    const emptyManifest = { ...fixture.manifest, playlists: [], defaultPlaylistId: null, schedules: [] };
    const noContent = await openSync(target, storage, () => Promise.resolve(jsonResponse(200, emptyManifest)));
    await expect(noContent.sync.run()).rejects.toMatchObject({ code: 'no_published_content' });
  });

  it('falls back to the same-origin media stream when the signed URL is rejected', async () => {
    const fixture = buildFixture();
    const plan = createTransport(fixture, { signedUrlStatus: 403 });
    const target = page();
    const storage = await openStorage(target);
    const { sync } = await openSync(target, storage, plan.transport);

    const result: any = await runToCompletion(target, sync.run());
    await settle(target.win, target.clock);
    expect(result.changed).toBe(true);
    expect(await storage.countCachedAssets()).toBe(2);
    const sameOrigin = plan.calls.filter((call) => /^\/api\/player\/media\//.test(call.url));
    expect(sameOrigin.length).toBeGreaterThan(0);
    expect(sameOrigin.every((call) => call.headers.Authorization === 'Bearer credential-1')).toBe(true);
  });

  it('falls back to the same-origin stream when the object host is unreachable', async () => {
    const fixture = buildFixture();
    const plan = createTransport(fixture, { signedUrlNetworkError: true });
    const target = page();
    const storage = await openStorage(target);
    const { sync } = await openSync(target, storage, plan.transport);
    await runToCompletion(target, sync.run());
    await settle(target.win, target.clock);
    expect(plan.calls.some((call) => /^\/api\/player\/media\//.test(call.url))).toBe(true);
    expect(await storage.countCachedAssets()).toBe(2);
  });

  it('completes when the server ignores Range and answers 200', async () => {
    const fixture = buildFixture();
    const { transport } = createTransport(fixture, { ignoreRange: true });
    const target = page();
    const storage = await openStorage(target);
    const { sync } = await openSync(target, storage, transport);
    await runToCompletion(target, sync.run());
    await settle(target.win, target.clock);
    expect(await storage.countCachedAssets()).toBe(2);
    expect(await blobBytes(target.win, await storage.getAssetBlob(fixture.videoHash))).toEqual(fixture.videoBytes);
  });

  it('retries transient download failures and then succeeds', async () => {
    const fixture = buildFixture();
    const { transport } = createTransport(fixture, { failMediaTimes: 2 });
    const target = page();
    const storage = await openStorage(target);
    const { sync } = await openSync(target, storage, transport);
    await runToCompletion(target, sync.run());
    await settle(target.win, target.clock);
    expect(await storage.countCachedAssets()).toBe(2);
  });

  it('refuses corrupted bytes and keeps the previous playlist active', async () => {
    const fixture = buildFixture();
    const mismatched = buildFixture({ hashOverride: { image: 'f'.repeat(64) } });
    mismatched.manifest.manifestHash = 'b'.repeat(64);
    const target = page();
    const storage = await openStorage(target);

    const good = await openSync(target, storage, createTransport(fixture).transport);
    await runToCompletion(target, good.sync.run());
    await settle(target.win, target.clock);
    expect(await storage.countCachedAssets()).toBe(2);

    const broken = await openSync(target, storage, createTransport(mismatched).transport);
    await expect(runToCompletion(target, broken.sync.run())).rejects.toMatchObject({ code: 'hash_mismatch' });
    await settle(target.win, target.clock);

    expect((await storage.getActiveManifest()).manifestHash).toBe(fixture.manifest.manifestHash);
    expect(await storage.hasCompleteAsset('f'.repeat(64), mismatched.imageBytes.length, 'image/png')).toBe(false);
    expect(await blobBytes(target.win, await storage.getAssetBlob(fixture.imageHash))).toEqual(fixture.imageBytes);
  });

  it('stops before downloading when the storage quota cannot hold the manifest', async () => {
    const fixture = buildFixture();
    const plan = createTransport(fixture);
    const target = hdPage();
    Object.defineProperty(target.win.navigator, 'storage', {
      configurable: true,
      value: { estimate: async () => ({ usage: 900, quota: 1000 }), persisted: async () => true, persist: async () => true }
    });
    const storage = await openStorage(target);
    expect(storage.backend).toBe('indexeddb');
    const { sync } = await openSync(target, storage, plan.transport);
    await expect(runToCompletion(target, sync.run())).rejects.toMatchObject({ code: 'storage_quota' });
    expect(plan.calls.some((call) => call.url === '/api/player/media-urls')).toBe(false);
  });

  it('fails with download_rejected when both the signed and same-origin paths refuse', async () => {
    const fixture = buildFixture();
    const { transport } = createTransport(fixture, { signedUrlStatus: 403, sameOriginStatus: 403 });
    const target = page();
    const storage = await openStorage(target);
    const { sync } = await openSync(target, storage, transport);
    await expect(runToCompletion(target, sync.run())).rejects.toMatchObject({ code: 'download_rejected' });
    expect(await storage.getActiveManifest()).toBeNull();
  });

  it('resumes a partial download instead of starting over', async () => {
    const fixture = buildFixture();
    const target = page();
    const storage = await openStorage(target);
    const chunkSize = 4;
    await storage.saveChunk(fixture.imageHash, 0, fixture.imageBytes.slice(0, chunkSize), {
      expectedSize: fixture.imageBytes.length, mimeType: 'image/png', chunkSize
    });

    const plan = createTransport(fixture);
    const { sync } = await openSync(target, storage, plan.transport, { chunkSize });
    await runToCompletion(target, sync.run());
    await settle(target.win, target.clock);

    const ranges = plan.calls.filter((call) => call.isRange).map((call) => call.headers.Range);
    expect(ranges).toContain(`bytes=${chunkSize}-${chunkSize * 2 - 1}`);
    expect(await blobBytes(target.win, await storage.getAssetBlob(fixture.imageHash))).toEqual(fixture.imageBytes);
  });
});

describe('pairing and heartbeat', () => {
  it('stores the credential returned by the pairing endpoint', async () => {
    const fixture = buildFixture();
    const plan = createTransport(fixture);
    const target = page();
    const storage = await openStorage(target);
    const http = target.runtime.createHttp(target.win, { Promise: target.win.Promise, transport: plan.transport });

    const result: any = await target.runtime.pairScreen(target.win, http, storage, 'abcd-1234');
    expect(result.credential).toBe('credential-1');
    expect(await storage.getCredential()).toBe('credential-1');
    const call = plan.calls.find((entry) => entry.url === '/api/player/pair');
    expect(call).toBeTruthy();
    const body = JSON.parse(call!.body || '{}');
    expect(body.code).toBe('ABCD1234');
    expect(body.deviceInfo.userAgent).toContain('WEBOS3.5');
  });

  it('never contacts the server for a malformed code', async () => {
    const fixture = buildFixture();
    const plan = createTransport(fixture);
    const target = page();
    const storage = await openStorage(target);
    const http = target.runtime.createHttp(target.win, { Promise: target.win.Promise, transport: plan.transport });
    await expect(target.runtime.pairScreen(target.win, http, storage, '12')).rejects.toMatchObject({ code: 'invalid_pairing_code' });
    expect(plan.calls.length).toBe(0);
  });

  it('surfaces the server rejection for a wrong code and network_offline for a dead network', async () => {
    const fixture = buildFixture();
    const target = page();
    const storage = await openStorage(target);

    const rejected = target.runtime.createHttp(target.win, { Promise: target.win.Promise, transport: createTransport(fixture).transport });
    await expect(target.runtime.pairScreen(target.win, rejected, storage, 'ZZZZ9999')).rejects.toMatchObject({ code: 'pairing_failed' });

    const offline = target.runtime.createHttp(target.win, { Promise: target.win.Promise, transport: createTransport(fixture, { failTimes: 9 }).transport });
    await expect(target.runtime.pairScreen(target.win, offline, storage, 'ABCD1234')).rejects.toMatchObject({ code: 'network_offline' });
  });

  it('sends a heartbeat with exactly the fields the API schema accepts', async () => {
    const fixture = buildFixture();
    const { transport } = createTransport(fixture);
    const target = page();
    let payload: any = null;
    const capturing: Transport = (spec) => {
      if (spec.url === '/api/player/heartbeat') payload = JSON.parse(spec.body || '{}');
      return transport(spec);
    };
    const http = target.runtime.createHttp(target.win, { Promise: target.win.Promise, transport: capturing });
    const response: any = await target.runtime.sendHeartbeat(http, 'credential-1', {
      currentPlaylistId: fixture.playlistId,
      currentPlaylistVersion: 1,
      currentItemId: null,
      syncStatus: 'ready',
      syncError: null,
      cachedMediaCount: 2,
      storageUsageBytes: null,
      storageQuotaBytes: null,
      lastSyncAt: null,
      deviceInfo: target.runtime.deviceInfo(target.win)
    });
    expect(response.ok).toBe(true);
    expect(Object.keys(payload).sort()).toEqual([
      'cachedMediaCount', 'currentItemId', 'currentPlaylistId', 'currentPlaylistVersion',
      'deviceInfo', 'lastSyncAt', 'storageQuotaBytes', 'storageUsageBytes', 'syncError', 'syncStatus'
    ].sort());
    expect(Object.keys(payload.deviceInfo).sort()).toEqual(['language', 'platform', 'screenHeight', 'screenWidth', 'userAgent']);
  });
});

describe('scheduling without Intl.formatToParts', () => {
  const rule = (overrides: any = {}) => ({
    id: 'rule', playlistId: 'pppppppp-0000-4000-8000-000000000001', weekdays: [1, 2, 3, 4, 5, 6, 7],
    startTime: '22:00', endTime: '02:00', timezone: 'Asia/Riyadh', enabled: true, ...overrides
  });
  const manifest = (schedule: any) => ({
    schemaVersion: 1, manifestHash: 'a'.repeat(64), screen: { id: 's', name: 's', timezone: 'Asia/Riyadh' },
    defaultPlaylistId: 'dddddddd-0000-4000-8000-000000000001',
    playlists: [], assets: [], schedules: schedule ? [schedule] : []
  });

  it('selects a rule that crosses midnight (22:00-02:00 Riyadh)', () => {
    const target = page();
    const inside = 'pppppppp-0000-4000-8000-000000000001';
    const fallback = 'dddddddd-0000-4000-8000-000000000001';
    // 19:30 UTC == 22:30 Riyadh (inside the window that started today)
    expect(target.runtime.scheduledPlaylistId(target.win, manifest(rule()), new Date('2026-10-08T19:30:00.000Z'))).toBe(inside);
    // 21:30 UTC == 00:30 Riyadh (inside the window that started yesterday)
    expect(target.runtime.scheduledPlaylistId(target.win, manifest(rule()), new Date('2026-10-08T21:30:00.000Z'))).toBe(inside);
    // 23:30 UTC == 02:30 Riyadh (the window has closed)
    expect(target.runtime.scheduledPlaylistId(target.win, manifest(rule()), new Date('2026-10-08T23:30:00.000Z'))).toBe(fallback);
  });

  it('still schedules when the browser has no Intl at all', () => {
    const target = page();
    undefine(target.win, 'Intl');
    const value = target.runtime.scheduledPlaylistId(target.win, manifest(rule()), new Date());
    expect([null, 'pppppppp-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000001']).toContain(value);
  });
});

describe('playback engine', () => {
  async function readyPage(options: Parameters<typeof buildFixture>[0] = {}) {
    const fixture = buildFixture(options);
    const plan = createTransport(fixture);
    const target = page();
    const storage = await openStorage(target);
    const { sync, http } = await openSync(target, storage, plan.transport);
    await runToCompletion(target, sync.run());
    await settle(target.win, target.clock);
    return { fixture, plan, target, storage, http, sync };
  }

  it('plays a cached image, then the MP4, then loops back', async () => {
    const { fixture, target, storage, http, sync } = await readyPage();
    const engine = startEngine(target, { storage, sync, http });
    engine.setManifest(fixture.manifest);
    engine.setPlaylist(fixture.playlistId);
    engine.render();
    await settle(target.win, target.clock);

    const image: any = await waitForElement(target, 'img.sp-media');
    expect(image.getAttribute('src')).toContain('blob:');
    image.onload();
    expect(target.blobUrls.created.length).toBeGreaterThan(0);

    target.clock.advance(5200);
    await settle(target.win, target.clock);
    const video: any = await waitForElement(target, 'video.sp-video');
    expect(video.getAttribute('src')).toContain('blob:');
    expect(video.getAttribute('muted')).toBe('muted');
    expect(video.getAttribute('playsinline')).toBe('playsinline');
    expect(target.media.play.length).toBeGreaterThan(0);

    video.oncanplay();
    video.onended();
    await settle(target.win, target.clock);
    expect((await waitForElement(target, 'img.sp-media')).getAttribute('src')).toContain('blob:');
  });

  it('retries locally-failed media over the network before skipping it', async () => {
    const { fixture, target, storage, http, sync } = await readyPage();
    const notices: string[] = [];
    const engine = startEngine(target, { storage, sync, http, options: { onNotice: (text: string) => notices.push(text) } });
    engine.setManifest(fixture.manifest);
    engine.setPlaylist(fixture.playlistId);
    engine.render();
    await settle(target.win, target.clock);

    const image: any = await waitForElement(target, 'img.sp-media');
    expect(image.getAttribute('src')).toContain('blob:');
    image.onerror();
    await settle(target.win, target.clock);

    const retried: any = await waitForElement(target, 'img.sp-media');
    expect(retried.getAttribute('src')).toContain('https://objects.example.test/');
    expect(notices.join(' ')).toContain('الشبكة');

    retried.onerror();
    target.clock.advance(1500);
    await settle(target.win, target.clock);
    await waitForElement(target, 'video.sp-video');
  });

  it('advances when a video never starts (stall watchdog)', async () => {
    const { fixture, target, storage, http, sync } = await readyPage();
    const notices: string[] = [];
    const engine = startEngine(target, { storage, sync, http, options: { watchdogMs: 20000, onNotice: (text: string) => notices.push(text) } });
    engine.setManifest(fixture.manifest);
    engine.setPlaylist(fixture.playlistId);
    engine.jump(1);
    await settle(target.win, target.clock);
    await waitForElement(target, 'video.sp-video');

    target.clock.advance(21000);
    await settle(target.win, target.clock);
    expect(notices.join(' ')).toContain('تأخر');
    await waitForElement(target, 'img.sp-media');
  });

  it('replays a looping video instead of advancing', async () => {
    const { fixture, target, storage, http, sync } = await readyPage({ videoLoop: true });
    const engine = startEngine(target, { storage, sync, http });
    engine.setManifest(fixture.manifest);
    engine.setPlaylist(fixture.playlistId);
    engine.jump(1);
    await settle(target.win, target.clock);
    const video: any = await waitForElement(target, 'video.sp-video');
    const playsBefore = target.media.play.length;

    video.onended();
    await settle(target.win, target.clock, 10);
    expect(target.win.document.querySelector('video.sp-video')).toBeTruthy();
    expect(target.media.play.length).toBeGreaterThan(playsBefore);
  });

  it('plays from the signed URL when no local copy exists', async () => {
    const fixture = buildFixture();
    const { transport } = createTransport(fixture);
    const target = page();
    const storage = await openStorage(target);
    const { sync, http } = await openSync(target, storage, transport);

    const engine = startEngine(target, { storage, sync, http });
    engine.setManifest(fixture.manifest);
    engine.setPlaylist(fixture.playlistId);
    engine.render();
    const image: any = await waitForElement(target, 'img.sp-media');
    expect(image.getAttribute('src')).toContain('https://objects.example.test/');
  });

  it('plays from the signed URL when Blob URLs are unavailable', async () => {
    const { fixture, target, storage, http, sync } = await readyPage();
    undefine(target.win.URL, 'createObjectURL');
    const engine = startEngine(target, { storage, sync, http });
    engine.setManifest(fixture.manifest);
    engine.setPlaylist(fixture.playlistId);
    engine.render();
    const image: any = await waitForElement(target, 'img.sp-media');
    expect(image.getAttribute('src')).toContain('https://objects.example.test/');
  });

  it('notifies and skips an item that cannot be played at all, instead of freezing on it', async () => {
    const fixture = buildFixture();
    const target = page();
    const storage = await openStorage(target);
    const dead: Transport = () => Promise.reject(networkError());
    const http = target.runtime.createHttp(target.win, { Promise: target.win.Promise, transport: dead });
    const sync = target.runtime.createSync({ win: target.win, storage, http, token: 'credential-1', Promise: target.win.Promise });
    const notices: string[] = [];
    const engine = startEngine(target, { storage, sync, http, options: { onNotice: (text: string) => notices.push(text) } });
    engine.setManifest(fixture.manifest);
    engine.setPlaylist(fixture.playlistId);
    engine.render();
    await settle(target.win, target.clock, 30);
    expect(notices.length).toBeGreaterThan(0);

    target.clock.advance(1500);
    await settle(target.win, target.clock, 30);
    expect(engine.index()).toBe(1);
  });
});
