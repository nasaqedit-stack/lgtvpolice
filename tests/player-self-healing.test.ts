/*
 * 24/7 self-healing player — the named acceptance tests.
 *
 * Everything here drives the code that actually ships (`public/player/watchdog.js`,
 * `public/player/player.js`, `lib/server/screen-health.ts`) instead of a copy of it. The watchdog is
 * exercised directly with a fake window and a controllable clock so that hours of television time
 * can be simulated in milliseconds, while the command/ACK behaviour is exercised through the real
 * player in a jsdom TV.
 *
 * These tests encode the invariants that keep a screen alive without anybody touching the remote:
 *   - one heartbeat loop, one synchronization loop, one watchdog;
 *   - connectivity is proven only by a real authenticated round trip;
 *   - a command version is executed at most once, ever;
 *   - a reload is the last resort and can never loop;
 *   - no secret ever leaves the browser in a payload, a log or a URL.
 */
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPage, createTransport, settle, waitFor, type FakePage } from './player-harness';
import { PLAYER_DIR } from './player-harness';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  deriveScreenHealth,
  HEALTH_WINDOWS,
  isScreenOnline,
  resetScreenHealthColumnCache,
} from '@/lib/server/screen-health';

/* ---------------------------------------------------------------------------------------------- */
/* Watchdog under a controllable clock                                                             */
/* ---------------------------------------------------------------------------------------------- */

type FakeWin = { win: any; clock: { now: () => number; advance: (ms: number) => void; jump: (ms: number) => void } };

/**
 * A window that owns a virtual clock. `advance()` fires the timers it passes on the way;
 * `jump()` moves the clock WITHOUT firing them, which is exactly what a TV standby does to a
 * suspended page.
 */
function createFakeWin(): FakeWin {
  let now = 1_800_000_000_000;
  const timers = new Map<number, { id: number; fn: () => void; interval: number | null; at: number }>();
  let sequence = 1;

  type Entry = { id: number; fn: () => void; interval: number | null; at: number };
  function fireDue(target: number) {
    for (let guard = 0; guard < 200000; guard += 1) {
      let next: Entry | undefined;
      timers.forEach((timer) => {
        if (timer.at <= target && (next === undefined || timer.at < next.at)) next = timer;
      });
      if (next === undefined) return;
      const due: Entry = next;
      // A standby moves the clock without firing anything, so a timer that came due during the
      // suspension runs at the CURRENT time, exactly like a real television waking up.
      now = due.at < now ? now : due.at;
      if (due.interval === null) timers.delete(due.id);
      else due.at = now + due.interval;
      due.fn();
    }
    throw new Error('the virtual clock never caught up with the timer queue');
  }

  const win = {
    setInterval(fn: () => void, ms: number) {
      const id = sequence;
      sequence += 1;
      timers.set(id, { id, fn, interval: Number(ms) || 0, at: now + (Number(ms) || 0) });
      return id;
    },
    clearInterval(id: number) { timers.delete(id); },
    setTimeout(fn: () => void, ms: number) {
      const id = sequence;
      sequence += 1;
      timers.set(id, { id, fn, interval: null, at: now + (Number(ms) || 0) });
      return id;
    },
    clearTimeout(id: number) { timers.delete(id); },
    __timerCount: () => timers.size,
  };

  return {
    win,
    clock: {
      now: () => now,
      advance(ms: number) { fireDue(now + ms); now += ms; },
      jump(ms: number) { now += ms; },
    },
  };
}

const WATCHDOG_SOURCE = readFileSync(path.join(PLAYER_DIR, 'watchdog.js'), 'utf8');

function loadWatchdog() {
  const moduleShim = { exports: {} as any };
  const loader = new Function('module', `${WATCHDOG_SOURCE}\nreturn module.exports;`);
  return loader(moduleShim) as { create: (options: any) => any; STATES: any; DEFAULTS: any };
}

type WatchdogHarness = {
  wd: any;
  clock: FakeWin['clock'];
  win: any;
  calls: { beat: string[]; sync: string[]; resetBeat: string[]; resetSync: string[]; abortStale: string[]; reinit: string[]; reload: string[]; resume: string[]; health: string[] };
  events: Array<{ event: string; data: any }>;
  states: string[];
  setRuntimeHealthy: (healthy: boolean, hasLocal?: boolean, playable?: boolean) => void;
  /** 'up' = the server answers; 'down' = every request fails; 'hang' = nothing ever settles. */
  setNetwork: (state: 'up' | 'down' | 'hang') => void;
};

function buildWatchdog(timing: Record<string, number> = {}): WatchdogHarness {
  const fake = createFakeWin();
  const calls = { beat: [], sync: [], resetBeat: [], resetSync: [], abortStale: [], reinit: [], reload: [], resume: [], health: [] } as any;
  const events: Array<{ event: string; data: any }> = [];
  const states: string[] = [];
  let runtime = { healthy: true, hasLocal: true, playable: true };
  type Outcome = 'ok' | 'fail' | 'hang';
  const hooks: { beat: Outcome; sync: Outcome } = { beat: 'ok', sync: 'ok' };
  let wd: any = null;

  wd = loadWatchdog().create({
    win: fake.win,
    timing,
    log: (event: string, data: any) => { events.push({ event, data: data || null }); },
    actions: {
      beat: (reason: string) => {
        calls.beat.push(String(reason));
        // 'ok'   -> the server answers, which is the only evidence the watchdog accepts;
        // 'fail' -> the request is rejected straight away, exactly like an unplugged television;
        // 'hang' -> the request never settles, which is what a frozen socket looks like.
        if (hooks.beat === 'ok') wd.markHeartbeat();
        else if (hooks.beat === 'fail') wd.noteBeatFailure('network_offline');
      },
      sync: (reason: string) => {
        calls.sync.push(String(reason));
        // A synchronization is left to the test to resolve: unlike the beat it is a long request and
        // every test here drives its outcome explicitly.
        if (hooks.sync === 'fail') wd.noteSyncFailure('network_offline');
      },
      resetBeat: (reason: string) => { calls.resetBeat.push(String(reason)); },
      resetSync: (reason: string) => { calls.resetSync.push(String(reason)); },
      abortStale: (reason: string) => { calls.abortStale.push(String(reason)); },
      onResume: (reason: string) => { calls.resume.push(String(reason)); },
      reinitRuntime: (reason: string) => { calls.reinit.push(String(reason)); },
      reload: (reason: string) => { calls.reload.push(String(reason)); return true; },
      healthCheck: (when: string) => { calls.health.push(String(when)); return 'ok'; },
      runtimeStatus: () => runtime,
      onState: (next: string) => { states.push(String(next)); },
    },
  });

  return {
    wd: wd as any,
    clock: fake.clock,
    win: fake.win,
    calls,
    events,
    states,
    setRuntimeHealthy: (healthy, hasLocal = true, playable = true) => { runtime = { healthy, hasLocal, playable }; },
    setNetwork: (state: 'up' | 'down' | 'hang') => {
      hooks.beat = state === 'up' ? 'ok' : (state === 'hang' ? 'hang' : 'fail');
      hooks.sync = state === 'up' ? 'ok' : (state === 'hang' ? 'hang' : 'fail');
    },
  };
}

function eventNames(harness: WatchdogHarness): string[] {
  return harness.events.map((entry) => entry.event);
}

afterEach(() => {
  // Only the watchdog unit tests stub the clock; the jsdom pages drive their own.
  vi.restoreAllMocks();
});

/** Binds `Date.now()` to one harness clock so the watchdog never sees real time. */
function bindClock(harness: WatchdogHarness) {
  vi.spyOn(Date, 'now').mockImplementation(() => harness.clock.now());
}

/* ---------------------------------------------------------------------------------------------- */
/* jsdom television helpers                                                                        */
/* ---------------------------------------------------------------------------------------------- */

const openPages: FakePage[] = [];
afterEach(() => {
  while (openPages.length) {
    const page = openPages.pop();
    try { page?.dom.window.close(); } catch { /* jsdom teardown is best effort */ }
  }
});

function tv(options: Parameters<typeof createPage>[0] = {}): FakePage {
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

async function bootTv(target: FakePage, options: any = {}): Promise<any> {
  const player = target.ui.create({ win: target.win, runtime: target.runtime, ...options });
  await runToCompletion(target, player.start());
  await settle(target.win, target.clock);
  return player;
}

async function seedCache(target: FakePage, fixture: any, token = 'credential-1'): Promise<any> {
  const storage = await target.runtime.createStorage(target.win, { Promise: target.win.Promise, log: () => undefined });
  if (token) await storage.setCredential(token);
  for (const file of [{ hash: fixture.imageHash, bytes: fixture.imageBytes, mime: 'image/png' },
    { hash: fixture.videoHash, bytes: fixture.videoBytes, mime: 'video/mp4' }]) {
    await storage.saveChunk(file.hash, 0, file.bytes, { expectedSize: file.bytes.length, mimeType: file.mime, chunkSize: file.bytes.length });
    await storage.finalizeAsset(file.hash, file.bytes.length, file.mime, 1, file.bytes.length);
  }
  await storage.activateManifest(fixture.manifest);
  return storage;
}

function heartbeatBodies(target: FakePage, calls: Array<{ url: string; body: string | null; method: string }>): any[] {
  return calls
    .filter((call) => call.url === '/api/player/heartbeat' && call.method === 'POST' && call.body)
    .map((call) => JSON.parse(call.body as string));
}

/* ============================================================================================== */

describe('24/7 self-healing player — named acceptance tests', () => {

  it('1. heartbeat continues after a network outage with no manual interaction', () => {
    const h = buildWatchdog();
    bindClock(h);
    h.wd.setHasCredential(true);
    h.wd.start();
    expect(h.calls.beat.length).toBe(1);

    // Thirty minutes of a dead network: every beat fails, the backoff grows, the loop still re-arms
    // itself and the television is never reloaded. Nobody touches the remote.
    h.setNetwork('down');
    for (let round = 0; round < 6; round += 1) h.clock.advance(300000);

    expect(h.calls.beat.length).toBeGreaterThanOrEqual(5);
    expect(h.wd.snapshot().state).toBe('offline');
    expect(h.calls.reload.length).toBe(0);
    // The backoff never exceeds the cap, so the television keeps probing instead of giving up.
    expect(h.wd.lastBackoff()).toBeLessThanOrEqual(h.wd.config().maxBackoffMs);
  });

  it('2. a request that never settles cannot stop the heartbeat loop', () => {
    const h = buildWatchdog();
    bindClock(h);
    h.setNetwork('hang');
    h.wd.setHasCredential(true);
    h.wd.start();
    expect(h.calls.beat.length).toBe(1);

    // The transport never resolves (a hung socket on a suspended TV). The in-flight guard times the
    // beat out, releases the player's lock and re-arms the loop instead of waiting forever.
    h.clock.advance(60000);
    expect(h.calls.resetBeat.length).toBeGreaterThanOrEqual(1);
    expect(eventNames(h)).toContain('watchdog_beat_timeout');
    expect(h.calls.beat.length).toBeGreaterThanOrEqual(2);
    expect(h.wd.snapshot().state).not.toBe('online');
  });

  it('3. a stale connection is derived from the last successful round trip, never from navigator.onLine', () => {
    const h = buildWatchdog();
    bindClock(h);
    // The fake window has no `navigator` at all: if the watchdog ever consulted it the test would
    // throw instead of silently passing.
    expect(h.win.navigator).toBeUndefined();
    h.setNetwork('hang');
    h.wd.setHasCredential(true);
    h.wd.start();
    h.wd.markHeartbeat();
    expect(h.wd.state()).toBe('online');

    // 95 s without a successful round trip is past the stale window (90 s) but far from offline.
    h.clock.advance(95000);
    expect(h.wd.snapshot().state).toBe('degraded');
    expect(h.states).toContain('degraded');
  });

  it('4. a suspended page (wall-clock jump) recovers without a reload', () => {
    const h = buildWatchdog();
    bindClock(h);
    h.wd.setHasCredential(true);
    h.wd.start();
    h.wd.markHeartbeat();

    // The television was in standby for ten minutes: the clock jumps, no timer fired in between.
    h.clock.jump(600000);
    h.clock.advance(1);
    expect(h.wd.snapshot().suspendGaps).toBe(1);
    expect(eventNames(h)).toContain('watchdog_clock_gap');
    expect(h.calls.abortStale).toEqual(['clock_gap']);
    expect(h.calls.resume).toEqual(['clock_gap']);
    // Recovery is immediate on the very same tick, not one backoff window later.
    expect(h.calls.beat.length).toBeGreaterThanOrEqual(2);
    expect(h.calls.reload.length).toBe(0);
  });

  it('5. an event-loop freeze that skips ticks is recorded and does not escalate', () => {
    const h = buildWatchdog();
    bindClock(h);
    h.wd.setHasCredential(true);
    h.wd.start();
    h.wd.markHeartbeat();

    // 60 s between two ticks is a stall severe enough to notice, but below the standby threshold.
    h.clock.jump(60000);
    h.clock.advance(1);
    expect(h.wd.snapshot().frozenGaps).toBe(1);
    expect(eventNames(h)).toContain('watchdog_event_loop_stall');
    expect(h.wd.snapshot().suspendGaps).toBe(0);
    expect(h.calls.reload.length).toBe(0);
  });

  it('6. failed beats back off exponentially with jitter and never produce a storm', () => {
    const h = buildWatchdog();
    bindClock(h);
    // Jitter is deterministic at exactly the middle of the band with random() === 0.5.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    h.wd.setHasCredential(true);
    h.wd.start();

    const ladder: number[] = [];
    for (let round = 0; round < 8; round += 1) {
      h.wd.noteBeatFailure('http_error');
      ladder.push(h.wd.lastBackoff());
    }
    expect(ladder).toEqual([15000, 30000, 60000, 120000, 240000, 480000, 900000, 900000]);

    // The same ladder with the worst-case random values still stays inside the jitter band, and the
    // spacing between two television beats can therefore never collapse into a request storm.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    h.wd.noteBeatFailure('http_error');
    const low = h.wd.lastBackoff();
    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    h.wd.noteBeatFailure('http_error');
    const high = h.wd.lastBackoff();
    expect(low).toBeGreaterThanOrEqual(900000 * 0.75 - 1);
    expect(high).toBeLessThanOrEqual(900000 * 1.25 + 1);
    expect(low).toBeLessThan(high);
  });

  it('7. connectivity returning triggers an immediate beat and sync, then ONLINE', () => {
    const h = buildWatchdog();
    bindClock(h);
    h.setNetwork('down');
    h.wd.setHasCredential(true);
    h.wd.start();
    h.clock.advance(95000);
    // Any pessimistic pre-recovery state is fine; none of them may claim ONLINE.
    expect(['degraded', 'reconnecting', 'recovering', 'offline']).toContain(h.wd.snapshot().state);

    h.setNetwork('up');
    const beatsBefore = h.calls.beat.length;
    const syncsBefore = h.calls.sync.length;
    h.wd.requestRecovery('browser_online');
    // No waiting: the recovery attempt is dispatched inside the request, not at the next tick.
    expect(h.calls.beat.length).toBe(beatsBefore + 1);
    expect(h.calls.sync.length).toBe(syncsBefore + 1);
    // RECONNECTING -> SYNC -> ONLINE: a confirmed beat alone is not allowed to claim ONLINE again.
    expect(h.wd.snapshot().state).toBe('sync');
    h.wd.markSync(true);
    expect(h.wd.snapshot().state).toBe('online');
  });

  it('8. only one interval timer exists: starting a second watchdog tears the first down', () => {
    const fake = createFakeWin();
    vi.spyOn(Date, 'now').mockImplementation(() => fake.clock.now());
    const factory = loadWatchdog();
    const first = factory.create({ win: fake.win, actions: {} });
    first.start();
    expect(first.isRunning()).toBe(true);
    expect(fake.win.__timerCount()).toBe(1);

    // The player is rebuilt in place (a recovered script, a runtime reinitialize): the previous
    // watchdog is torn down first, so the page can only ever own ONE heartbeat loop.
    const second = factory.create({ win: fake.win, actions: {} });
    expect(first.isRunning()).toBe(false);
    second.start();
    expect(second.isRunning()).toBe(true);
    expect(fake.win.__timerCount()).toBe(1);

    second.destroy();
    expect(fake.win.__timerCount()).toBe(0);
  });

  it('9. a reload command is executed exactly once across reconnects', async () => {
    const { buildFixture } = await import('./player-harness');
    const fixture = buildFixture();
    fixture.manifest.commands = { syncVersion: 1, reloadVersion: 1 };
    const plan = createTransport(fixture);
    const target = tv({ indexedDb: new IDBFactory(), transport: plan.transport });
    await seedCache(target, fixture);
    const player = await bootTv(target);

    await waitFor(target.win, target.clock, () => player.log().some((entry: any) => entry.event === 'reload_command_received'), 600);
    expect(target.win.document.querySelector('img.sp-media, video.sp-video')).toBeTruthy();

    // Four more synchronizations, plus a full outage and recovery: the command must not run again.
    for (let round = 0; round < 4; round += 1) target.clock.advance(61000);
    await settle(target.win, target.clock, 400);
    expect(player.log().filter((entry: any) => entry.event === 'reload_command_received').length).toBe(1);
    expect(player.log().filter((entry: any) => entry.event === 'reload_command_softened').length).toBe(1);
    expect(player.watchdog().snapshot().lastAppliedCommandVersion).toBe(1);
  });

  it('10. an obsolete command is skipped instead of being queued behind a newer one', async () => {
    const { buildFixture } = await import('./player-harness');
    const fixture = buildFixture();
    fixture.manifest.manifestHash = 'a'.repeat(64);
    fixture.manifest.commands = { syncVersion: 1, reloadVersion: 5 };
    const plan = createTransport(fixture);
    const target = tv({ indexedDb: new IDBFactory(), transport: plan.transport });
    await seedCache(target, fixture);
    const player = await bootTv(target);

    await waitFor(target.win, target.clock, () => player.log().some((entry: any) => entry.event === 'reload_command_received'), 600);
    expect(player.watchdog().snapshot().lastAppliedCommandVersion).toBe(5);

    // The server rewinds to an older version (a restored backup, a replayed queue entry).
    fixture.manifest.commands.reloadVersion = 3;
    fixture.manifest.manifestHash = 'b'.repeat(64);
    for (let round = 0; round < 3; round += 1) target.clock.advance(61000);
    await settle(target.win, target.clock, 400);

    expect(player.log().filter((entry: any) => entry.event === 'reload_command_received').length).toBe(1);
    expect(player.watchdog().snapshot().lastAppliedCommandVersion).toBe(5);
    // A newer version still wins: the player always converges on the latest authoritative state.
    fixture.manifest.commands.reloadVersion = 6;
    fixture.manifest.manifestHash = 'c'.repeat(64);
    for (let round = 0; round < 3; round += 1) target.clock.advance(61000);
    await settle(target.win, target.clock, 400);
    expect(player.log().filter((entry: any) => entry.event === 'reload_command_received').length).toBe(2);
  });

  it('11. the command version is acknowledged before it runs and is reported in the heartbeat', async () => {
    const { buildFixture } = await import('./player-harness');
    const fixture = buildFixture();
    fixture.manifest.commands = { syncVersion: 1, reloadVersion: 2 };
    const plan = createTransport(fixture);
    const target = tv({ indexedDb: new IDBFactory(), transport: plan.transport });
    const storage = await seedCache(target, fixture);
    const player = await bootTv(target);

    await waitFor(target.win, target.clock, () => player.log().some((entry: any) => entry.event === 'reload_command_received'), 600);
    // The acknowledgement is durable before the command executes, so a reload mid-execution cannot
    // replay it.
    expect(await storage.getSeenReloadVersion()).toBe(2);

    target.clock.advance(31000);
    await settle(target.win, target.clock, 300);
    const bodies = heartbeatBodies(target, plan.calls);
    expect(bodies.some((body: any) => body.appliedReloadVersion === 2)).toBe(true);
  });

  it('12. the server command-ACK echo stops a command re-running after local storage is lost', async () => {
    const { buildFixture } = await import('./player-harness');
    const fixture = buildFixture();
    // The server already saw this screen acknowledge version 4, but the television lost its store.
    fixture.manifest.commands = {
      syncVersion: 4,
      reloadVersion: 4,
      applied: { syncVersion: 4, reloadVersion: 4 },
    };
    const plan = createTransport(fixture);
    const target = tv({ indexedDb: new IDBFactory(), transport: plan.transport });
    await seedCache(target, fixture);
    const player = await bootTv(target);

    await waitFor(target.win, target.clock, () => plan.count('/api/player/manifest') >= 1, 600);
    await settle(target.win, target.clock, 400);

    expect(player.log().some((entry: any) => entry.event === 'command_adopted_server_ack')).toBe(true);
    expect(player.log().filter((entry: any) => entry.event === 'reload_command_received').length).toBe(0);
    expect(player.watchdog().snapshot().lastAppliedCommandVersion).toBe(4);
  });

  it('13. runtime reinitialization is rate limited and never touches a healthy screen', () => {
    const h = buildWatchdog();
    bindClock(h);
    h.wd.setHasCredential(true);
    h.wd.start();
    h.wd.markHeartbeat();

    // An hour of perfect health: the runtime is never rebuilt and nothing is reloaded.
    h.clock.advance(3600000);
    expect(h.calls.reinit.length).toBe(0);
    expect(h.calls.reload.length).toBe(0);

    // Now the stage goes empty while local media exists: local recovery runs first, and it is rate
    // limited so an empty stage can never become a reinitialization loop.
    h.setRuntimeHealthy(false, true, true);
    h.clock.advance(3600000);
    expect(h.calls.reinit.length).toBeGreaterThan(0);
    expect(h.calls.reinit.length).toBeLessThanOrEqual(20);
    // Reloading stays bounded by the cooldown even when the runtime never repairs itself.
    expect(h.calls.reload.length).toBeLessThanOrEqual(2);
    expect(eventNames(h)).toContain('watchdog_reload_budget_exhausted');
  });

  it('14. a controlled reload is armed only after repeated local recovery failures', () => {
    const h = buildWatchdog();
    bindClock(h);
    h.wd.setHasCredential(true);
    h.wd.start();
    h.wd.markHeartbeat();
    h.setRuntimeHealthy(false, true, true);

    // Eleven runtime checks are not enough: the local playlist is re-armed first.
    h.clock.advance(170000);
    expect(eventNames(h)).not.toContain('watchdog_reload_armed');
    expect(h.calls.reload.length).toBe(0);

    // The twelfth check exhausts three local recovery attempts and only then arms a reload.
    h.clock.advance(20000);
    expect(eventNames(h)).toContain('watchdog_reload_armed');
    h.clock.advance(6000);
    expect(h.calls.reload.length).toBe(1);
    expect(h.calls.reload[0]).toBe('watchdog_runtime_unrecoverable');
    expect(h.wd.snapshot().state).toBe('controlled_reload');
  });

  it('15. reloads are bounded: never more than two inside one window', () => {
    const h = buildWatchdog();
    bindClock(h);
    h.wd.setHasCredential(true);
    h.wd.start();
    h.wd.markHeartbeat();
    h.setRuntimeHealthy(false, true, true);

    expect(h.wd.controlledReload('first')).toBe(true);
    h.clock.advance(6000);
    expect(h.wd.controlledReload('second')).toBe(true);
    h.clock.advance(6000);
    expect(h.wd.controlledReload('third')).toBe(false);
    expect(eventNames(h)).toContain('watchdog_reload_suppressed');
    expect(h.calls.reload.length).toBe(2);

    // The ten-minute window rolls over, but the hard cooldown still holds: a permanently broken
    // television shows its last cached frame instead of reloading twice per window forever.
    h.clock.advance(610000);
    expect(h.wd.reloadAllowed()).toBe(false);
    expect(eventNames(h)).toContain('watchdog_reload_budget_exhausted');
    h.clock.advance(3000000);
    expect(h.wd.reloadAllowed()).toBe(true);
  });

  it('16. recovery metadata survives a page reload through persistent storage', async () => {
    const { buildFixture } = await import('./player-harness');
    const fixture = buildFixture();
    const factory = new IDBFactory();
    const first = tv({ indexedDb: factory, transport: createTransport(fixture).transport });
    const firstStorage = await first.runtime.createStorage(first.win, { Promise: first.win.Promise, log: () => undefined });
    await firstStorage.setRecoveryMeta({ count: 3, lastAt: Date.now(), reason: 'empty_stage', state: 'recovering', reloads: 1, reinits: 2 });
    await firstStorage.setCommandState({ appliedSyncVersion: 7, appliedReloadVersion: 2 });
    first.dom.window.close();

    // The television reboots: same persistent store, brand new page.
    const second = tv({ indexedDb: factory, transport: createTransport(fixture).transport });
    const secondStorage = await second.runtime.createStorage(second.win, { Promise: second.win.Promise, log: () => undefined });
    const meta = await secondStorage.getRecoveryMeta();
    expect(meta).toBeTruthy();
    expect(meta.count).toBe(3);
    expect(meta.reason).toBe('empty_stage');
    expect(await secondStorage.getCommandState()).toEqual({ appliedSyncVersion: 7, appliedReloadVersion: 2 });
    // Nothing sensitive is persisted: the store holds counters, never a credential or a token.
    expect(JSON.stringify(meta)).not.toMatch(/credential|token|bearer/i);
  });

  it('17. the daily health check runs once at startup and then once per day', () => {
    const h = buildWatchdog();
    bindClock(h);
    h.wd.setHasCredential(true);
    h.wd.start();
    h.clock.advance(290000);
    expect(h.calls.health.length).toBe(0);

    h.clock.advance(20000);
    expect(h.calls.health).toEqual(['startup']);

    h.wd.setHealthStatus('ok');
    h.clock.advance(86300000);
    expect(h.calls.health.length).toBe(1);
    h.clock.advance(200000);
    expect(h.calls.health).toEqual(['startup', 'daily']);
    h.wd.setHealthStatus('ok');

    // Five more days: one check per day, never one per tick (720 ticks a day would be 3600 calls).
    h.clock.advance(5 * 86400000);
    expect(h.calls.health.length).toBeGreaterThanOrEqual(6);
    expect(h.calls.health.length).toBeLessThanOrEqual(8);
  });

  it('18. AUTH_ERROR stops the beat loop instead of hammering the server', () => {
    const h = buildWatchdog();
    bindClock(h);
    h.wd.setHasCredential(true);
    h.wd.start();
    h.wd.markHeartbeat();
    const beatsBefore = h.calls.beat.length;

    h.wd.setAuthError('screen_unauthorized');
    expect(h.wd.snapshot().state).toBe('auth_error');
    h.clock.advance(1800000);
    expect(h.calls.beat.length).toBe(beatsBefore);
    expect(h.calls.reload.length).toBe(0);

    // A re-issued credential leaves the error state without a reload.
    h.wd.setHasCredential(true);
    expect(h.wd.snapshot().state).not.toBe('auth_error');
  });

  it('19. CONFIG_ERROR is reported and never escalates to a page reload', () => {
    const h = buildWatchdog();
    bindClock(h);
    h.setNetwork('down');
    h.wd.setHasCredential(true);
    h.wd.start();
    h.setRuntimeHealthy(false, true, true);

    h.wd.setConfigError('config_invalid');
    expect(h.wd.snapshot().state).toBe('config_error');
    h.clock.advance(3600000);
    expect(h.calls.reload.length).toBe(0);
    expect(h.wd.snapshot().state).toBe('config_error');
  });

  it('20. the heartbeat payload carries the health fields and no secret of any kind', async () => {
    const { buildFixture } = await import('./player-harness');
    const fixture = buildFixture();
    const plan = createTransport(fixture);
    const target = tv({ indexedDb: new IDBFactory(), transport: plan.transport });
    await seedCache(target, fixture);
    const player = await bootTv(target);
    await settle(target.win, target.clock, 400);

    const bodies = heartbeatBodies(target, plan.calls);
    expect(bodies.length).toBeGreaterThan(0);
    const last = bodies[bodies.length - 1];
    expect(last.playerState).toBeTruthy();
    expect(typeof last.appliedSyncVersion).toBe('number');
    expect(typeof last.appliedReloadVersion).toBe('number');
    expect(last.recovery).toBeTruthy();
    expect(typeof last.recovery.count).toBe('number');
    expect(last.bootAt).toBeTruthy();

    // Diagnostics are operational codes only: no credential, token, cookie, signed URL or secret
    // may ever leave the television.
    const serialized = JSON.stringify(bodies);
    expect(serialized).not.toMatch(/credential/i);
    expect(serialized).not.toMatch(/bearer/i);
    expect(serialized).not.toMatch(/sig=/i);
    expect(player.log().every((entry: any) => !/credential-1|Bearer /i.test(JSON.stringify(entry.data || '')))).toBe(true);
  });

  it('21. a screen is online only from a recent authenticated heartbeat, never from an old record', () => {
    resetScreenHealthColumnCache();
    const now = Date.UTC(2026, 9, 8, 12, 0, 0);
    const fresh = new Date(now - 30_000).toISOString();
    const old = new Date(now - 24 * 60 * 60_000).toISOString();

    expect(deriveScreenHealth({ last_seen_at: fresh }, now).status).toBe('online');
    expect(isScreenOnline(deriveScreenHealth({ last_seen_at: fresh }, now))).toBe(true);

    // One day old: the row still exists, but nothing proves the television is alive right now.
    const stale = deriveScreenHealth({ last_seen_at: old }, now);
    expect(stale.status).toBe('offline');
    expect(isScreenOnline(stale)).toBe(false);

    // Never connected at all is offline, not online-by-default.
    const never = deriveScreenHealth({}, now);
    expect(never.status).toBe('offline');
    expect(never.neverConnected).toBe(true);

    // An optimistic client claim cannot manufacture an online status.
    const claiming = deriveScreenHealth({ last_seen_at: old, player_state: 'online' }, now);
    expect(claiming.status).toBe('offline');
    // A pessimistic one is honoured even inside the fresh window.
    const pessimistic = deriveScreenHealth({ last_seen_at: fresh, player_state: 'reconnecting' }, now);
    expect(pessimistic.status).toBe('reconnecting');
    expect(HEALTH_WINDOWS.onlineMs).toBe(90_000);
  });

  it('22. pending commands and recovery come from one server-side source of truth', () => {
    resetScreenHealthColumnCache();
    const now = Date.UTC(2026, 9, 8, 12, 0, 0);
    const fresh = new Date(now - 10_000).toISOString();

    const pending = deriveScreenHealth({
      last_seen_at: fresh, sync_command_version: 5, reload_command_version: 2,
      last_applied_sync_version: 3, last_applied_reload_version: 2,
    }, now);
    expect(pending.command).toEqual({ sync: 5, reload: 2 });
    expect(pending.applied).toEqual({ sync: 3, reload: 2 });
    expect(pending.pendingCommands).toBe(2);

    // Nothing is claimed as pending while the acknowledged version is unknown (migration not applied).
    const unknown = deriveScreenHealth({ last_seen_at: fresh, sync_command_version: 5 }, now);
    expect(unknown.applied).toEqual({ sync: null, reload: null });
    expect(unknown.pendingCommands).toBe(0);

    const recovered = deriveScreenHealth({
      last_seen_at: fresh, player_state: 'recovering', player_state_since: fresh,
      recovery_count: 4, last_recovery_at: fresh, last_recovery_reason: 'empty_stage',
      last_recovery_state: 'recovering', last_health_status: 'ok', last_health_checked_at: fresh,
      last_boot_at: fresh, boot_count: 9,
    }, now);
    expect(recovered.status).toBe('recovering');
    expect(recovered.recovery).toEqual({ state: 'recovering', count: 4, lastAt: fresh, reason: 'empty_stage' });
    expect(recovered.health).toEqual({ status: 'ok', checkedAt: fresh });
    expect(recovered.boot).toEqual({ count: 9, lastAt: fresh });
    // A recovery reason is stored as an operational code and is length-bounded.
    expect(deriveScreenHealth({ last_seen_at: fresh, last_recovery_reason: 'x'.repeat(500) }, now).recovery.reason?.length).toBe(120);
  });
});
