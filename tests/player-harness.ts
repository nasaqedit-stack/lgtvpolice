/*
 * Shared harness for the standalone (webOS 3.5) player tests.
 *
 * These helpers build a jsdom "TV" — an old-browser window with configurable missing APIs — and
 * load the exact files that are shipped to the television (`public/player/*.js` and the real
 * `renderPlayerShell()` document), so the tests exercise the deployed code, not a copy of it.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { JSDOM } from 'jsdom';
import { renderPlayerShell } from '../lib/player/standalone/shell';

export const PLAYER_DIR = path.join(process.cwd(), 'public', 'player');
export const TV_USER_AGENT =
  'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) QtWebEngine/5.2.1 ' +
  'Chrome/38.0.2125.122 Safari/537.36 HbbTV/1.4.1 (+DRM;WebOS3.5;Linux;) 49UJ630V-ZA; WEBOS3.5 06.10.75';

export function readPlayerScript(name: string): string {
  return readFileSync(path.join(PLAYER_DIR, name), 'utf8');
}

export function undefine(win: any, name: string): void {
  try {
    Object.defineProperty(win, name, { value: undefined, configurable: true, writable: true });
  } catch {
    /* some window properties cannot be redefined; leaving them is harmless */
  }
}

export function setUserAgent(win: any, userAgent = TV_USER_AGENT): void {
  Object.defineProperty(win.navigator, 'userAgent', { value: userAgent, configurable: true });
}

/* -------------------------------------------------------------------------------------------- */
/* Virtual clock: the player schedules with window.setTimeout, so tests need to own that queue.  */
/* -------------------------------------------------------------------------------------------- */

export type VirtualClock = {
  advance: (ms: number) => void;
  pending: () => number;
  now: () => number;
};

export function installClock(win: any): VirtualClock {
  const origin = Date.now();
  let now = 0;
  let sequence = 1;
  const timers = new Map<number, { at: number; fn: () => void; interval?: number }>();
  // The player (and its watchdog) schedule with Date.now() as well as with timers. `advance()` must
  // therefore move BOTH clocks, otherwise absolute deadlines would stay in the real-time future and
  // the television would appear frozen for the whole virtual run.
  try {
    win.Date.now = () => origin + now;
  } catch {
    /* some windows refuse to redefine Date.now; the timer queue still drives the player */
  }

  win.setTimeout = (fn: () => void, ms?: number) => {
    const id = sequence;
    sequence += 1;
    timers.set(id, { at: now + (Number(ms) || 0), fn });
    return id;
  };
  win.clearTimeout = (id: number) => { timers.delete(Number(id)); };
  win.setInterval = (fn: () => void, ms?: number) => {
    const id = sequence;
    sequence += 1;
    const interval = Math.max(1, Number(ms) || 1);
    timers.set(id, { at: now + interval, fn, interval });
    return id;
  };
  win.clearInterval = (id: number) => { timers.delete(Number(id)); };

  function run(): void {
    for (let guard = 0; guard < 10000; guard += 1) {
      let chosenId: number | null = null;
      timers.forEach((timer, id) => {
        if (timer.at > now) return;
        const chosen = chosenId === null ? null : timers.get(chosenId);
        if (!chosen || timer.at < chosen.at) chosenId = id;
      });
      if (chosenId === null) return;
      const chosen = timers.get(chosenId);
      if (!chosen) return;
      if (chosen.interval) chosen.at += chosen.interval;
      else timers.delete(chosenId);
      chosen.fn();
    }
  }

  return {
    advance(ms: number) {
      now += Math.max(0, Number(ms) || 0);
      run();
    },
    pending: () => timers.size,
    now: () => now
  };
}

/**
 * Runs the microtask queue and the due zero-delay timers repeatedly. The runtime deliberately
 * yields between hash chunks with setTimeout(..., 0), so promise chains only finish if both the
 * microtask queue and the timer queue keep moving.
 */
export async function settle(win: any, clock: VirtualClock, rounds = 60): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    clock.advance(1);
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Browser shims: jsdom is not a TV, so the pieces the TV does have get provided explicitly.      */
/* -------------------------------------------------------------------------------------------- */

/** jsdom cannot play media; the stub records calls and resolves like a TV would. */
export function installMediaStubs(win: any): { play: string[]; pause: string[]; finished: string[]; load: string[] } {
  const calls = { play: [] as string[], pause: [] as string[], finished: [] as string[], load: [] as string[] };
  const proto = win.HTMLMediaElement && win.HTMLMediaElement.prototype;
  if (!proto) return calls;
  proto.play = function play(this: any) { calls.play.push(String(this.src || '')); return win.Promise.resolve(); };
  proto.pause = function pause(this: any) { calls.pause.push(String(this.src || '')); };
  proto.load = function load(this: any) { calls.load.push(String(this.src || '')); return undefined; };
  return calls;
}

/** jsdom has no Blob URL support, but every TV browser this player targets does. */
export function installBlobUrls(win: any): { created: string[]; revoked: string[] } {
  const record = { created: [] as string[], revoked: [] as string[] };
  let sequence = 0;
  const api = {
    createObjectURL(blob: any): string {
      sequence += 1;
      const url = `blob:https://lgtvpolice.vercel.app/${sequence}`;
      record.created.push(url);
      void blob;
      return url;
    },
    revokeObjectURL(url: string): void { record.revoked.push(url); }
  };
  win.URL.createObjectURL = api.createObjectURL;
  win.URL.revokeObjectURL = api.revokeObjectURL;
  if (win.webkitURL) {
    win.webkitURL.createObjectURL = api.createObjectURL;
    win.webkitURL.revokeObjectURL = api.revokeObjectURL;
  }
  return record;
}

/** Reads a Blob's bytes in a way that works in both jsdom and an older browser. */
export async function blobBytes(win: any, blob: any): Promise<Uint8Array> {
  if (blob && typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new win.FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(new Error('blob read failed'));
    reader.readAsArrayBuffer(blob);
  });
}

/** Gives the TV window its own in-memory IndexedDB implementation. */
export function installFakeIndexedDb(win: any, factory: IDBFactory = new IDBFactory()): void {
  win.indexedDB = factory;
  win.IDBKeyRange = IDBKeyRange;
}

/** Minimal CacheStorage stand-in, used to prove the no-IndexedDB fallback works. */
export function installFakeCaches(win: any): void {
  class FakeCacheResponse {
    status = 200;
    private body: Uint8Array;
    private headers: Map<string, string>;
    constructor(body: any, init: any = {}) {
      this.body = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body || []);
      this.headers = new Map(Object.entries(init.headers || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
      this.status = init.status || 200;
    }
    get _bytes(): Uint8Array { return this.body; }
    async arrayBuffer(): Promise<ArrayBuffer> { return this.body.buffer.slice(0) as ArrayBuffer; }
    async text(): Promise<string> { return new TextDecoder().decode(this.body); }
    async json(): Promise<any> { return JSON.parse(await this.text()); }
    headersOf(): Map<string, string> { return this.headers; }
  }
  win.Response = FakeCacheResponse;
  const store = new Map<string, FakeCacheResponse>();
  const url = (key: any) => (typeof key === 'string' ? key : key && key.url);
  win.caches = {
    async open() {
      return {
        async put(key: any, value: FakeCacheResponse) { store.set(url(key), value); },
        async match(key: any) { return store.get(url(key)); },
        async keys() { return Array.from(store.keys()).map((entry) => ({ url: entry })); },
        async delete(key: any) { return store.delete(url(key)); }
      };
    },
    async keys() { return ['signage-player']; },
    async delete() { store.clear(); return true; }
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Fake transport: speaks the real player API, including its failures.                            */
/* -------------------------------------------------------------------------------------------- */

export type FakeResponse = {
  status: number;
  ok: boolean;
  url: string;
  bytes: Uint8Array | null;
  text: string | null;
  receivedBytes: number;
  header: (name: string) => string | null;
  json: () => any;
};

export function response(status: number, body: { text?: string; bytes?: Uint8Array }, headers: Record<string, string> = {}): FakeResponse {
  const text = body.text === undefined ? null : body.text;
  const bytes = body.bytes === undefined ? null : body.bytes;
  return {
    status,
    ok: status >= 200 && status < 300,
    url: '',
    bytes,
    text,
    receivedBytes: bytes ? bytes.length : (text ? text.length : 0),
    header: (name: string) => headers[name] || headers[name.toLowerCase()] || null,
    json: () => JSON.parse(text === null ? '' : text)
  };
}

export const jsonResponse = (status: number, data: unknown, headers?: Record<string, string>) =>
  response(status, { text: JSON.stringify(data) }, headers);
export const binaryResponse = (status: number, bytes: Uint8Array, headers?: Record<string, string>) =>
  response(status, { bytes }, headers);
export const emptyResponse = (status: number, headers?: Record<string, string>) =>
  response(status, { text: '' }, headers);

export function networkError(): Error {
  const error = new Error('network unreachable');
  (error as any).code = 'network_error';
  return error;
}

export type TransportCall = { method: string; url: string; headers: Record<string, string>; body: string | null; isRange: boolean };
export type Transport = (spec: { method: string; url: string; headers: Record<string, string>; body: string | null }) => Promise<FakeResponse>;

export type FixtureOptions = {
  imageBytes?: string;
  videoBytes?: string;
  videoLoop?: boolean;
  imageDurationMs?: number | null;
  hashOverride?: { image?: string };
  schedule?: boolean;
};

export type Fixture = {
  manifest: any;
  imageId: string;
  videoId: string;
  imageHash: string;
  videoHash: string;
  imageBytes: Uint8Array;
  videoBytes: Uint8Array;
  playlistId: string;
};

/** A manifest shaped exactly like /api/player/manifest answers, with real hashes. */
export function buildFixture(options: FixtureOptions = {}): Fixture {
  const hash = (bytes: Uint8Array) => sha256Hex(bytes);
  const imageBytes = new TextEncoder().encode(options.imageBytes || 'image-one-bytes');
  const videoBytes = new TextEncoder().encode(options.videoBytes || 'mp4-two-bytes');
  const imageHash = (options.hashOverride && options.hashOverride.image) || hash(imageBytes);
  const videoHash = hash(videoBytes);
  const ids = {
    screen: '00000000-0000-4000-8000-000000000001',
    playlist: '00000000-0000-4000-8000-000000000002',
    image: '00000000-0000-4000-8000-000000000003',
    video: '00000000-0000-4000-8000-000000000004',
    imageItem: '00000000-0000-4000-8000-000000000005',
    videoItem: '00000000-0000-4000-8000-000000000006'
  };
  const manifest = {
    schemaVersion: 1,
    screen: { id: ids.screen, name: 'Test screen', timezone: 'Asia/Riyadh' },
    manifestVersion: 1,
    manifestHash: 'a'.repeat(64),
    generatedAt: '2026-10-08T00:00:00.000Z',
    defaultPlaylistId: ids.playlist,
    playlists: [{
      id: ids.playlist,
      name: 'Test',
      version: 1,
      enabled: true,
      items: [
        {
          id: ids.imageItem, mediaId: ids.image, name: 'notice.png', hash: imageHash, size: imageBytes.length,
          mimeType: 'image/png', kind: 'image', durationMs: options.imageDurationMs === undefined ? 5000 : options.imageDurationMs,
          loop: false, position: 0
        },
        {
          id: ids.videoItem, mediaId: ids.video, name: 'welcome.mp4', hash: videoHash, size: videoBytes.length,
          mimeType: 'video/mp4', kind: 'video', durationMs: null, loop: Boolean(options.videoLoop), position: 1
        }
      ]
    }],
    schedules: [],
    assets: [
      { mediaId: ids.image, hash: imageHash, size: imageBytes.length, mimeType: 'image/png', name: 'notice.png' },
      { mediaId: ids.video, hash: videoHash, size: videoBytes.length, mimeType: 'video/mp4', name: 'welcome.mp4' }
    ],
    commands: { syncVersion: 1, reloadVersion: 0 }
  };
  return {
    manifest,
    imageId: ids.image,
    videoId: ids.video,
    imageHash,
    videoHash,
    imageBytes,
    videoBytes,
    playlistId: ids.playlist
  };
}

export type TransportPlan = {
  /** Fail every request with a network error after this many successful calls. */
  offlineAfter?: number;
  manifestStatus?: number;
  heartbeatStatus?: number;
  manifestInvalid?: boolean;
  signedUrlStatus?: number;
  signedUrlNetworkError?: boolean;
  sameOriginStatus?: number;
  ignoreRange?: boolean;
  /** Fail the first N requests of any kind (network-level). */
  failTimes?: number;
  /** Transient failures that only affect media requests (signed and same-origin). */
  failMediaTimes?: number;
  corruptedImage?: boolean;
};

export function createTransport(fixture: Fixture, plan: TransportPlan = {}) {
  const calls: TransportCall[] = [];
  let successes = 0;
  let remainingFailures = plan.failTimes || 0;
  let remainingMediaFailures = plan.failMediaTimes || 0;
  const signedUrls = new Map<string, string>();
  const files = new Map<string, { bytes: Uint8Array; hash: string; mimeType: string }>([
    [fixture.imageId, { bytes: fixture.imageBytes, hash: fixture.imageHash, mimeType: 'image/png' }],
    [fixture.videoId, { bytes: fixture.videoBytes, hash: fixture.videoHash, mimeType: 'video/mp4' }]
  ]);

  const transport: Transport = (spec) => {
    const headers = spec.headers || {};
    const range = headers.Range || headers.range || null;
    calls.push({ method: spec.method, url: spec.url, headers, body: spec.body || null, isRange: Boolean(range) });

    if (plan.offlineAfter !== undefined && successes >= plan.offlineAfter) return Promise.reject(networkError());
    if (remainingFailures > 0) {
      remainingFailures -= 1;
      return Promise.reject(networkError());
    }
    const isMediaRequest = /^https:\/\//.test(spec.url) || /^\/api\/player\/media\//.test(spec.url);
    if (isMediaRequest && plan.failMediaTimes && remainingMediaFailures > 0) {
      remainingMediaFailures -= 1;
      return Promise.reject(networkError());
    }
    successes += 1;

    if (spec.url === '/api/player/manifest') {
      if (plan.manifestStatus) return Promise.resolve(jsonResponse(plan.manifestStatus, {
        error: 'boom', code: plan.manifestStatus === 401 ? 'screen_unauthorized' : 'temporary_error'
      }));
      if (plan.manifestInvalid) return Promise.resolve(jsonResponse(200, { schemaVersion: 1, playlists: 'nope' }));
      const etag = `"${fixture.manifest.manifestHash}"`;
      if (headers['If-None-Match'] === etag) return Promise.resolve(emptyResponse(304, { ETag: etag }));
      return Promise.resolve(jsonResponse(200, fixture.manifest, { ETag: etag }));
    }

    if (spec.url === '/api/player/media-urls') {
      const body = JSON.parse(spec.body || '{}');
      if (plan.signedUrlStatus && plan.signedUrlStatus !== 200) {
        return Promise.resolve(jsonResponse(plan.signedUrlStatus, { error: 'no signed url' }));
      }
      const urls: Record<string, string> = {};
      for (const mediaId of body.mediaIds || []) {
        const url = `https://objects.example.test/${mediaId}?sig=test`;
        signedUrls.set(mediaId, url);
        urls[mediaId] = url;
      }
      return Promise.resolve(jsonResponse(200, { urls, expiresIn: 3600 }));
    }

    const signed = /^https:\/\/objects\.example\.test\/([^?]+)/.exec(spec.url);
    if (signed) {
      const file = files.get(signed[1]);
      if (!file) return Promise.resolve(emptyResponse(404));
      if (plan.signedUrlStatus && plan.signedUrlStatus !== 200) return Promise.resolve(emptyResponse(plan.signedUrlStatus));
      if (plan.signedUrlNetworkError) return Promise.reject(networkError());
      const bytes = plan.corruptedImage && signed[1] === fixture.imageId
        ? new TextEncoder().encode('corrupted-image-payload')
        : file.bytes;
      return Promise.resolve(sliceResponse(bytes, range, file.mimeType, plan));
    }

    const sameOrigin = /^\/api\/player\/media\/([^?]+)/.exec(spec.url);
    if (sameOrigin) {
      const file = files.get(sameOrigin[1]);
      if (!file) return Promise.resolve(emptyResponse(404));
      if (!headers.Authorization) return Promise.resolve(jsonResponse(401, { error: 'unauthorized', code: 'screen_unauthorized' }));
      if (plan.sameOriginStatus && plan.sameOriginStatus !== 200) return Promise.resolve(jsonResponse(plan.sameOriginStatus, {
        error: 'media request failed', code: plan.sameOriginStatus === 401 ? 'screen_unauthorized' : 'temporary_error'
      }));
      return Promise.resolve(sliceResponse(file.bytes, range, file.mimeType, plan));
    }

    if (spec.url === '/api/player/pair') {
      const body = JSON.parse(spec.body || '{}');
      if (body.code !== 'ABCD1234') return Promise.resolve(jsonResponse(400, { error: 'رمز الربط غير صالح أو منتهي.' }));
      return Promise.resolve(jsonResponse(200, {
        credential: 'credential-1',
        screen: { id: fixture.manifest.screen.id, name: fixture.manifest.screen.name, timezone: 'Asia/Riyadh' }
      }));
    }

    if (spec.url === '/api/player/heartbeat') {
      if (plan.heartbeatStatus && plan.heartbeatStatus !== 200) {
        return Promise.resolve(jsonResponse(plan.heartbeatStatus, {
          error: 'heartbeat failed',
          code: plan.heartbeatStatus === 401 ? 'screen_unauthorized' : 'temporary_error'
        }));
      }
      return Promise.resolve(jsonResponse(200, { ok: true, serverTime: '2026-10-08T00:00:00.000Z' }));
    }

    return Promise.resolve(emptyResponse(404));
  };

  return {
    transport,
    calls,
    signedUrls,
    count: (url: string) => calls.filter((call) => call.url === url).length,
    countMatching: (pattern: RegExp) => calls.filter((call) => pattern.test(call.url)).length
  };
}

function sliceResponse(bytes: Uint8Array, range: string | null, mimeType: string, plan: TransportPlan): FakeResponse {
  if (!range || plan.ignoreRange) return binaryResponse(200, bytes, { 'Content-Type': mimeType });
  const match = /^bytes=(\d+)-(\d+)$/.exec(range);
  if (!match) return binaryResponse(200, bytes, { 'Content-Type': mimeType });
  const start = Number(match[1]);
  const end = Math.min(Number(match[2]), bytes.length - 1);
  if (start >= bytes.length || start > end) return emptyResponse(416);
  const slice = bytes.slice(start, end + 1);
  return binaryResponse(206, slice, {
    'Content-Type': mimeType,
    'Content-Range': `bytes ${start}-${end}/${bytes.length}`
  });
}

export function sha256Hex(bytes: Uint8Array): string {
  // The runtime ships its own ES5 SHA-256; this test-side digest only validates the fixtures.
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

/* -------------------------------------------------------------------------------------------- */
/* Page factory                                                                                   */
/* -------------------------------------------------------------------------------------------- */

export type FakePage = {
  dom: JSDOM;
  win: any;
  clock: VirtualClock;
  runtime: any;
  ui: any;
  media: ReturnType<typeof installMediaStubs>;
  blobUrls: { created: string[]; revoked: string[] };
};

export type PageOptions = {
  url?: string;
  html?: string;
  /** Let player.js boot itself (default: stay manual so a test controls the sequence). */
  autoBoot?: boolean;
  /** Runs before the document is parsed and its inline scripts execute. */
  beforeParse?: (win: any) => void;
  /** Skip loading the player scripts (used to test the HTML-only boot guard). */
  skipScripts?: boolean;
  transport?: Transport | null;
  indexedDb?: any;
  cacheApi?: boolean;
  chrome38?: boolean;
};

export function createPage(options: PageOptions = {}): FakePage {
  const dom = new JSDOM(options.html || renderPlayerShell(), {
    url: options.url || 'https://lgtvpolice.vercel.app/player',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse: options.beforeParse
  });
  const win = dom.window as any;
  if (options.chrome38 !== false) setUserAgent(win);
  if (!options.autoBoot) win.__SIGNAGE_NO_AUTOBOOT = true;
  const clock = installClock(win);
  const media = installMediaStubs(win);
  const blobUrls = installBlobUrls(win);
  if (options.indexedDb) installFakeIndexedDb(win, options.indexedDb);
  if (options.cacheApi) installFakeCaches(win);
  if (options.transport) win.__SIGNAGE_TRANSPORT__ = options.transport;
  let runtime: any = null;
  let ui: any = null;
  if (!options.skipScripts) {
    win.eval(readPlayerScript('sha256.js'));
    win.eval(readPlayerScript('runtime.js'));
    win.eval(readPlayerScript('watchdog.js'));
    win.eval(readPlayerScript('player.js'));
    runtime = win.SignagePlayerRuntime;
    ui = win.SignagePlayerUI;
  }
  return { dom, win, clock, runtime, ui, media, blobUrls };
}

/** Removes the APIs a 2016 LG TV browser does not implement. */
export function stripModernApis(win: any): void {
  for (const name of ['AbortController', 'AbortSignal', 'ReadableStream', 'WritableStream', 'BroadcastChannel',
    'ResizeObserver', 'IntersectionObserver', 'MediaSource', 'SourceBuffer', 'structuredClone']) {
    undefine(win, name);
  }
  undefine(win.navigator, 'storage');
  if (win.crypto) undefine(win.crypto, 'subtle');
}

/** Waits for a condition while driving the virtual clock and the microtask queue. */
export async function waitFor(win: any, clock: VirtualClock, condition: () => boolean, rounds = 60): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    if (condition()) return;
    await settle(win, clock, 1);
  }
  if (!condition()) throw new Error('condition not met before the virtual clock ran out');
}
