/*
 * Degraded activation: a screen that can play something beats a screen that shows nothing.
 *
 * The atomic rule is right and stays: while a complete playlist is on screen, a partial
 * synchronization must never replace it. But on the FIRST synchronization there is nothing to
 * fall back on, and the old behaviour was absolute — one file this television cannot decode (a
 * 13 MB MP4 on a 2016 LG, say) left the screen permanently dark with no content and no clear
 * signal about which file was at fault.
 *
 * These tests pin down exactly when the player may degrade and when it may not:
 *   - nothing on screen + one unusable asset  -> activate the rest, report it, cool down the file;
 *   - something on screen                    -> never replace it with a partial list;
 *   - nothing playable at all                -> fail loudly (there is nothing to show anyway);
 *   - a cooled-down asset is not re-downloaded on every single synchronization.
 */
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import {
  binaryResponse,
  buildFixture,
  createPage,
  createTransport,
  settle,
  type FakePage,
  type Transport,
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

async function runToCompletion<T>(page: FakePage, operation: Promise<T>, rounds = 4000): Promise<T> {
  let settled = false;
  let value: T | undefined;
  let failure: any = null;
  operation.then((result) => { settled = true; value = result; }, (error) => { settled = true; failure = error; });
  for (let round = 0; round < rounds && !settled; round += 1) await settle(page.win, page.clock, 1);
  if (!settled) throw new Error('the synchronization did not finish while the clock advanced');
  if (failure) throw failure;
  return value as T;
}

function syncOf(page: FakePage, storage: any, transport: Transport, options: any = {}) {
  return page.runtime.createSync({
    win: page.win,
    storage,
    http: page.runtime.createHttp(page.win, { Promise: page.win.Promise, transport }),
    token: 'credential-1',
    Promise: page.win.Promise,
    log: () => undefined,
    ...options,
  });
}

describe('degraded activation', () => {
  it('activates the playable assets on a first synchronization when one file cannot be prepared', async () => {
    const fixture = buildFixture();
    const plan = createTransport(fixture);
    const page = tv();
    const storage = await page.runtime.createStorage(page.win, { Promise: page.win.Promise, log: () => undefined });
    // This television cannot decode the video: the preflight refuses it, exactly like a 2016 LG
    // faced with a profile it does not support.
    const sync = syncOf(page, storage, plan.transport, {
      preflightAsset: (asset: any) => asset.hash !== fixture.videoHash,
    });

    const result: any = await runToCompletion(page, sync.run());
    await settle(page.win, page.clock);

    expect(result.skipped).toBe(1);
    const active = await storage.getActiveManifest();
    expect(active).toBeTruthy();
    expect(active.playlists[0].items.map((item: any) => item.hash)).toEqual([fixture.imageHash]);
    expect(active.assets.map((asset: any) => asset.hash)).toEqual([fixture.imageHash]);
    // Both files are still on disk; only the unusable one is kept out of the rotation.
    expect(await storage.countCachedAssets()).toBe(2);
  });

  it('brings the left-out file back as soon as this television can play it', async () => {
    const fixture = buildFixture();
    const plan = createTransport(fixture);
    const page = tv();
    const storage = await page.runtime.createStorage(page.win, { Promise: page.win.Promise, log: () => undefined });

    // The video cannot be prepared on the first synchronization...
    const first: any = await runToCompletion(page, syncOf(page, storage, plan.transport, {
      preflightAsset: (asset: any) => asset.hash !== fixture.videoHash,
    }).run());
    await settle(page.win, page.clock);
    expect(first.skipped).toBe(1);

    // ...and then it can (a new browser build, a re-encoded file, a different screen). No cooldown
    // stands in the way of the complete playlist coming back.
    const second: any = await runToCompletion(page, syncOf(page, storage, plan.transport, { preflightAsset: () => true }).run());
    await settle(page.win, page.clock);
    expect(second.skipped).toBe(0);
    const active = await storage.getActiveManifest();
    expect(active.playlists[0].items.map((item: any) => item.hash).sort())
      .toEqual([fixture.imageHash, fixture.videoHash].sort());
  });

  it('still fails loudly when a file cannot be fetched at all', async () => {
    const fixture = buildFixture();
    const plan = createTransport(fixture);
    const page = tv();
    const storage = await page.runtime.createStorage(page.win, { Promise: page.win.Promise, log: () => undefined });
    const failing: Transport = (spec) => {
      if (spec.url.indexOf(fixture.videoId) !== -1) return Promise.resolve(binaryResponse(500, new Uint8Array(0)));
      return plan.transport(spec);
    };
    // A file the television could not GET is not a file it cannot play: it is a network problem,
    // it may well be transient, and it must not quietly shrink the playlist. The old contract
    // stands — say so, keep retrying every cycle.
    await expect(runToCompletion(page, syncOf(page, storage, failing, { preflightAsset: () => true }).run()))
      .rejects.toMatchObject({ code: 'download_retries_exhausted' });
    expect(await storage.getActiveManifest()).toBeNull();
  });

  it('never replaces a playlist that is already on screen with a partial one', async () => {
    const fixture = buildFixture();
    const plan = createTransport(fixture);
    const page = tv();
    const storage = await page.runtime.createStorage(page.win, { Promise: page.win.Promise, log: () => undefined });

    // A healthy first synchronization: both assets are on screen.
    await runToCompletion(page, syncOf(page, storage, plan.transport, { preflightAsset: () => true }).run());
    await settle(page.win, page.clock);
    expect(await storage.countCachedAssets()).toBe(2);

    // A second playlist revision brings in a video this television cannot prepare.
    const revision = buildFixture({ videoBytes: 'mp4-two-bytes-revision-two' });
    expect(revision.videoHash).not.toBe(fixture.videoHash);
    const revisionPlan = createTransport(revision);
    const second = syncOf(page, storage, revisionPlan.transport, {
      preflightAsset: (asset: any) => asset.hash !== revision.videoHash,
    });
    // The atomic rule is what is really being tested here: the complete playlist that is already
    // playing must survive a synchronization that cannot finish, even though nothing about the
    // content on screen is broken.
    await expect(runToCompletion(page, second.run())).rejects.toMatchObject({ code: 'render_preflight_failed' });
    const active = await storage.getActiveManifest();
    expect(active.playlists[0].items.map((item: any) => item.hash).sort())
      .toEqual([fixture.imageHash, fixture.videoHash].sort());
  });

  it('fails loudly when nothing in the playlist can be played', async () => {
    const fixture = buildFixture();
    const plan = createTransport(fixture);
    const page = tv();
    const storage = await page.runtime.createStorage(page.win, { Promise: page.win.Promise, log: () => undefined });
    const sync = syncOf(page, storage, plan.transport, { preflightAsset: () => false });

    await expect(runToCompletion(page, sync.run())).rejects.toMatchObject({ code: 'render_preflight_failed' });
    expect(await storage.getActiveManifest()).toBeFalsy();
  });

  it('sits out its cooldown instead of re-fetching a file it had to leave out', async () => {
    const fixture = buildFixture();
    const plan = createTransport(fixture);
    const page = tv();
    const storage = await page.runtime.createStorage(page.win, { Promise: page.win.Promise, log: () => undefined });
    let videoRequests = 0;
    const counting: Transport = (spec) => {
      if (spec.url.indexOf(fixture.videoId) !== -1) videoRequests += 1;
      return plan.transport(spec);
    };

    // One engine, like the television runs: the cooldown lives as long as the page does.
    const sync = syncOf(page, storage, counting, { preflightAsset: (asset: any) => asset.hash !== fixture.videoHash });
    const first: any = await runToCompletion(page, sync.run());
    await settle(page.win, page.clock);
    expect(first.skipped).toBe(1);
    const requestsAfterFirst = videoRequests;
    expect(requestsAfterFirst).toBeGreaterThan(0);

    // The television then loses the file — a cleanup, an eviction, a wiped cache. Without a
    // cooldown the player would pull those bytes down again on the very next cycle, fail to
    // prepare them, and pull them again a minute after that, forever.
    await storage.clearAsset(fixture.videoHash);
    for (let round = 0; round < 3; round += 1) {
      const again: any = await runToCompletion(page, sync.run());
      await settle(page.win, page.clock);
      expect(again.skipped).toBe(1);
    }
    expect(videoRequests).toBe(requestsAfterFirst);
    // And the rest of the playlist is still playing while that file sits out its turn.
    const active = await storage.getActiveManifest();
    expect(active.playlists[0].items.map((item: any) => item.hash)).toEqual([fixture.imageHash]);
  });

});
