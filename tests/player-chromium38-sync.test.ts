/*
 * Regression tests for the LG UJ634V (webOS 3.5, Chromium 38) synchronization path.
 *
 * Chromium 38 mock:
 *  - IDBObjectStore.prototype.getAll and IDBIndex.prototype.getAll are deleted (added in Chrome 48).
 *  - fetch, AbortController, ReadableStream, Response, ResizeObserver and navigator.storage are removed.
 *  - All network traffic goes through the legacy transport seam, which carries the real XHR shape.
 *
 * Covered: the cursor-based IndexedDB reads, chunk readback, operation-level error diagnostics,
 * bounded network retries, Content-Range validation, stage tagging, and retention of the last
 * valid content when a later synchronization fails.
 */
import { IDBFactory, IDBIndex, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import {
  binaryResponse,
  blobBytes,
  buildFixture,
  createPage,
  createTransport,
  stripModernApis,
  type FakePage,
  type Transport,
  settle
} from './player-harness';

// Chromium 38 has no getAll on stores or indexes. Remove it for every test in this file.
delete (IDBObjectStore.prototype as any).getAll;
delete (IDBIndex.prototype as any).getAll;

const TOKEN = 'T'.repeat(60);
const pages: FakePage[] = [];

afterEach(() => {
  while (pages.length) {
    const page = pages.pop();
    try { page?.win.close(); } catch { /* ignore */ }
  }
});

function chromium38Page(options: { transport?: Transport | null; indexedDb?: any } = {}): FakePage {
  const page = createPage({ autoBoot: false, indexedDb: options.indexedDb || new IDBFactory(), transport: options.transport || null });
  stripModernApis(page.win);
  pages.push(page);
  return page;
}

async function openStorage(page: FakePage) {
  return page.runtime.createStorage(page.win, { Promise: page.win.Promise, log: () => undefined });
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function makeSync(page: FakePage, storage: any, transport: Transport, extra: Record<string, unknown> = {}) {
  const log: Array<{ event: string; data: any }> = [];
  const http = page.runtime.createHttp(page.win, {
    transport,
    Promise: page.win.Promise,
    log: (event: string, data: any) => log.push({ event, data })
  });
  const sync = page.runtime.createSync({
    win: page.win,
    storage,
    http,
    token: TOKEN,
    Promise: page.win.Promise,
    log: (event: string, data: any) => log.push({ event, data }),
    deferActivation: true,
    preflightAsset: () => page.win.Promise.resolve(true),
    ...extra
  });
  return { sync, log };
}

/** Runs a sync to completion, driving the virtual clock so retry backoff elapses. */
async function runSync(page: FakePage, sync: any): Promise<{ ok: boolean; result?: any; error?: any }> {
  let done = false;
  let ok = false;
  let result: any;
  let error: any;
  Promise.resolve(sync.run()).then(
    (value: any) => { done = true; ok = true; result = value; },
    (err: any) => { done = true; error = err; }
  );
  for (let round = 0; round < 2000 && !done; round += 1) {
    await settle(page.win, page.clock, 1);
    page.clock.advance(250);
  }
  if (!done) throw new Error('sync did not settle before the virtual clock ran out');
  return { ok, result, error };
}

describe('Chromium 38 IndexedDB (no getAll)', () => {
  it('1. counts stored assets with a cursor walk when getAll is absent', async () => {
    const page = chromium38Page();
    const storage: any = await openStorage(page);
    expect(typeof (page.win.indexedDB as any)).toBe('object');
    const bytes = bytesOf('image-bytes-one');
    await storage.saveChunk('a'.repeat(64), 0, bytes, { expectedSize: bytes.length, mimeType: 'image/png', chunkSize: 4 });
    await storage.finalizeAsset('a'.repeat(64), bytes.length, 'image/png', 1, 4);
    const count = await storage.countCachedAssets();
    expect(count).toBe(1);
  });

  it('2. returns chunks in index order even when they were written out of order', async () => {
    const page = chromium38Page();
    const storage: any = await openStorage(page);
    const hash = 'b'.repeat(64);
    await storage.saveChunk(hash, 1, bytesOf('CCCC'), { expectedSize: 8, mimeType: 'video/mp4', chunkSize: 4 });
    await storage.saveChunk(hash, 0, bytesOf('AAAA'), { expectedSize: 8, mimeType: 'video/mp4', chunkSize: 4 });
    const parts = await storage.getAssetParts(hash);
    expect(parts.map((part: any) => part.index)).toEqual([0, 1]);
    expect(parts.map((part: any) => part.size)).toEqual([4, 4]);
  });

  it('3. a chunk that does not read back is reported as idb_readback_failed with its store', async () => {
    const page = chromium38Page();
    const storage: any = await openStorage(page);
    const originalGet = storage._get.bind(storage);
    storage._get = (store: string, key: string) => (store === 'parts' ? page.win.Promise.resolve(null) : originalGet(store, key));
    let error: any = null;
    try {
      await storage.saveChunk('c'.repeat(64), 0, bytesOf('data'), { expectedSize: 4, mimeType: 'image/png', chunkSize: 4 });
    } catch (caught) { error = caught; }
    expect(error).not.toBeNull();
    expect(error.code).toBe('idb_readback_failed');
    expect(error.idbStore).toBe('parts');
    expect(error.idbOp).toBe('readback');
  });

  it('4. a transaction abort names the operation, the store and the native cause', async () => {
    const page = chromium38Page();
    const storage: any = await openStorage(page);
    const realTransaction = storage.db.transaction.bind(storage.db);
    storage.db.transaction = (names: any, mode: any) => {
      const real = realTransaction(names, mode);
      const fake: any = {
        error: { name: 'UnknownError', message: 'disk write failed' },
        objectStore: (name: string) => real.objectStore(name),
        oncomplete: null,
        onabort: null,
        onerror: null
      };
      Promise.resolve().then(() => { if (fake.onabort) fake.onabort(); });
      return fake;
    };
    let error: any = null;
    try { await storage.saveChunk('d'.repeat(64), 0, bytesOf('data'), { expectedSize: 4, mimeType: 'image/png', chunkSize: 4 }); }
    catch (caught) { error = caught; }
    storage.db.transaction = realTransaction;
    expect(error.code).toBe('idb_commit_aborted_failed');
    expect(error.idbStore).toBe('parts');
    expect(error.idbCause).toBe('UnknownError');
  });

  it('5. a quota failure keeps the storage_quota code so the GC-and-retry path still runs', async () => {
    const page = chromium38Page();
    const storage: any = await openStorage(page);
    const realTransaction = storage.db.transaction.bind(storage.db);
    storage.db.transaction = (names: any, mode: any) => {
      const real = realTransaction(names, mode);
      const fake: any = { error: { name: 'QuotaExceededError', message: 'full' }, objectStore: (n: string) => real.objectStore(n), oncomplete: null, onabort: null, onerror: null };
      Promise.resolve().then(() => { if (fake.onabort) fake.onabort(); });
      return fake;
    };
    let error: any = null;
    try { await storage.saveChunk('e'.repeat(64), 0, bytesOf('data'), { expectedSize: 4, mimeType: 'image/png', chunkSize: 4 }); }
    catch (caught) { error = caught; }
    storage.db.transaction = realTransaction;
    expect(error.code).toBe('storage_quota');
  });

  it('6. clearAsset and deleteUnreferenced remove rows without getAll', async () => {
    const page = chromium38Page();
    const storage: any = await openStorage(page);
    const hashA = 'f'.repeat(64);
    const hashB = '0'.repeat(64);
    await storage.saveChunk(hashA, 0, bytesOf('aaaa'), { expectedSize: 4, mimeType: 'image/png', chunkSize: 4 });
    await storage.finalizeAsset(hashA, 4, 'image/png', 1, 4);
    await storage.saveChunk(hashB, 0, bytesOf('bbbb'), { expectedSize: 4, mimeType: 'image/png', chunkSize: 4 });
    await storage.finalizeAsset(hashB, 4, 'image/png', 1, 4);
    expect(await storage.countCachedAssets()).toBe(2);
    await storage.clearAsset(hashA);
    expect(await storage.countCachedAssets()).toBe(1);
    await storage.deleteUnreferenced([hashB]);
    expect(await storage.countCachedAssets()).toBe(1);
  });
});

describe('legacy network layer', () => {
  it('7. a transient manifest network failure is retried and the sync still completes', async () => {
    const fixture = buildFixture({});
    const plan = createTransport(fixture, { failTimes: 1 });
    const page = chromium38Page();
    const storage: any = await openStorage(page);
    const { sync } = makeSync(page, storage, plan.transport);
    const outcome = await runSync(page, sync);
    expect(outcome.ok).toBe(true);
    expect(plan.count('/api/player/manifest')).toBe(2);
  });

  it('8. a persistent manifest 5xx is retried exactly once and then reported', async () => {
    const fixture = buildFixture({});
    const plan = createTransport(fixture, { manifestStatus: 503 });
    const page = chromium38Page();
    const storage: any = await openStorage(page);
    const { sync } = makeSync(page, storage, plan.transport);
    const outcome = await runSync(page, sync);
    expect(outcome.ok).toBe(false);
    expect(plan.count('/api/player/manifest')).toBe(2);
  });

  it('9. a 401 manifest is never retried (a refused credential is not transient)', async () => {
    const fixture = buildFixture({});
    const plan = createTransport(fixture, { manifestStatus: 401 });
    const page = chromium38Page();
    const storage: any = await openStorage(page);
    const { sync } = makeSync(page, storage, plan.transport);
    const outcome = await runSync(page, sync);
    expect(outcome.ok).toBe(false);
    expect(plan.count('/api/player/manifest')).toBe(1);
  });

  it('10. a 206 whose Content-Range names a different window is rejected, retried, and never stored at the wrong offset', async () => {
    const fixture = buildFixture({});
    const plan = createTransport(fixture, {});
    let mislabelled = 0;
    const transport: Transport = (spec) => {
      const isMedia = /^https:\/\/objects\.example\.test\//.test(spec.url) || /^\/api\/player\/media\//.test(spec.url);
      const range = (spec.headers || {}).Range || (spec.headers || {}).range;
      if (isMedia && range && mislabelled === 0) {
        mislabelled += 1;
        // A window that does not match the request: wrong start, claimed as 206.
        // Correct length, wrong label: only the Content-Range check can reject this.
        const wrongBody = new Uint8Array(fixture.imageBytes.length).fill(88);
        return Promise.resolve(binaryResponse(206, wrongBody, { 'Content-Range': 'bytes 9999-10003/99999' }));
      }
      return plan.transport(spec);
    };
    const page = chromium38Page();
    const storage: any = await openStorage(page);
    const { sync } = makeSync(page, storage, transport);
    const outcome = await runSync(page, sync);
    expect(mislabelled).toBe(1);
    expect(outcome.ok).toBe(true);
    const blob = await storage.getAssetBlob(fixture.imageHash);
    expect(blob).toBeTruthy();
    const stored = await blobBytes(page.win, blob);
        expect(Array.from(stored)).toEqual(Array.from(fixture.imageBytes));
  });

  it('11. a 206 whose body is shorter than the requested window is retried, not stored', async () => {
    const fixture = buildFixture({});
    const plan = createTransport(fixture, {});
    let truncated = 0;
    const transport: Transport = (spec) => {
      const isMedia = /^https:\/\/objects\.example\.test\//.test(spec.url) || /^\/api\/player\/media\//.test(spec.url);
      const range = (spec.headers || {}).Range || (spec.headers || {}).range;
      if (isMedia && range && truncated === 0) {
        truncated += 1;
        const m = /bytes=(\d+)-(\d+)/.exec(range);
        const start = Number(m![1]);
        return Promise.resolve(binaryResponse(206, bytesOf('x'), { 'Content-Range': `bytes ${start}-${start}/${fixture.videoBytes.length}` }));
      }
      return plan.transport(spec);
    };
    const page = chromium38Page();
    const storage: any = await openStorage(page);
    const { sync } = makeSync(page, storage, transport);
    const outcome = await runSync(page, sync);
    expect(truncated).toBe(1);
    expect(outcome.ok).toBe(true);
  });

  it('12. media-urls 5xx is retried a bounded number of times, never unbounded', async () => {
    const fixture = buildFixture({});
    const plan = createTransport(fixture, { signedUrlStatus: 503 });
    const page = chromium38Page();
    const storage: any = await openStorage(page);
    const { sync } = makeSync(page, storage, plan.transport);
    await runSync(page, sync);
    // Each logical media-url request is capped at two attempts, so retries never multiply unboundedly.
    expect(plan.count('/api/player/media-urls')).toBeGreaterThanOrEqual(2);
    expect(plan.count('/api/player/media-urls')).toBeLessThanOrEqual(6);
  });

  it('13. a failed later sync tags its stage, reports it, and keeps the previously stored media', async () => {
    const fixture = buildFixture({});
    const good = createTransport(fixture, {});
    const page = chromium38Page();
    const storage: any = await openStorage(page);
    const first = makeSync(page, storage, good.transport);
    const firstOutcome = await runSync(page, first.sync);
    expect(firstOutcome.ok).toBe(true);
    expect(await storage.countCachedAssets()).toBe(2);

    const bad = createTransport(fixture, { manifestInvalid: true });
    const second = makeSync(page, storage, bad.transport);
    const secondOutcome = await runSync(page, second.sync);
    expect(secondOutcome.ok).toBe(false);
    expect(secondOutcome.error.stage).toBe('manifest');
    // The last valid media is still stored and readable; nothing was cleared by the failure.
    expect(await storage.countCachedAssets()).toBe(2);
  });
});
