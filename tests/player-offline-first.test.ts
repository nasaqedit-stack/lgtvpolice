/*
 * Playback-first acceptance tests for the /player signage runtime.
 *
 * The rule these tests enforce: PLAYBACK > CACHE > SYNC. Once a playlist item is cached and
 * validated, the television keeps showing it with zero network — and every synchronization
 * failure (manifest, media download, timeout, revoked credential, dead socket) is a diagnostic,
 * never a stopped, blanked or reloaded player.
 */
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildFixture,
  createPage,
  createTransport,
  installBlobUrls,
  jsonResponse,
  networkError,
  refreshManifestHash,
  settle,
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

async function boot(target: FakePage): Promise<any> {
  const player = target.ui.create({ win: target.win, runtime: target.runtime });
  await runToCompletion(target, player.start());
  await settle(target.win, target.clock, 60);
  return player;
}

/** Every request fails at the network level, exactly like an unplugged television. */
const deadNetwork: Transport = () => Promise.reject(networkError());

async function openStorage(target: FakePage): Promise<any> {
  return target.runtime.createStorage(target.win, { Promise: target.win.Promise, log: () => undefined });
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

/** Fills the persistent store exactly as a completed sync would have left it. */
async function seedCache(target: FakePage, fixture: ReturnType<typeof buildFixture>, token = 'credential-1'): Promise<any> {
  const storage = await openStorage(target);
  if (token) await storage.setCredential(token);
  await saveAsset(storage, fixture.imageHash, fixture.imageBytes, 'image/png');
  await saveAsset(storage, fixture.videoHash, fixture.videoBytes, 'video/mp4');
  await storage.activateManifest(fixture.manifest);
  return storage;
}

/** Activates a manifest, then removes one asset — exactly like an evicted cache entry. */
async function seedCacheMissing(target: FakePage, fixture: ReturnType<typeof buildFixture>, missingHash: string): Promise<any> {
  const storage = await seedCache(target, fixture);
  await storage.clearAsset(missingHash);
  return storage;
}

function setPairCode(target: FakePage, code: string): void {
  const input = target.win.document.querySelector('#signage-pair-code') as any;
  expect(input, 'the pairing input must be rendered').toBeTruthy();
  input.value = code;
  input.oninput();
  const form = target.win.document.querySelector('.sp-form') as any;
  form.onsubmit({ preventDefault() { /* no-op */ } });
}

async function mediaElement(target: FakePage): Promise<any> {
  await waitFor(target.win, target.clock, () => Boolean(target.win.document.querySelector('img.sp-media, video.sp-video')));
  return target.win.document.querySelector('img.sp-media, video.sp-video');
}

function overlay(target: FakePage): any {
  return target.win.document.querySelector('.sp-overlay');
}

describe('cached playback never depends on the network', () => {
  it('never reuses a legacy localStorage credential when IndexedDB has none', async () => {
    const fixture = buildFixture();
    const plan = createTransport(fixture);
    const target = page({ indexedDb: new IDBFactory(), transport: plan.transport });
    target.win.localStorage.setItem('signage.screenToken', 'existing-screen-credential');

    const player = await boot(target);
    await settle(target.win, target.clock, 400);

    expect(player.state.token).toBeNull();
    expect(target.win.localStorage.getItem('signage.screenToken')).toBeNull();
    expect(target.win.document.querySelector('#signage-pair-code')).toBeTruthy();
    expect(plan.calls.some((call) => call.url === '/api/player/manifest' || call.url === '/api/player/heartbeat')).toBe(false);
  });

  it('prefers IndexedDB and removes a legacy localStorage credential without using it', async () => {
    const fixture = buildFixture();
    const factory = new IDBFactory();
    const seeded = page({ indexedDb: factory });
    const storage = await openStorage(seeded);
    await storage.setCredential('current-indexeddb-credential');
    seeded.dom.window.close();

    const plan = createTransport(fixture);
    const target = page({ indexedDb: factory, transport: plan.transport });
    target.win.localStorage.setItem('signage.screenToken', 'older-localstorage-credential');
    const player = await boot(target);
    await settle(target.win, target.clock, 400);

    expect(player.state.token).toBe('current-indexeddb-credential');
    expect(target.win.localStorage.getItem('signage.screenToken')).toBeNull();
    expect(target.win.document.querySelector('#signage-pair-code')).toBeNull();
    expect(plan.calls.some((call) => call.url === '/api/player/pair')).toBe(false);
  });

  it('starts cached media with every single request failing (offline cold start)', async () => {
    const fixture = buildFixture();
    const factory = new IDBFactory();
    const seeded = page({ indexedDb: factory });
    await seedCache(seeded, fixture);
    seeded.dom.window.close();

    let successes = 0;
    const counted: Transport = () => Promise.reject(networkError()).then(
      () => { successes += 1; return null as any; },
      (error) => { throw error; }
    );
    const target = page({ indexedDb: factory, transport: counted });
    const player = await boot(target);

    const element: any = await mediaElement(target);
    expect(element.tagName.toLowerCase()).toBe('img');
    expect(element.getAttribute('src')).toContain('blob:');
    // Playback started although not a single request succeeded.
    expect(successes).toBe(0);
    expect(player.state.online).toBe(false);
    expect(overlay(target).style.display).toBe('none');
    expect(target.win.__signageBooted).toBe(true);
  });

  it('plays cached video from the local object URL without any media request during playback', async () => {
    const fixture = buildFixture();
    const plan = createTransport(fixture);
    const target = page({ indexedDb: new IDBFactory() });
    await seedCache(target, fixture);
    const player = await boot(target);

    const engine = player.engine();
    engine.jump(1);
    await settle(target.win, target.clock, 40);
    const video: any = target.win.document.querySelector('video.sp-video');
    expect(video).toBeTruthy();
    expect(video.getAttribute('src')).toContain('blob:');
    video.oncanplay();
    await settle(target.win, target.clock, 20);

    plan.calls.length = 0;
    target.clock.advance(45000);
    await settle(target.win, target.clock, 60);

    // No media traffic at all: the playlist loop is purely local.
    expect(plan.countMatching(/objects\.example\.test/)).toBe(0);
    expect(plan.countMatching(/\/api\/player\/media\//)).toBe(0);
    expect(target.win.document.querySelector('video.sp-video')).toBe(video);
  });

  it('keeps cached video running when LG rejects audible autoplay, without an on-screen action', async () => {
    const fixture = buildFixture();
    const target = page({ indexedDb: new IDBFactory() });
    await seedCache(target, fixture);
    const playAttempts: boolean[] = [];
    target.win.HTMLMediaElement.prototype.play = function (this: any) {
      playAttempts.push(Boolean(this.muted));
      if (!this.muted) {
        const error: any = new Error('play requires a user gesture');
        error.name = 'NotAllowedError';
        return target.win.Promise.reject(error);
      }
      return target.win.Promise.resolve();
    };
    const player = await boot(target);
    player.engine().jump(1);
    await settle(target.win, target.clock, 30);
    const video: any = target.win.document.querySelector('video.sp-video');
    expect(video).toBeTruthy();
    video.oncanplay();
    await settle(target.win, target.clock, 20);

    // Audible autoplay is attempted first; after the browser rejects it, muted playback starts itself.
    expect(playAttempts).toContain(false);
    expect(playAttempts).toContain(true);
    expect(target.win.document.querySelector('.sp-audio-control')).toBeNull();
    expect(video.muted).toBe(true);
    expect(overlay(target).style.display).toBe('none');
    expect(player.log().some((entry: any) => entry.event === 'muted_autoplay_started')).toBe(true);
  });

  it('never lets a failing manifest interrupt or cover the media on screen', async () => {
    const fixture = buildFixture({ imageDurationMs: 600000 });
    const planOptions: Parameters<typeof createTransport>[1] = {};
    const plan = createTransport(fixture, planOptions);
    const target = page({ indexedDb: new IDBFactory(), transport: plan.transport });
    await seedCache(target, fixture);
    const player = await boot(target);

    const image: any = await mediaElement(target);
    image.onload();
    await settle(target.win, target.clock, 20);
    expect(overlay(target).style.display).toBe('none');

    planOptions.manifestStatus = 500;
    planOptions.signedUrlStatus = 503;
    target.clock.advance(61000);
    await settle(target.win, target.clock, 200);

    // The failure is recorded as a diagnostic; the picture is untouched.
    expect(player.state.error).not.toBe('');
    expect(player.state.playing).toBe(true);
    expect(target.win.document.querySelector('img.sp-media')).toBe(image);
    expect(overlay(target).style.display).toBe('none');
    expect(player.log().some((entry: any) => entry.event === 'reload')).toBe(false);
  });

  it('arms one bounded page reload only after repeated local watchdog recovery failures', async () => {
    const fixture = buildFixture();
    const factory = new IDBFactory();
    const seeded = page({ indexedDb: factory });
    await seedCache(seeded, fixture);
    seeded.dom.window.close();
    const target = page({ indexedDb: factory, transport: deadNetwork });
    const player = await boot(target);
    const engine = player.engine();
    engine.displayStatus = () => ({ healthy: false, hasLocal: true, playable: true });
    engine.isMounted = () => false;
    engine.isPending = () => false;
    engine.hasLocalMedia = () => true;
    engine.ensurePlaying = () => true;
    engine.render = () => true;
    engine.recover = () => true;

    for (let tick = 0; tick < 12; tick += 1) {
      target.clock.advance(15000);
      await settle(target.win, target.clock, 2);
    }
    expect(player.log().some((entry: any) => entry.event === 'reload')).toBe(false);
    target.clock.advance(5000);
    await settle(target.win, target.clock, 20);
    expect(player.log().filter((entry: any) => entry.event === 'reload')).toHaveLength(1);
    expect(player.log().some((entry: any) => entry.event === 'watchdog_page_reload_final')).toBe(true);
  });

  it('keeps showing cached media when the credential is revoked (no pairing takeover)', async () => {
    const fixture = buildFixture({ imageDurationMs: 600000 });
    const plan = createTransport(fixture, { heartbeatStatus: 401 });
    const target = page({ indexedDb: new IDBFactory(), transport: plan.transport });
    await seedCache(target, fixture);
    const player = await boot(target);

    const image: any = await mediaElement(target);
    image.onload();
    await settle(target.win, target.clock, 20);

    target.clock.advance(61000);
    await settle(target.win, target.clock, 120);

    expect(player.state.token).toBeNull();
    expect(await player.storage().getCredential()).toBeNull();
    // Nothing is cached away and the pair form is not pushed over the picture.
    expect(target.win.document.querySelector('img.sp-media')).toBe(image);
    expect(target.win.document.querySelector('#signage-pair-code')).toBeNull();
    expect(overlay(target).style.display).toBe('none');
  });
});

describe('navigator.onLine and background failures', () => {
  it('never pauses, reloads or blanks playback for navigator.onLine === false', async () => {
    const fixture = buildFixture({ imageDurationMs: 600000 });
    let online = true;
    const plan = createTransport(fixture);
    const transport: Transport = (spec) => (online ? plan.transport(spec) : Promise.reject(networkError()));
    const target = page({ indexedDb: new IDBFactory(), transport });
    await seedCache(target, fixture);
    const player = await boot(target);

    const image: any = await mediaElement(target);
    image.onload();
    await settle(target.win, target.clock, 20);
    const pausesBefore = target.media.pause.length;

    online = false;
    Object.defineProperty(target.win.navigator, 'onLine', { configurable: true, value: false });
    target.win.dispatchEvent(new target.win.Event('offline'));
    target.clock.advance(120000);
    await settle(target.win, target.clock, 200);

    expect(target.win.document.querySelector('img.sp-media')).toBe(image);
    expect(image.style.display).toBe('block');
    expect(image.getAttribute('src')).toContain('blob:');
    expect(overlay(target).style.display).toBe('none');
    expect(player.state.online).toBe(false);
    expect(target.media.pause.length).toBe(pausesBefore);
    expect(player.log().some((entry: any) => entry.event === 'reload')).toBe(false);
  });

  it('backs off heartbeat HTTP failures and retries automatically without clearing the credential', async () => {
    const fixture = buildFixture({ imageDurationMs: 600000 });
    const options: Parameters<typeof createTransport>[1] = { heartbeatStatus: 503 };
    const plan = createTransport(fixture, options);
    const target = page({ indexedDb: new IDBFactory(), transport: plan.transport });
    await seedCache(target, fixture);
    const player = await boot(target);

    expect(plan.count('/api/player/heartbeat')).toBe(1);
    expect(await player.storage().getCredential()).toBe('credential-1');
    expect(player.log().filter((entry: any) => entry.event === 'heartbeat_retry_scheduled')[0].data.retryInMs).toBe(15000);
    // The scheduled delay carries jitter (±25%) so a fleet of televisions never retries in lockstep;
    // the reported backoff stays on the exact exponential ladder.
    target.clock.advance(20000);
    await settle(target.win, target.clock, 100);
    expect(plan.count('/api/player/heartbeat')).toBe(2);
    const retries = player.log().filter((entry: any) => entry.event === 'heartbeat_retry_scheduled');
    expect(retries[1].data.retryInMs).toBe(30000);

    options.heartbeatStatus = 200;
    target.win.dispatchEvent(new target.win.Event('online'));
    await settle(target.win, target.clock, 100);
    expect(plan.count('/api/player/heartbeat')).toBe(3);
    expect(player.state.token).toBe('credential-1');
    expect(await player.storage().getCredential()).toBe('credential-1');
    expect(target.win.document.querySelector('#signage-pair-code')).toBeNull();
  });

  it('sends heartbeat immediately when connectivity returns and preserves cached playback', async () => {
    const fixture = buildFixture({ imageDurationMs: 600000 });
    const options: Parameters<typeof createTransport>[1] = { heartbeatStatus: 503 };
    const plan = createTransport(fixture, options);
    const target = page({ indexedDb: new IDBFactory(), transport: plan.transport });
    await seedCache(target, fixture);
    const player = await boot(target);
    const image: any = await mediaElement(target);
    image.onload();
    await settle(target.win, target.clock, 20);
    expect(plan.count('/api/player/heartbeat')).toBe(1);

    options.heartbeatStatus = 200;
    target.win.dispatchEvent(new target.win.Event('online'));
    await settle(target.win, target.clock, 100);

    expect(plan.count('/api/player/heartbeat')).toBe(2);
    expect(player.state.token).toBe('credential-1');
    expect(await player.storage().getCredential()).toBe('credential-1');
    expect(target.win.document.querySelector('img.sp-media')).toBe(image);
    expect(image.style.display).toBe('block');
    expect(overlay(target).style.display).toBe('none');
  });

  it('retains the credential when heartbeat or manifest 401 lacks explicit screen_unauthorized evidence', async () => {
    const fixture = buildFixture({ imageDurationMs: 600000 });
    const plan = createTransport(fixture);
    const transport: Transport = (spec) => (spec.url === '/api/player/heartbeat' || spec.url === '/api/player/manifest')
      ? Promise.resolve(jsonResponse(401, { error: 'temporary gateway response', code: 'internal_error' }))
      : plan.transport(spec);
    const target = page({ indexedDb: new IDBFactory(), transport });
    await seedCache(target, fixture);
    const player = await boot(target);
    const image: any = await mediaElement(target);
    image.onload();
    await settle(target.win, target.clock, 20);

    expect(player.state.token).toBe('credential-1');
    expect(await player.storage().getCredential()).toBe('credential-1');
    expect(target.win.document.querySelector('#signage-pair-code')).toBeNull();
    expect(player.log().some((entry: any) => entry.event === 'heartbeat_retry_scheduled')).toBe(true);
    expect(player.log().some((entry: any) => entry.event === 'sync_failed' && entry.data.code === 'network_offline')).toBe(true);
    expect(target.win.document.querySelector('img.sp-media')).toBe(image);
    expect(overlay(target).style.display).toBe('none');
  });

  it('softens a remote reload command while a locally cached playlist is active', async () => {
    const fixture = buildFixture();
    fixture.manifest.commands.reloadVersion = 1;
    refreshManifestHash(fixture.manifest);
    const plan = createTransport(fixture);
    const target = page({ indexedDb: new IDBFactory(), transport: plan.transport });
    await seedCache(target, fixture);
    const player = await boot(target);
    const image: any = await mediaElement(target);
    image.onload();
    await settle(target.win, target.clock, 120);

    expect(player.log().some((entry: any) => entry.event === 'reload_command_softened')).toBe(true);
    expect(player.log().some((entry: any) => entry.event === 'reload')).toBe(false);
    expect(target.win.document.querySelector('img.sp-media')).toBe(image);
    expect(image.style.display).toBe('block');
    expect(overlay(target).style.display).toBe('none');
  });
});

describe('atomic playlist activation', () => {
  it('keeps the active playlist when a new download is corrupt', async () => {
    const fixture = buildFixture();
    const factory = new IDBFactory();
    const seeded = page({ indexedDb: factory });
    const storage = await seedCache(seeded, fixture);
    seeded.dom.window.close();

    // A new revision whose image arrives corrupted from storage.
    const next = buildFixture({ imageBytes: 'image-two-corrupt-me' });
    refreshManifestHash(next.manifest);
    const plan = createTransport(next, { corruptedImage: true });

    const target = page({ indexedDb: factory, transport: plan.transport });
    const player = await boot(target);
    await settle(target.win, target.clock, 200);

    const check = await openStorage(target);
    expect((await check.getActiveManifest()).manifestHash).toBe(fixture.manifest.manifestHash);
    expect(await check.hasCompleteAsset(fixture.imageHash, fixture.imageBytes.length, 'image/png')).toBe(true);
    expect(player.state.playing).toBe(true);
    expect(target.win.document.querySelector('img.sp-media, video.sp-video')).toBeTruthy();
    void storage;
  });

  it('never activates a playlist whose media download failed, and keeps playing', async () => {
    const fixture = buildFixture();
    const factory = new IDBFactory();
    const seeded = page({ indexedDb: factory });
    await seedCache(seeded, fixture);
    seeded.dom.window.close();

    const next = buildFixture({ imageBytes: 'image-two-unreachable' });
    refreshManifestHash(next.manifest);
    const plan = createTransport(next, { failMediaTimes: 100 });

    const target = page({ indexedDb: factory, transport: plan.transport });
    const player = await boot(target);
    // First playback has already started from cache before the failing download.
    const element: any = await mediaElement(target);
    expect(element.getAttribute('src')).toContain('blob:');
    await settle(target.win, target.clock, 400);

    const check = await openStorage(target);
    expect((await check.getActiveManifest()).manifestHash).toBe(fixture.manifest.manifestHash);
    expect(player.state.playing).toBe(true);
    expect(overlay(target).style.display).toBe('none');
  });

  it('protects the media that is currently on screen from garbage collection', async () => {
    const fixture = buildFixture();
    const target = page({ indexedDb: new IDBFactory() });
    const storage = await openStorage(target);
    await saveAsset(storage, fixture.imageHash, fixture.imageBytes, 'image/png');
    await saveAsset(storage, fixture.videoHash, fixture.videoBytes, 'video/mp4');

    // A brand new revision that no longer references the image that is playing right now.
    const next = buildFixture({ imageBytes: 'image-two-new-content' });
    refreshManifestHash(next.manifest);
    const plan = createTransport(next);
    const http = target.runtime.createHttp(target.win, { Promise: target.win.Promise, transport: plan.transport });
    const sync = target.runtime.createSync({
      win: target.win, storage, http, token: 'credential-1', Promise: target.win.Promise,
      protectHashes: () => [fixture.imageHash]
    });
    await runToCompletion(target, sync.run());
    expect(await storage.hasCompleteAsset(fixture.imageHash, fixture.imageBytes.length, 'image/png')).toBe(true);

    // Once nothing protects it any more, the next synchronization may collect it.
    const http2 = target.runtime.createHttp(target.win, { Promise: target.win.Promise, transport: plan.transport });
    const sync2 = target.runtime.createSync({ win: target.win, storage, http: http2, token: 'credential-1', Promise: target.win.Promise });
    await runToCompletion(target, sync2.run());
    expect(await storage.hasCompleteAsset(fixture.imageHash, fixture.imageBytes.length, 'image/png')).toBe(false);
    expect(await storage.hasCompleteAsset(next.imageHash, next.imageBytes.length, 'image/png')).toBe(true);
  });

  it('recovers one QuotaExceededError by collecting only stale media and preserves active/pending content and identity', async () => {
    const current = buildFixture();
    const factory = new IDBFactory();
    const seeded = page({ indexedDb: factory });
    await seedCache(seeded, current, 'existing-screen-identity');
    seeded.dom.window.close();

    const next = buildFixture({ imageBytes: 'next revision media bytes' });
    refreshManifestHash(next.manifest);
    const stale = buildFixture({ imageBytes: 'unreferenced old cache bytes' });
    const plan = createTransport(next);
    const target = page({ indexedDb: factory, transport: plan.transport });
    const storage = await openStorage(target);
    const originalSave = storage.saveChunk.bind(storage);
    let failedOnce = false;
    let pendingImageWriteAttempts = 0;
    storage.saveChunk = (hash: string, index: number, bytes: Uint8Array, meta: any) => {
      if (hash === next.imageHash && index === 0) {
        pendingImageWriteAttempts += 1;
        if (!failedOnce) {
          failedOnce = true;
          return originalSave(stale.imageHash, 0, stale.imageBytes, {
            expectedSize: stale.imageBytes.length, mimeType: 'image/png', chunkSize: 4 * 1024 * 1024
          }).then(() => storage.finalizeAsset(stale.imageHash, stale.imageBytes.length, 'image/png', 1, 4 * 1024 * 1024))
            .then(() => {
              const error: any = new Error('storage quota exceeded');
              error.name = 'QuotaExceededError';
              throw error;
            });
        }
      }
      return originalSave(hash, index, bytes, meta);
    };
    const http = target.runtime.createHttp(target.win, { Promise: target.win.Promise, transport: plan.transport });
    const sync = target.runtime.createSync({
      win: target.win, storage, http, token: 'existing-screen-identity', Promise: target.win.Promise,
      protectHashes: () => [current.imageHash]
    });

    await runToCompletion(target, sync.run());
    expect(pendingImageWriteAttempts).toBe(2);
    expect(await storage.hasCompleteAsset(stale.imageHash, stale.imageBytes.length, 'image/png')).toBe(false);
    expect(await storage.hasCompleteAsset(current.imageHash, current.imageBytes.length, 'image/png')).toBe(true);
    expect(await storage.hasCompleteAsset(next.imageHash, next.imageBytes.length, 'image/png')).toBe(true);
    expect((await storage.getActiveManifest()).manifestHash).toBe(next.manifest.manifestHash);
    expect(await storage.getCredential()).toBe('existing-screen-identity');
  });

  it('keeps the active display when candidate render preflight fails before activation', async () => {
    const current = buildFixture({ imageDurationMs: 600000 });
    const next = buildFixture({ imageBytes: 'candidate image cannot be decoded', imageDurationMs: 600000 });
    refreshManifestHash(next.manifest);
    const failure = { manifestStatus: 503 };
    const plan = createTransport(next, failure);
    const factory = new IDBFactory();
    const seeded = page({ indexedDb: factory });
    await seedCache(seeded, current);
    seeded.dom.window.close();

    const target = page({ indexedDb: factory, transport: plan.transport });
    const player = await boot(target);
    const oldImage: any = await mediaElement(target);
    oldImage.onload();
    await settle(target.win, target.clock, 30);
    await waitFor(target.win, target.clock, () => player.log().some((entry: any) => entry.event === 'sync_failed'), 400);

    target.win.__SIGNAGE_PREFLIGHT_ASSET__ = (asset: any) => asset.hash === next.imageHash
      ? target.win.Promise.reject(Object.assign(new Error('decoder rejected candidate'), { code: 'render_preflight_failed' }))
      : target.win.Promise.resolve(true);
    failure.manifestStatus = 0;
    target.clock.advance(16000);
    await settle(target.win, target.clock, 20);
    player.watchdog().requestSync('candidate_preflight_test');
    await waitFor(target.win, target.clock, () => player.log().some((entry: any) => entry.event === 'sync_failed' && entry.data.code === 'render_preflight_failed'), 600);

    const check = await openStorage(target);
    expect((await check.getActiveManifest()).manifestHash).toBe(current.manifest.manifestHash);
    expect(player.state.manifest.manifestHash).toBe(current.manifest.manifestHash);
    expect(oldImage.style.display).toBe('block');
    expect(target.win.document.querySelectorAll('img.sp-media').length).toBe(1);
    expect(overlay(target).style.display).toBe('none');
  });

  it('rolls back a prepared candidate whose first rendered image fails, without blanking the old frame', async () => {
    const current = buildFixture({ imageDurationMs: 600000 });
    const next = buildFixture({ imageBytes: 'candidate image fails during mount', imageDurationMs: 600000 });
    refreshManifestHash(next.manifest);
    const failure = { manifestStatus: 503 };
    const plan = createTransport(next, failure);
    const factory = new IDBFactory();
    const seeded = page({ indexedDb: factory });
    await seedCache(seeded, current);
    seeded.dom.window.close();

    const target = page({ indexedDb: factory, transport: plan.transport });
    const player = await boot(target);
    const oldImage: any = await mediaElement(target);
    oldImage.onload();
    await settle(target.win, target.clock, 30);
    await waitFor(target.win, target.clock, () => player.log().some((entry: any) => entry.event === 'sync_failed'), 400);

    failure.manifestStatus = 0;
    target.clock.advance(16000);
    await settle(target.win, target.clock, 20);
    player.watchdog().requestSync('candidate_render_test');
    await waitFor(target.win, target.clock, () => {
      const images = Array.from(target.win.document.querySelectorAll('img.sp-media')) as any[];
      return images.some((image) => image !== oldImage);
    }, 600);
    const candidate: any = Array.from(target.win.document.querySelectorAll('img.sp-media')).find((image: any) => image !== oldImage);
    expect(candidate).toBeTruthy();
    expect((await (await openStorage(target)).getActiveManifest()).manifestHash).toBe(current.manifest.manifestHash);
    candidate.onerror();
    await settle(target.win, target.clock, 80);

    const check = await openStorage(target);
    expect((await check.getActiveManifest()).manifestHash).toBe(current.manifest.manifestHash);
    expect(player.state.manifest.manifestHash).toBe(current.manifest.manifestHash);
    expect(oldImage.style.display).toBe('block');
    expect(target.win.document.querySelector('img.sp-media')).toBe(oldImage);
    expect(overlay(target).style.display).toBe('none');
    expect(player.log().some((entry: any) => entry.event === 'manifest_switch_rolled_back')).toBe(true);
  });

  it('keeps the current manifest and credential when quota remains exhausted after one safe cleanup retry', async () => {
    const current = buildFixture();
    const factory = new IDBFactory();
    const seeded = page({ indexedDb: factory });
    await seedCache(seeded, current, 'existing-screen-identity');
    seeded.dom.window.close();

    const next = buildFixture({ imageBytes: 'media that cannot fit in storage' });
    refreshManifestHash(next.manifest);
    const plan = createTransport(next);
    const target = page({ indexedDb: factory, transport: plan.transport });
    const storage = await openStorage(target);
    let writeAttempts = 0;
    const quotaFailure = () => {
      const error: any = new Error('quota exceeded');
      error.name = 'QuotaExceededError';
      return target.win.Promise.reject(error);
    };
    storage.saveChunk = (hash: string, index: number) => {
      if (hash === next.imageHash && index === 0) { writeAttempts += 1; return quotaFailure(); }
      return target.win.Promise.reject(new Error('unexpected media write'));
    };
    const http = target.runtime.createHttp(target.win, { Promise: target.win.Promise, transport: plan.transport });
    const sync = target.runtime.createSync({
      win: target.win, storage, http, token: 'existing-screen-identity', Promise: target.win.Promise,
      protectHashes: () => [current.imageHash]
    });

    await expect(runToCompletion(target, sync.run())).rejects.toMatchObject({ code: 'storage_quota' });
    expect(writeAttempts).toBe(2);
    expect((await storage.getActiveManifest()).manifestHash).toBe(current.manifest.manifestHash);
    expect(await storage.hasCompleteAsset(current.imageHash, current.imageBytes.length, 'image/png')).toBe(true);
    expect(await storage.getCredential()).toBe('existing-screen-identity');
  });
});

describe('missing content never blanks the screen', () => {
  it('keeps the previous item playing when the next asset is not cached and the network is down', async () => {
    const fixture = buildFixture();
    const target = page({ indexedDb: new IDBFactory(), transport: deadNetwork });
    await seedCacheMissing(target, fixture, fixture.videoHash);

    const player = await boot(target);
    const image: any = await mediaElement(target);
    image.onload();
    await settle(target.win, target.clock, 20);
    expect(player.engine().index()).toBe(0);

    // The playlist tries to move on to the missing video: the image must stay on screen.
    target.clock.advance(5100);
    await settle(target.win, target.clock, 60);
    expect(player.engine().index()).toBe(1);
    expect(target.win.document.querySelector('img.sp-media')).toBe(image);
    expect(image.style.display).toBe('block');
    expect(image.getAttribute('src')).toContain('blob:');
    expect(player.engine().isMounted()).toBe(true);
    expect(player.log().some((entry: any) => entry.event === 'media_missing')).toBe(true);
  });

  it('does not reload the player when a cached playlist cannot be displayed (no reload loop)', async () => {
    const fixture = buildFixture();
    const target = page({ indexedDb: new IDBFactory(), transport: deadNetwork });
    await seedCacheMissing(target, fixture, fixture.videoHash);

    const player = await boot(target);
    const image: any = await mediaElement(target);
    image.onload();
    target.clock.advance(300000);
    await settle(target.win, target.clock, 400);

    expect(player.log().some((entry: any) => entry.event === 'reload')).toBe(false);
    expect(target.win.document.querySelector('img.sp-media, video.sp-video')).toBeTruthy();
  });
});

describe('watchdog and crash recovery', () => {
  it('resumes automatically after pause, blur/focus, visibility and pageshow events', async () => {
    const fixture = buildFixture();
    const target = page({ indexedDb: new IDBFactory(), transport: deadNetwork });
    await seedCache(target, fixture);
    const player = await boot(target);
    const engine = player.engine();
    engine.jump(1);
    await settle(target.win, target.clock, 30);
    const video: any = target.win.document.querySelector('video.sp-video');
    expect(video).toBeTruthy();
    video.oncanplay();
    await settle(target.win, target.clock, 20);
    target.clock.advance(1100);
    await settle(target.win, target.clock, 5);
    const playsBefore = target.media.play.length;

    video.onpause();
    target.win.dispatchEvent(new target.win.Event('blur'));
    target.win.document.dispatchEvent(new target.win.Event('visibilitychange'));
    target.win.dispatchEvent(new target.win.Event('focus'));
    target.win.dispatchEvent(new target.win.Event('pageshow'));
    await settle(target.win, target.clock, 30);

    expect(target.media.play.length).toBeGreaterThan(playsBefore);
    expect(target.win.document.querySelector('video.sp-video')).toBe(video);
    expect(overlay(target).style.display).toBe('none');
    expect(target.win.document.querySelector('.sp-audio-control')).toBeNull();
    expect(player.log().some((entry: any) => entry.event === 'playback_focus_restore')).toBe(true);
  });

  it('automatically advances from a failed cached video to another local item without a media request', async () => {
    const fixture = buildFixture();
    const calls: string[] = [];
    const failEveryRequest: Transport = (spec) => {
      calls.push(spec.url);
      return Promise.reject(networkError());
    };
    const target = page({ indexedDb: new IDBFactory(), transport: failEveryRequest });
    await seedCache(target, fixture);
    const player = await boot(target);
    player.engine().jump(1);
    await settle(target.win, target.clock, 30);
    const video: any = target.win.document.querySelector('video.sp-video');
    video.oncanplay();
    await settle(target.win, target.clock, 20);
    const callsBefore = calls.length;

    video.onerror();
    await settle(target.win, target.clock, 30);
    const image: any = target.win.document.querySelector('img.sp-media');
    expect(image).toBeTruthy();
    image.onload();
    await settle(target.win, target.clock, 10);

    expect(calls.length).toBe(callsBefore);
    expect(image.style.display).toBe('block');
    expect(overlay(target).style.display).toBe('none');
    expect(player.log().some((entry: any) => entry.event === 'media_error')).toBe(true);
  });

  it('keeps an offline playlist transitioning for a 14-day virtual run with no user actions', async () => {
    const fixture = buildFixture({ imageDurationMs: 3600000 });
    const requests: string[] = [];
    const offline: Transport = (spec) => {
      requests.push(spec.url);
      return Promise.reject(networkError());
    };
    const target = page({ indexedDb: new IDBFactory(), transport: offline });
    await seedCache(target, fixture);
    const player = await boot(target);
    const wallStart = target.win.Date.now();
    target.win.Date.now = function () { return wallStart + target.clock.now(); };
    let image: any = await mediaElement(target);
    image.onload();
    await settle(target.win, target.clock, 5);

    // 14 virtual days of hourly image/video transitions while every network request fails.
    for (let hour = 0; hour < 14 * 24; hour += 1) {
      target.clock.advance(3600000);
      await waitFor(target.win, target.clock, () => Boolean(target.win.document.querySelector('video.sp-video')), 120);
      const video: any = target.win.document.querySelector('video.sp-video');
      expect(video).toBeTruthy();
      video.oncanplay();
      video.onended();
      await settle(target.win, target.clock, 3);
      image = target.win.document.querySelector('img.sp-media');
      expect(image).toBeTruthy();
      image.onload();
      await settle(target.win, target.clock, 3);
      expect(image.style.display).toBe('block');
      expect(overlay(target).style.display).toBe('none');
    }

    expect(requests.filter((url) => /api\/player\/manifest/.test(url)).length).toBeGreaterThan(1);
    expect(requests.filter((url) => /api\/player\/media\//.test(url))).toHaveLength(0);
    expect(player.log().some((entry: any) => entry.event === 'reload')).toBe(false);
    expect(player.state.playing).toBe(true);
  });

  it('reinitializes a stopped video from the cached copy before moving on', async () => {
    const fixture = buildFixture();
    const plan = createTransport(fixture);
    const target = page({ indexedDb: new IDBFactory(), transport: plan.transport });
    await seedCache(target, fixture);
    const player = await boot(target);

    const engine = player.engine();
    engine.setPlaylist(fixture.playlistId);
    engine.jump(1);
    await settle(target.win, target.clock, 40);
    const video: any = target.win.document.querySelector('video.sp-video');
    expect(video).toBeTruthy();
    video.oncanplay();
    await settle(target.win, target.clock, 20);
    const loadsBefore = target.media.load.length;
    const playsBefore = target.media.play.length;

    target.clock.advance(26000);
    await settle(target.win, target.clock, 60);

    // Recovery happened in place: same item, same element, media element reinitialized.
    expect(engine.index()).toBe(1);
    expect(target.win.document.querySelector('video.sp-video')).toBe(video);
    expect(target.media.load.length).toBeGreaterThan(loadsBefore);
    expect(target.media.play.length).toBeGreaterThan(playsBefore);
    expect(player.log().some((entry: any) => entry.event === 'stall_recovery')).toBe(true);
  });

  it('resumes the same playlist item (and video position) after a page reload', async () => {
    const fixture = buildFixture();
    const factory = new IDBFactory();
    const first = page({ indexedDb: factory, transport: createTransport(fixture).transport });
    const storage = await seedCache(first, fixture);
    // The television was rebooted while the second item was playing: the watchdog persisted where
    // it stopped, and the reload must resume there without any network request.
    await storage.setPlaybackState({
      manifestHash: fixture.manifest.manifestHash, playlistId: fixture.playlistId, index: 1,
      hash: fixture.videoHash, kind: 'video', positionMs: 15000, at: Date.now()
    });
    first.dom.window.close();

    const second = page({ indexedDb: factory, transport: deadNetwork });
    const secondPlayer = await boot(second);
    expect(secondPlayer.state.token).toBe('credential-1');
    expect(second.win.document.querySelector('#signage-pair-code')).toBeNull();
    expect(secondPlayer.engine().index()).toBe(1);
    expect(secondPlayer.engine().currentItem().hash).toBe(fixture.videoHash);
    const video: any = await mediaElement(second);
    expect(video.tagName.toLowerCase()).toBe('video');
    expect(video.getAttribute('src')).toContain('blob:');
  });
});

describe('synchronization resumes without interrupting playback', () => {
  it('resumes in the background when the network comes back and never restarts the current video', async () => {
    const fixture = buildFixture();
    let online = true;
    const plan = createTransport(fixture);
    const transport: Transport = (spec) => {
      if (!online) return Promise.reject(networkError());
      return plan.transport(spec);
    };
    const target = page({ indexedDb: new IDBFactory(), transport });
    await seedCache(target, fixture);
    const player = await boot(target);

    const engine = player.engine();
    engine.jump(1);
    await settle(target.win, target.clock, 40);
    const video: any = target.win.document.querySelector('video.sp-video');
    video.oncanplay();
    await settle(target.win, target.clock, 20);
    const source = video.getAttribute('src');

    online = false;
    target.clock.advance(61000);
    await settle(target.win, target.clock, 120);
    expect(player.state.online).toBe(false);
    expect(player.state.error).not.toBe('');

    online = true;
    target.win.dispatchEvent(new target.win.Event('online'));
    await settle(target.win, target.clock, 200);

    expect(player.state.error).toBe('');
    expect(player.state.online).toBe(true);
    // The video that was playing before the outage is still the same element with the same source.
    expect(target.win.document.querySelector('video.sp-video')).toBe(video);
    expect(video.getAttribute('src')).toBe(source);
    expect(video.muted).toBe(false);
    expect(overlay(target).style.display).toBe('none');
  });

  it('activates an updated playlist only after every required asset is cached, without a blank frame', async () => {
    const fixture = buildFixture();
    const factory = new IDBFactory();
    const seeded = page({ indexedDb: factory });
    await seedCache(seeded, fixture);
    seeded.dom.window.close();

    const next = buildFixture({ imageBytes: 'image-two-new-revision' });
    refreshManifestHash(next.manifest);
    const plan = createTransport(next);

    const target = page({ indexedDb: factory, transport: plan.transport });
    const player = await boot(target);
    const image: any = await mediaElement(target);
    image.onload();
    await settle(target.win, target.clock, 30);

    await settle(target.win, target.clock, 400);
    const check = await openStorage(target);
    expect((await check.getActiveManifest()).manifestHash).toBe(next.manifest.manifestHash);
    expect(await check.hasCompleteAsset(next.imageHash, next.imageBytes.length, 'image/png')).toBe(true);

    // The picture was never blanked: an element was on screen for the whole synchronization.
    expect(target.win.document.querySelector('img.sp-media, video.sp-video')).toBeTruthy();
    expect(player.state.playing).toBe(true);
  });
});

describe('production acceptance walkthrough', () => {
  it('plays cached content offline through several transitions, resumes sync, and activates a new playlist only when it is fully cached', async () => {
    const fixture = buildFixture();
    const published = buildFixture({ imageBytes: 'acceptance-image-two' });
    refreshManifestHash(published.manifest);
    const firstPlan = createTransport(fixture);
    const secondPlan = createTransport(published);
    let online = true;
    let publishPlan = firstPlan;
    const transport: Transport = (spec) => {
      if (!online) return Promise.reject(networkError());
      return publishPlan.transport(spec);
    };

    // 1-2. Open /player while online: the first synchronization caches the whole playlist.
    const factory = new IDBFactory();
    const first = page({ indexedDb: factory, transport });
    const firstPlayer = await boot(first);
    setPairCode(first, 'ABCD-1234');
    await settle(first.win, first.clock, 500);
    expect(firstPlayer.state.token).toBe('credential-1');
    const firstImage: any = first.win.document.querySelector('img.sp-media');
    expect(firstImage).toBeTruthy();
    firstImage.onload();
    await settle(first.win, first.clock, 40);
    expect(await firstPlayer.storage().countCachedAssets()).toBe(2);
    expect(await firstPlayer.storage().getActiveManifest()).toBeTruthy();
    first.dom.window.close();

    // 3-5. The TV reboots with the internet completely gone: the cached playlist must start
    // without a single successful request, and survive several playlist transitions.
    online = false;
    let successes = 0;
    const offlineOnly: Transport = (spec) => transport(spec).then(
      (value) => { successes += 1; return value; },
      (error) => { throw error; }
    );
    const second = page({ indexedDb: factory, transport: offlineOnly });
    const secondPlayer = await boot(second);
    const firstFrame: any = await mediaElement(second);
    expect(firstFrame.getAttribute('src')).toContain('blob:');
    expect(successes).toBe(0);

    const transitions: string[] = [];
    for (let step = 0; step < 6; step += 1) {
      const current: any = second.win.document.querySelector('img.sp-media, video.sp-video');
      expect(current, 'a media element must be prepared for every transition').toBeTruthy();
      transitions.push(current.tagName.toLowerCase());
      if (current.tagName.toLowerCase() === 'img') {
        current.onload();                 // the TV decoded the cached image
        expect(current.style.display).toBe('block');
        second.clock.advance(5200);       // and its dwell time elapsed
      } else {
        current.oncanplay();              // the cached video is decodable
        current.onended();                // and it reached the end of its timeline
      }
      await settle(second.win, second.clock, 40);
      expect(overlay(second).style.display).toBe('none');
    }
    expect(transitions.join(',')).toContain('img');
    expect(transitions.join(',')).toContain('video');

    // 6-7. Internet returns: synchronization resumes in the background, uninterrupted.
    online = true;
    second.win.dispatchEvent(new second.win.Event('online'));
    await settle(second.win, second.clock, 200);
    expect(secondPlayer.state.error).toBe('');

    // 8-12. A new playlist is published: it is downloaded in the background and activated only
    // after every required asset is cached and validated — the picture is never interrupted.
    publishPlan = secondPlan;
    const displayBeforePublish: any = second.win.document.querySelector('img.sp-media, video.sp-video');
    second.clock.advance(16000);
    secondPlayer.watchdog().requestSync('acceptance_publish');
    await waitFor(second.win, second.clock, () => secondPlayer.log().some((entry: any) => entry.event === 'sync_ok' && entry.data.candidate), 600);
    await waitFor(second.win, second.clock, () =>
      Array.from(second.win.document.querySelectorAll('img.sp-media, video.sp-video')).some((element: any) => element !== displayBeforePublish), 120);
    const prepared: any = Array.from(second.win.document.querySelectorAll('img.sp-media, video.sp-video'))
      .find((element: any) => element !== displayBeforePublish);
    expect(prepared).toBeTruthy();
    expect(displayBeforePublish.style.display).toBe('block');
    if (prepared.tagName.toLowerCase() === 'img') prepared.onload();
    else prepared.oncanplay();
    await settle(second.win, second.clock, 80);

    const check = await openStorage(second);
    expect((await check.getActiveManifest()).manifestHash).toBe(published.manifest.manifestHash);
    expect(await check.hasCompleteAsset(published.imageHash, published.imageBytes.length, 'image/png')).toBe(true);
    expect(await check.hasCompleteAsset(fixture.videoHash, fixture.videoBytes.length, 'video/mp4')).toBe(true);
    expect(second.win.document.querySelector('img.sp-media, video.sp-video')).toBeTruthy();
    expect(overlay(second).style.display).toBe('none');
    expect(secondPlayer.log().some((entry: any) => entry.event === 'reload')).toBe(false);
  });
});

describe('legacy television runtime', () => {
  it('plays cached media with IndexedDB and every modern API removed', async () => {
    const fixture = buildFixture();
    const factory = new IDBFactory();
    const seeded = page({ indexedDb: factory });
    await seedCache(seeded, fixture);
    seeded.dom.window.close();

    const target = page({ indexedDb: factory, transport: deadNetwork });
    stripModernApis(target.win);
    installBlobUrls(target.win);
    const player = await boot(target);

    const element: any = await mediaElement(target);
    expect(element.getAttribute('src')).toContain('blob:');
    expect(target.win.document.getElementById('signage-fatal')).toBeNull();
    expect(player.state.playing).toBe(true);
    // No unhandled rejection or fatal error was recorded while running offline.
    const events = player.log().map((entry: any) => entry.event);
    expect(events).not.toContain('unhandled_rejection');
    expect(events).not.toContain('fatal');
  });

  it('still plays from the Cache API backend when IndexedDB does not exist', async () => {
    const fixture = buildFixture();
    const target = page({ cacheApi: true, transport: deadNetwork });
    undefine(target.win, 'indexedDB');
    const storage = await openStorage(target);
    await storage.setCredential('credential-1');
    await saveAsset(storage, fixture.imageHash, fixture.imageBytes, 'image/png');
    await saveAsset(storage, fixture.videoHash, fixture.videoBytes, 'video/mp4');
    await storage.activateManifest(fixture.manifest);

    const player = await boot(target);
    expect(target.win.document.getElementById('signage-fatal')).toBeNull();
    expect(player.storage().backend).toBe('cache-api');
  });
});
