/*
 * Deploy adoption and player-version telemetry.
 *
 * The failure this file locks down: a television runs the build it loaded and has no service
 * worker, no module preload and no scheduled reload, so a deployment can be in production for
 * weeks while the screen keeps executing the old player. Every previous "fixed in production"
 * claim was unverifiable for exactly this reason — and unverifiable claims are how a broken screen
 * stays broken.
 *
 * Two things make it verifiable:
 *   1. Every heartbeat and every pairing carries the build the device is executing
 *      (`deviceInfo.playerVersion` / `deviceInfo.runtimeVersion`).
 *   2. The heartbeat answers with the build the deployment serves; when they differ the player
 *      adopts the new build with ONE controlled reload — never while a sync is downloading, and
 *      never twice for the same build.
 *
 * These tests drive the shipped files (public/player/*.js) in a jsdom television.
 */
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PLAYER_RUNTIME_VERSION, PLAYER_VERSION } from '@/lib/player/standalone/shell';
import {
  PLAYER_DIR,
  buildFixture,
  createPage,
  createTransport,
  settle,
  waitFor,
  type FakePage,
} from './player-harness';

const pages: FakePage[] = [];

afterEach(() => {
  while (pages.length) {
    const page = pages.pop();
    try { page?.win.close(); } catch { /* jsdom teardown is best effort */ }
  }
});

function tv(options: { transport?: any } = {}): FakePage {
  const page = createPage({ indexedDb: new IDBFactory(), transport: options.transport || null });
  pages.push(page);
  return page;
}

async function runToCompletion<T>(page: FakePage, operation: Promise<T>, rounds = 3000): Promise<T> {
  let settled = false;
  let value: T | undefined;
  let failure: any = null;
  operation.then((result) => { settled = true; value = result; }, (error) => { settled = true; failure = error; });
  for (let round = 0; round < rounds && !settled; round += 1) await settle(page.win, page.clock, 1);
  if (!settled) throw new Error('the player did not finish booting while the clock advanced');
  if (failure) throw failure;
  return value as T;
}

async function bootTv(page: FakePage) {
  const player = page.ui.create({ win: page.win, runtime: page.runtime });
  await runToCompletion(page, player.start());
  await settle(page.win, page.clock, 60);
  return player;
}

/** A paired television with content already on disk, exactly like a screen that has synced before. */
async function pairTv(page: FakePage, fixture: any) {
  const storage = await page.runtime.createStorage(page.win, { Promise: page.win.Promise, log: () => undefined });
  await storage.setCredential('credential-1');
  for (const file of [{ hash: fixture.imageHash, bytes: fixture.imageBytes, mime: 'image/png' },
    { hash: fixture.videoHash, bytes: fixture.videoBytes, mime: 'video/mp4' }]) {
    await storage.saveChunk(file.hash, 0, file.bytes, { expectedSize: file.bytes.length, mimeType: file.mime, chunkSize: file.bytes.length });
    await storage.finalizeAsset(file.hash, file.bytes.length, file.mime, 1, file.bytes.length);
  }
  await storage.activateManifest(fixture.manifest);
  return storage;
}

function heartbeatCalls(page: FakePage, plan: { calls: Array<{ url: string; body: string | null }> }) {
  return plan.calls
    .filter((call) => call.url === '/api/player/heartbeat')
    .map((call) => (call.body ? JSON.parse(call.body) : null))
    .filter(Boolean);
}

function reloads(player: any, event: string) {
  return player.log().filter((entry: any) => entry.event === event);
}

describe('player version telemetry', () => {
  it('the shipped player.js declares the same build as the HTML shell cache-buster', () => {
    const source = readFileSync(path.join(PLAYER_DIR, 'player.js'), 'utf8');
    const match = /var\s+PLAYER_VERSION\s*=\s*'([^']+)'/.exec(source);
    expect(match, 'player.js must declare PLAYER_VERSION').toBeTruthy();
    // The shell appends ?v=<PLAYER_VERSION> to every asset, so the two must never drift: a
    // mismatch means the television would load new files while reporting the old build.
    expect(match![1]).toBe(PLAYER_VERSION);
  });

  it('the shipped runtime.js declares the build the server advertises', () => {
    const source = readFileSync(path.join(PLAYER_DIR, 'runtime.js'), 'utf8');
    const match = /var\s+VERSION\s*=\s*'([^']+)'/.exec(source);
    expect(match, 'runtime.js must declare VERSION').toBeTruthy();
    expect(match![1]).toBe(PLAYER_RUNTIME_VERSION);
  });

  it('deviceInfo carries the runtime build and merges the UI build', () => {
    const page = tv();
    const info = page.runtime.deviceInfo(page.win);
    expect(info.runtimeVersion).toBe(PLAYER_RUNTIME_VERSION);
    expect(info.playerVersion).toBeUndefined();
    const merged = page.runtime.deviceInfo(page.win, { playerVersion: PLAYER_VERSION });
    expect(merged.playerVersion).toBe(PLAYER_VERSION);
    expect(merged.runtimeVersion).toBe(PLAYER_RUNTIME_VERSION);
  });

  it('every heartbeat reports the build the television is executing', async () => {
    const fixture = buildFixture();
    const plan = createTransport(fixture);
    const page = tv({ transport: plan.transport });
    await pairTv(page, fixture);
    await bootTv(page);
    await waitFor(page.win, page.clock, () => heartbeatCalls(page, plan).length > 0, 200);
    await settle(page.win, page.clock, 60);

    const beats = heartbeatCalls(page, plan);
    expect(beats.length).toBeGreaterThan(0);
    for (const beat of beats) {
      expect(beat.deviceInfo.playerVersion).toBe(PLAYER_VERSION);
      expect(beat.deviceInfo.runtimeVersion).toBe(PLAYER_RUNTIME_VERSION);
    }
  });

  it('every heartbeat also says which storage the television got and what it is doing', async () => {
    // "cachedMediaCount: 0" on a real screen was unreadable: it can mean nothing was downloaded,
    // nothing was stored, or the player never ran a synchronization at all. These two fields tell
    // those apart from the device itself, which is the only place the answer exists.
    const fixture = buildFixture();
    const plan = createTransport(fixture);
    const page = tv({ transport: plan.transport });
    await pairTv(page, fixture);
    await bootTv(page);
    await waitFor(page.win, page.clock, () => heartbeatCalls(page, plan).length > 0, 200);
    await settle(page.win, page.clock, 60);

    const beats = heartbeatCalls(page, plan);
    expect(beats.length).toBeGreaterThan(0);
    for (const beat of beats) {
      expect(typeof beat.deviceInfo.storageBackend).toBe('string');
      expect(beat.deviceInfo.storageBackend.length).toBeGreaterThan(0);
      expect(typeof beat.deviceInfo.phase).toBe('string');
      expect(beat.deviceInfo.phase.length).toBeGreaterThan(0);
    }
  });
});

describe('deploy adoption', () => {
  it('does nothing while the deployment serves the build that is running', async () => {
    const fixture = buildFixture();
    const plan = createTransport(fixture);
    const page = tv({ transport: plan.transport });
    await pairTv(page, fixture);
    const player = await bootTv(page);
    await waitFor(page.win, page.clock, () => heartbeatCalls(page, plan).length > 0, 200);
    await settle(page.win, page.clock, 80);

    expect(reloads(player, 'deploy_adoption_reload').length).toBe(0);
    expect(reloads(player, 'deploy_adoption_deferred').length).toBe(0);
  });

  it('adopts a newly deployed build exactly once', async () => {
    const fixture = buildFixture();
    const plan = createTransport(fixture, { servedPlayerVersion: '9.9.9-stale-build' });
    const page = tv({ transport: plan.transport });
    await pairTv(page, fixture);
    const player = await bootTv(page);
    await waitFor(page.win, page.clock, () => heartbeatCalls(page, plan).length > 0, 200);
    await settle(page.win, page.clock, 80);
    // The first beats land while the boot synchronization is still downloading: adoption waits
    // instead of interrupting it, and a later beat adopts the build.
    expect(reloads(player, 'deploy_adoption_deferred').length).toBeGreaterThan(0);
    expect(reloads(player, 'deploy_adoption_reload').length).toBe(0);
    for (let round = 0; round < 12 && reloads(player, 'deploy_adoption_reload').length === 0; round += 1) {
      page.clock.advance(30000);
      await settle(page.win, page.clock, 60);
    }

    expect(reloads(player, 'deploy_adoption_reload').length).toBe(1);
    expect(reloads(player, 'deploy_adoption_reload')[0].data).toMatchObject({
      served: '9.9.9-stale-build',
      local: PLAYER_VERSION,
    });

    // Many more heartbeats: the same build must never be adopted twice, so a television that
    // cannot fetch the new files cannot end up in a reload loop.
    for (let round = 0; round < 6; round += 1) { page.clock.advance(31000); await settle(page.win, page.clock, 60); }
    expect(reloads(player, 'deploy_adoption_reload').length).toBe(1);
    expect(reloads(player, 'deploy_adoption_skipped').length).toBeGreaterThan(0);
  });

  it('never adopts a build it is already running, even when the server repeats it', async () => {
    const fixture = buildFixture();
    const plan = createTransport(fixture, { servedPlayerVersion: PLAYER_VERSION });
    const page = tv({ transport: plan.transport });
    await pairTv(page, fixture);
    const player = await bootTv(page);
    for (let round = 0; round < 6; round += 1) { page.clock.advance(31000); await settle(page.win, page.clock, 60); }
    expect(heartbeatCalls(page, plan).length).toBeGreaterThan(1);
    expect(reloads(player, 'deploy_adoption_reload').length).toBe(0);
    expect(reloads(player, 'deploy_adoption_skipped').length).toBe(0);
  });
});
