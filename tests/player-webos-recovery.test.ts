import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildFixture,
  createPage,
  createTransport,
  refreshManifestHash,
  settle,
  type FakePage,
} from './player-harness';

const pages: FakePage[] = [];
afterEach(() => {
  while (pages.length) {
    const page = pages.pop();
    try { page?.dom.window.close(); } catch { /* jsdom teardown is best effort */ }
  }
});

function tv(): FakePage {
  const created = createPage({ indexedDb: new IDBFactory() });
  pages.push(created);
  return created;
}

async function runToCompletion<T = any>(page: FakePage, operation: Promise<T>, rounds = 4000): Promise<T> {
  let settled = false;
  let value: T | undefined;
  let failure: any = null;
  operation.then((result) => { settled = true; value = result; }, (error) => { settled = true; failure = error; });
  for (let round = 0; round < rounds && !settled; round += 1) {
    // Trigger onload for any staged image in jsdom
    const img = page.win.document.querySelector('img.sp-media') as any;
    if (img && typeof img.onload === 'function') {
      Object.defineProperty(img, 'naturalWidth', { value: 1920, configurable: true });
      img.onload();
    }
    await settle(page.win, page.clock, 1);
  }
  if (!settled) throw new Error('Player operation did not settle');
  if (failure) throw failure;
  return value as T;
}

describe('LG webOS 3.5 player recovery & telemetry invariants', () => {
  it('recomputes a valid manifestHash on reduced manifests so they survive verifyManifestHash across restarts and sync cycles', async () => {
    const fixture = buildFixture();
    const plan = createTransport(fixture);
    const page = tv();

    const storage = await runToCompletion(page, page.runtime.createStorage(page.win, { Promise: page.win.Promise }));
    const http = page.runtime.createHttp(page.win, { Promise: page.win.Promise, transport: plan.transport });
    const sync = page.runtime.createSync({
      win: page.win,
      storage,
      http,
      token: 'tv-token',
      Promise: page.win.Promise,
      preflightAsset: (asset: any) => asset.hash !== fixture.videoHash,
    });

    const first: any = await runToCompletion(page, sync.run());
    await settle(page.win, page.clock);
    expect(first.skipped).toBe(1);
    expect(first.manifest.sourceManifestHash).toBe(fixture.manifest.manifestHash);
    expect(first.manifest.manifestHash).not.toBe(fixture.manifest.manifestHash);
    // Crucial invariant: the reduced manifest stored in IndexedDB/storage MUST pass validateManifest
    // and verifyManifestIntegrity, otherwise getActiveManifest rejects it on the next sync/reboot.
    expect(page.runtime.validateManifest(first.manifest)).toBe(true);
    expect(page.runtime.verifyManifestIntegrity(first.manifest)).toBe(true);

    const stored = await runToCompletion(page, storage.getActiveManifest());
    expect(page.runtime.validateManifest(stored)).toBe(true);
  });

  it('does not re-hash local assets a second time during switchManifest after sync has already verified them', async () => {
    const fixture = buildFixture();
    const plan = createTransport(fixture);
    const page = tv();

    const storage = await runToCompletion(page, page.runtime.createStorage(page.win, { Promise: page.win.Promise }));
    let getAssetPartsCalls = 0;
    const origGetAssetParts = storage.getAssetParts.bind(storage);
    storage.getAssetParts = function (hash: string) {
      getAssetPartsCalls += 1;
      return origGetAssetParts(hash);
    };

    const http = page.runtime.createHttp(page.win, { Promise: page.win.Promise, transport: plan.transport });
    const sync = page.runtime.createSync({
      win: page.win,
      storage,
      http,
      token: 'tv-token',
      Promise: page.win.Promise,
      deferActivation: true,
      preflightAsset: () => true,
    });

    const result: any = await runToCompletion(page, sync.run());
    await settle(page.win, page.clock);
    const partsCallsAfterSync = getAssetPartsCalls;
    expect(partsCallsAfterSync).toBeGreaterThanOrEqual(2);

    const stage = page.win.document.createElement('div');
    page.win.document.body.appendChild(stage);
    const engine = page.runtime.createEngine({
      win: page.win,
      doc: page.win.document,
      stage,
      storage,
      sync,
      http,
      token: 'tv-token',
      Promise: page.win.Promise,
    });

    const activated = await runToCompletion(
      page,
      engine.switchManifest(result.manifest, (candidate: any) => storage.activateManifest(candidate)),
    );
    expect(activated).toBe(true);
    // switchManifest / resolveLocalSource must reuse storage._verifiedAssetHashes instead of
    // re-reading and re-hashing every chunk of the asset from IndexedDB.
    expect(getAssetPartsCalls).toBe(partsCallsAfterSync);
  });

  it('resolves video preflight on loadedmetadata when videoWidth > 0 (webOS 3.5 hardware decoder behavior)', async () => {
    const fixture = buildFixture();
    const page = tv();

    // Override createElement('video') so setting src triggers loadedmetadata with videoWidth=1920,
    // without firing canplay (matching LG webOS 3.5 / Chromium 38 before playback starts).
    const origCreateElement = page.win.document.createElement.bind(page.win.document);
    page.win.document.createElement = function (tag: string) {
      const el = origCreateElement(tag);
      if (String(tag).toLowerCase() === 'video') {
        el.canPlayType = () => 'maybe';
        Object.defineProperty(el, 'videoWidth', { get: () => 1920, configurable: true });
        Object.defineProperty(el, 'readyState', { get: () => 1, configurable: true });
        Object.defineProperty(el, 'src', {
          set() {
            page.win.setTimeout(() => {
              if (typeof el.onloadedmetadata === 'function') el.onloadedmetadata({});
            }, 5);
          },
          get() { return 'blob:mock'; },
          configurable: true,
        });
      }
      return el;
    };

    const storage = await runToCompletion(page, page.runtime.createStorage(page.win, { Promise: page.win.Promise }));
    const videoAsset = fixture.manifest.assets.find((a: any) => a.mimeType === 'video/mp4')!;
    await runToCompletion(
      page,
      storage.saveChunk(videoAsset.hash, 0, fixture.videoBytes, {
        expectedSize: fixture.videoBytes.byteLength,
        mimeType: videoAsset.mimeType,
        chunkSize: page.runtime.DEFAULT_CHUNK_SIZE,
      }),
    );
    await runToCompletion(
      page,
      storage.finalizeAsset(videoAsset.hash, fixture.videoBytes.byteLength, videoAsset.mimeType, 1, page.runtime.DEFAULT_CHUNK_SIZE),
    );

    const ok = await runToCompletion(
      page,
      page.runtime.preflightAsset(page.win, storage, videoAsset, { Promise: page.win.Promise, timeoutMs: 2000 }),
    );
    expect(ok).toBe(true);
  });

  it('advances to the next candidate item instead of rolling back to a blank screen when item #0 fails on a cold start', async () => {
    const fixture = buildFixture();
    // Put the video at position 0 and the image at position 1 (like the production playlist).
    fixture.manifest.playlists[0].items.reverse();
    fixture.manifest.playlists[0].items.forEach((item: any, idx: number) => { item.position = idx; });
    refreshManifestHash(fixture.manifest);

    const plan = createTransport(fixture);
    const page = tv();

    const storage = await runToCompletion(page, page.runtime.createStorage(page.win, { Promise: page.win.Promise }));
    const http = page.runtime.createHttp(page.win, { Promise: page.win.Promise, transport: plan.transport });
    const sync = page.runtime.createSync({
      win: page.win,
      storage,
      http,
      token: 'tv-token',
      Promise: page.win.Promise,
      deferActivation: true,
      preflightAsset: () => true,
    });

    const synced: any = await runToCompletion(page, sync.run());

    // Make video fail with onerror during playback staging while image succeeds.
    page.win.HTMLMediaElement.prototype.play = function () { return undefined; };
    const origCreateElement = page.win.document.createElement.bind(page.win.document);
    page.win.document.createElement = function (tag: string) {
      const el = origCreateElement(tag);
      if (String(tag).toLowerCase() === 'video') {
        Object.defineProperty(el, 'src', {
          set() {
            page.win.setTimeout(() => {
              if (typeof el.onerror === 'function') el.onerror(new Error('video decode failed'));
            }, 5);
          },
          get() { return 'blob:video-fail'; },
          configurable: true,
        });
      }
      return el;
    };

    const stage = page.win.document.createElement('div');
    page.win.document.body.appendChild(stage);
    const engine = page.runtime.createEngine({
      win: page.win,
      doc: page.win.document,
      stage,
      storage,
      sync,
      http,
      token: 'tv-token',
      Promise: page.win.Promise,
    });

    const activated = await runToCompletion(
      page,
      engine.switchManifest(synced.manifest, (candidate: any) => storage.activateManifest(candidate)),
    );
    expect(activated).toBe(true);
    expect(engine.currentItem()?.kind).toBe('image');
  });

  it('reports honest syncStatus before sync and schedules a post-sync heartbeat with cachedMediaCount, storageUsageBytes, and active item', async () => {
    const fixture = buildFixture();
    // Put video at position 0 so installMediaStubs auto-plays it immediately upon staging
    fixture.manifest.playlists[0].items.reverse();
    fixture.manifest.playlists[0].items.forEach((item: any, idx: number) => { item.position = idx; });
    refreshManifestHash(fixture.manifest);

    const plan = createTransport(fixture);
    const page = tv();
    page.win.__SIGNAGE_TRANSPORT__ = plan.transport;
    page.win.__SIGNAGE_PREFLIGHT_ASSET__ = () => true;

    const storage = await runToCompletion(page, page.runtime.createStorage(page.win, { Promise: page.win.Promise }));
    await runToCompletion(page, storage.setCredential('tv-live-token'));

    const player = page.ui.create({
      win: page.win,
      doc: page.win.document,
      root: page.win.document.getElementById('signage-root'),
      runtime: page.runtime,
      storage,
    });
    await runToCompletion(page, player.start());
    await settle(page.win, page.clock, 120);
    // Advance virtual clock by 6s so the post-sync scheduleBeat fires after minBeatGapMs (5000ms)
    page.clock.advance(6000);
    await settle(page.win, page.clock, 60);

    const heartbeats = plan.calls
      .filter((call) => call.url === '/api/player/heartbeat')
      .map((call) => JSON.parse(call.body || '{}'));

    expect(heartbeats.length).toBeGreaterThanOrEqual(2);
    // Initial boot beat before manifest activation must NOT claim syncStatus === 'ready'
    expect(heartbeats[0].syncStatus).toBe('syncing');

    // Post-sync beat (scheduled 2s after sync completion) must report ready, cachedMediaCount=2,
    // non-null storageUsageBytes, and the active playlist + item.
    const latestBeat = heartbeats[heartbeats.length - 1];
    expect(latestBeat.syncStatus).toBe('ready');
    expect(latestBeat.cachedMediaCount).toBe(2);
    expect(latestBeat.storageUsageBytes).toBe(fixture.imageBytes.byteLength + fixture.videoBytes.byteLength);
    expect(latestBeat.currentPlaylistId).toBe(fixture.manifest.defaultPlaylistId);
    expect(latestBeat.currentItemId).toBeTruthy();
    expect(latestBeat.deviceInfo.playerVersion).toBe('3.0.0-7');
    expect(latestBeat.deviceInfo.runtimeVersion).toBe('2.2.2');
    expect(latestBeat.deviceInfo.storageBackend).toBe('indexeddb');

    player.destroy();
  });
});
