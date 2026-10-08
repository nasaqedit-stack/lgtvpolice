/*
 * End-to-end behaviour of the /player page on a simulated webOS 3.5 television.
 *
 * These tests load the real shell document (lib/player/standalone/shell.ts) plus the real shipped
 * runtime files into jsdom, strip the modern browser APIs the TV does not have, and then walk the
 * required sequence: BOOT -> render UI -> detect capabilities -> pair -> fetch manifest -> download
 * -> cache -> play, including a cold start with the network completely down.
 */
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPage,
  createTransport,
  settle,
  stripModernApis,
  undefine,
  waitFor,
  type FakePage
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

/** Runs a player operation (which yields with window.setTimeout) while the virtual clock moves. */
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

async function boot(target: FakePage, options: any = {}): Promise<any> {
  const player = target.ui.create({ win: target.win, runtime: target.runtime, ...options });
  await runToCompletion(target, player.start());
  await settle(target.win, target.clock);
  return player;
}

function setPairCode(target: FakePage, code: string): void {
  const input = target.win.document.querySelector('#signage-pair-code') as any;
  expect(input, 'the pairing input must be rendered').toBeTruthy();
  input.value = code;
  input.oninput();
  const form = target.win.document.querySelector('.sp-form') as any;
  expect(form, 'the pairing form must be rendered').toBeTruthy();
  form.onsubmit({ preventDefault() { /* no-op */ } });
}

describe('booting on a TV browser without modern APIs', () => {
  it('renders the pairing screen and reports readiness (no blank screen)', async () => {
    const fixture = createTransport({ manifest: {} } as any);
    void fixture;
    const target = page();
    stripModernApis(target.win);
    undefine(target.win, 'indexedDB');

    const player = await boot(target);

    expect(target.win.__signageBooted).toBe(true);
    expect(target.win.document.getElementById('signage-fatal')).toBeNull();
    expect(target.win.document.querySelector('.sp-stage')).toBeTruthy();
    expect(target.win.document.querySelector('.sp-status')).toBeTruthy();
    expect((target.win.document.querySelector('.sp-panel h1') as any).textContent).toBe('اربط هذه الشاشة');
    expect(target.win.document.body.textContent).toContain('يُستخدم الرمز مرة واحدة');
    expect(player.storage().backend).toBe('memory');
    expect(player.state.phase).toBe('pair');
  });

  it('auto-boots when the shell loads the scripts the normal way', async () => {
    const target = page({ autoBoot: true });
    await waitFor(target.win, target.clock, () => Boolean(target.win.SignagePlayerInstance));
    await settle(target.win, target.clock);
    expect(target.win.__signageBooted).toBe(true);
    expect(target.win.document.querySelector('#signage-pair-code')).toBeTruthy();
  });

  it('registers the optional offline shell without depending on it', async () => {
    const registered: string[] = [];
    const target = page({
      autoBoot: true,
      beforeParse(win: any) {
        Object.defineProperty(win.navigator, 'serviceWorker', {
          configurable: true,
          value: { register: (url: string) => { registered.push(url); return win.Promise.reject(new Error('registration blocked')); } }
        });
      }
    });
    await waitFor(target.win, target.clock, () => Boolean(target.win.SignagePlayerInstance));
    await settle(target.win, target.clock, 20);

    // The registration attempt fails, and the player boots and renders anyway.
    expect(registered).toEqual(['/sw.js']);
    expect(target.win.__signageBooted).toBe(true);
    expect(target.win.document.querySelector('#signage-pair-code')).toBeTruthy();
  });

  it('keeps a working retry path when the runtime has no native Promise', async () => {
    const target = page();
    undefine(target.win, 'Promise');
    stripModernApis(target.win);
    const player = await boot(target);
    expect(target.win.__signageBooted).toBe(true);
    expect(player.state.pairError).toBe('');

    setPairCode(target, '12');
    await settle(target.win, target.clock);
    expect(target.win.document.querySelector('.sp-alert')!.textContent).toBe('أدخل الرمز المكوّن من 8 أحرف.');
    expect(player.state.phase).toBe('pair');
  });
});

describe('blank-screen protection', () => {
  it('shows diagnostics and automatically retries missing player scripts without a button', () => {
    const target = page({ skipScripts: true });
    const fatal = target.win.document.getElementById('signage-fatal') as any;
    expect(fatal).toBeTruthy();
    expect(fatal.style.display).toBe('none');

    target.win.__signageGuard('تعذر تحميل ملف المشغل: runtime.js');

    expect(fatal.style.display).toBe('block');
    expect(fatal.textContent).toContain('المشغل يحاول استعادة التشغيل تلقائياً');
    expect(fatal.textContent).toContain('تعذر تحميل ملف المشغل: runtime.js');
    expect(fatal.textContent).toContain('تتم إعادة المحاولة تلقائياً');
    const details = target.win.document.getElementById('signage-fatal-ua') as any;
    expect(details.textContent).toContain('Chromium: 38');
    expect(details.textContent).toContain('runtime.js: missing');
    expect(details.textContent).toContain('player.js: missing');
    expect(fatal.querySelector('a')).toBeNull();
    expect(target.clock.pending()).toBeGreaterThan(0);
    expect(target.win.document.getElementById('signage-fatal-href').textContent).toContain('/player');
  });

  it('stays hidden once the player boots, and is armed by every script tag', () => {
    const target = page({ skipScripts: true });
    target.win.__signageBooted = true;
    target.win.__signageGuard('too late');
    expect((target.win.document.getElementById('signage-fatal') as any).style.display).toBe('none');
  });

  it('falls back to the diagnostics screen when the storage layer itself throws', async () => {
    const target = page();
    const original = target.runtime.createStorage;
    target.runtime.createStorage = () => { throw new Error('storage exploded'); };
    await boot(target);
    target.runtime.createStorage = original;

    const panel = target.win.document.querySelector('.sp-ui-diagnostics') as any;
    expect(panel).toBeTruthy();
    expect(panel.textContent).toContain('storage exploded');
    expect(panel.textContent).toContain('آخر خطأ');
    const buttons = Array.from(panel.querySelectorAll('button')).map((node: any) => node.textContent);
    expect(buttons).toContain('إعادة المحاولة');
    expect(buttons).not.toContain('إعادة التحميل');
  });
});

describe('diagnostics screen', () => {
  it('opens from ?diag=1 and lists browser info, capabilities and the required actions', async () => {
    const target = page({ url: 'https://lgtvpolice.vercel.app/player?diag=1' });
    await boot(target);
    await waitFor(target.win, target.clock, () => Boolean(target.win.document.querySelector('.sp-ui-diagnostics')));

    const panel = target.win.document.querySelector('.sp-ui-diagnostics') as any;
    const text = panel.textContent;
    expect(text).toContain('معلومات المتصفح');
    expect(text).toContain('Chromium: 38');
    expect(text).toContain('webOS: 3.5');
    expect(text).toContain('قدرات المتصفح المكتشفة');
    expect(text).toContain('xmlHttpRequest');
    expect(text).toContain('abortController');
    expect(text).toContain('غير متوفر');
    expect(text).toContain('آخر الأحداث');
    const buttons = Array.from(panel.querySelectorAll('button')).map((node: any) => node.textContent);
    expect(buttons).toContain('إعادة المحاولة');
    expect(buttons).not.toContain('إعادة التحميل');
    expect(buttons).toContain('إغلاق');
  });

  it('shows the mandated incompatibility message when the browser cannot reach the server at all', async () => {
    const target = page({ url: 'https://lgtvpolice.vercel.app/player?diag=1' });
    undefine(target.win, 'XMLHttpRequest');
    undefine(target.win, 'fetch');
    await boot(target);
    await waitFor(target.win, target.clock, () => Boolean(target.win.document.querySelector('.sp-ui-diagnostics')));

    const panel = target.win.document.querySelector('.sp-ui-diagnostics') as any;
    expect(panel.textContent).toContain('مشغل الشاشة غير متوافق مع إصدار المتصفح الحالي');
    expect(panel.textContent).toContain('هذا المتصفح لا يدعم أي وسيلة اتصال');
    const features = Array.from(panel.querySelectorAll('.sp-no')).map((node: any) => node.textContent);
    expect(features.length).toBeGreaterThan(0);
  });

  it('opens from the status line and offers a retry that re-runs the failed sync', async () => {
    const fixture = createTransport({ manifest: {} } as any);
    void fixture;
    const target = page();
    await boot(target);
    (target.win.document.querySelector('.sp-status') as any).onclick();
    const panel = target.win.document.querySelector('.sp-ui-diagnostics') as any;
    expect(panel).toBeTruthy();
    const retry = Array.from(panel.querySelectorAll('button')).find((node: any) => node.textContent === 'إعادة المحاولة') as any;
    expect(retry).toBeTruthy();
    retry.onclick();
    await settle(target.win, target.clock, 50);
    expect(target.win.document.querySelector('.sp-stage')).toBeTruthy();
  });
});

describe('pairing, downloading and playing through the UI', () => {
  it('pairs, downloads the manifest, caches the media and plays it (image then MP4)', async () => {
    const { buildFixture } = await import('./player-harness');
    const fixture = buildFixture();
    const plan = createTransport(fixture);
    const target = page({ transport: plan.transport });
    const player = await boot(target);
    expect(player.state.showPairForm).toBe(true);

    setPairCode(target, 'ABCD-1234');
    await settle(target.win, target.clock, 400);

    expect(player.state.token).toBe('credential-1');
    expect(await player.storage().getCredential()).toBe('credential-1');
    expect((await player.storage().getActiveManifest()).manifestHash).toBe(fixture.manifest.manifestHash);
    expect(await player.storage().countCachedAssets()).toBe(2);

    const image: any = target.win.document.querySelector('img.sp-media');
    expect(image).toBeTruthy();
    expect(image.getAttribute('src')).toContain('blob:');
    expect(target.win.document.body.textContent).toContain('تشغيل محلي');
    expect(target.win.document.body.textContent).toContain('Test screen');

    image.onload();
    target.clock.advance(5200);
    await settle(target.win, target.clock, 100);
    const video: any = target.win.document.querySelector('video.sp-video');
    expect(video).toBeTruthy();
    expect(video.getAttribute('src')).toContain('blob:');
    expect(target.media.play.length).toBeGreaterThan(0);
    expect(plan.calls.some((call) => call.isRange)).toBe(true);
  });

  it('automatically starts cached video muted when LG rejects audible autoplay', async () => {
    const { buildFixture } = await import('./player-harness');
    const fixture = buildFixture();
    const plan = createTransport(fixture);
    const target = page({ transport: plan.transport, indexedDb: new IDBFactory() });
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
    setPairCode(target, 'ABCD-1234');
    await settle(target.win, target.clock, 400);

    const image: any = target.win.document.querySelector('img.sp-media');
    expect(image).toBeTruthy();
    image.onload();
    target.clock.advance(5200);
    await settle(target.win, target.clock, 100);

    const video: any = target.win.document.querySelector('video.sp-video');
    const overlay: any = target.win.document.querySelector('.sp-overlay');
    const status: any = target.win.document.querySelector('.sp-status');
    expect(video).toBeTruthy();
    expect(video.getAttribute('muted')).toBe('muted');
    expect(video.muted).toBe(true);
    expect(overlay.style.display).toBe('none');
    expect(status.style.display).toBe('none');
    expect(target.win.document.querySelector('.sp-audio-control')).toBeNull();
    expect(playAttempts).toContain(false);
    expect(playAttempts).toContain(true);
    expect(await player.storage().getAudioEnabled()).toBe(false);
  });

  it('keeps playing cached media when the network dies and recovers on retry', async () => {
    const { buildFixture } = await import('./player-harness');
    const fixture = buildFixture();
    let offline = false;
    const plan = createTransport(fixture);
    const transport = (spec: any) => (offline ? Promise.reject(Object.assign(new Error('offline'), { code: 'network_error' })) : plan.transport(spec));
    const target = page({ transport });
    const player = await boot(target);
    setPairCode(target, 'ABCD-1234');
    await settle(target.win, target.clock, 400);
    expect(await player.storage().countCachedAssets()).toBe(2);

    offline = true;
    target.clock.advance(61000);
    await settle(target.win, target.clock, 200);

    // Cached content keeps playing; the failure is visible but never blanks the screen.
    expect(target.win.document.querySelector('img.sp-media, video.sp-video')).toBeTruthy();
    expect(target.win.document.querySelector('.sp-stage')).toBeTruthy();
    expect(player.state.online).toBe(false);
    expect(player.state.error).not.toBe('');
    expect(target.win.document.body.textContent).toContain('تشغيل محلي دون اتصال');

    offline = false;
    player.retryEverything();
    await settle(target.win, target.clock, 200);
    expect(player.state.error).toBe('');
    expect(player.state.online).toBe(true);
  });

  it('clears a rejected credential and asks for pairing again when nothing is cached', async () => {
    const { buildFixture, createTransport: makeTransport } = await import('./player-harness');
    const fixture = buildFixture();
    const factory = new IDBFactory();

    // The screen was paired earlier but its credential was revoked in the admin app.
    const paired = page({ indexedDb: factory });
    const storage = await paired.runtime.createStorage(paired.win, { Promise: paired.win.Promise });
    await storage.setCredential('stale-credential');
    paired.dom.window.close();

    const plan = makeTransport(fixture, { manifestStatus: 500, heartbeatStatus: 401 });
    const target = page({ indexedDb: factory, transport: plan.transport });
    const player = await boot(target);
    await settle(target.win, target.clock, 200);

    expect(plan.calls.some((call) => call.url === '/api/player/heartbeat')).toBe(true);
    expect(await player.storage().getCredential()).toBeNull();
    expect(player.state.token).toBeNull();
    // Nothing is cached, so the TV must ask for a new pairing code rather than show an empty screen.
    expect(target.win.document.querySelector('#signage-pair-code')).toBeTruthy();
    expect(target.win.document.querySelector('.sp-stage')).toBeTruthy();
  });
});

describe('offline cold start', () => {
  it('plays cached media with the network completely down, without a blank screen', async () => {
    const { buildFixture } = await import('./player-harness');
    const fixture = buildFixture();
    const factory = new IDBFactory();
    const plan = createTransport(fixture);

    const first = page({ indexedDb: factory, transport: plan.transport });
    const firstPlayer = await boot(first);
    setPairCode(first, 'ABCD-1234');
    await settle(first.win, first.clock, 400);
    expect(await firstPlayer.storage().countCachedAssets()).toBe(2);
    first.dom.window.close();

    // The TV reboots with no Wi-Fi: same persistent storage, every request fails.
    const offline = () => Promise.reject(Object.assign(new Error('offline'), { code: 'network_error' }));
    const second = page({ indexedDb: factory, transport: offline });
    const secondPlayer = await boot(second);
    await settle(second.win, second.clock, 200);

    expect(secondPlayer.storage().backend).toBe('indexeddb');
    expect(await secondPlayer.storage().getCredential()).toBe('credential-1');
    expect((await secondPlayer.storage().getActiveManifest()).manifestHash).toBe(fixture.manifest.manifestHash);

    const image: any = await waitFor(second.win, second.clock, () => Boolean(second.win.document.querySelector('img.sp-media, video.sp-video')))
      .then(() => second.win.document.querySelector('img.sp-media, video.sp-video'));
    expect(image).toBeTruthy();
    expect(image.getAttribute('src')).toContain('blob:');
    expect(second.win.document.body.textContent).toContain('تشغيل محلي دون اتصال');
    expect(second.win.document.getElementById('signage-fatal')).toBeNull();
    expect(secondPlayer.state.error).not.toBe('');
  });
});
