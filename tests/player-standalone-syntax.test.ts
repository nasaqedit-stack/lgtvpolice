/*
 * Syntax and asset contract of the standalone TV player.
 *
 * The whole point of the standalone runtime is that Chromium 38 (webOS 3.5) can parse and run it.
 * These tests fail the build if any modern syntax, modern global or module-script assumption leaks
 * back into the files that are actually served to the TV.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
import { describe, expect, it } from 'vitest';
import { GET as getPlayerRoute } from '../app/player/route';
import { PLAYER_ASSETS, PLAYER_VERSION, renderPlayerShell } from '../lib/player/standalone/shell';

const PLAYER_DIR = path.join(process.cwd(), 'public', 'player');
const SCRIPT_FILES = ['sha256.js', 'runtime.js', 'player.js'] as const;

function readScript(name: string): string {
  return readFileSync(path.join(PLAYER_DIR, name), 'utf8');
}

/**
 * Removes comments using acorn's own ranges, so prose in a comment can never trip a style rule
 * (and a banned token in real code still can).
 */
function stripComments(code: string): string {
  const ranges: Array<{ start: number; end: number }> = [];
  try {
    acorn.parse(code, {
      ecmaVersion: 5,
      onComment: (_block: boolean, _text: string, start: number, end: number) => { ranges.push({ start, end }); }
    });
  } catch {
    return code;
  }
  let out = code;
  for (const range of ranges.reverse()) {
    out = out.slice(0, range.start) + ' '.repeat(Math.max(0, range.end - range.start)) + out.slice(range.end);
  }
  return out;
}

/** Constructs Chromium 38 cannot parse or has no implementation for, in any context. */
const BANNED_SYNTAX: Array<{ name: string; pattern: RegExp }> = [
  { name: 'arrow function', pattern: /=>/ },
  { name: 'optional chaining (Chrome 80+)', pattern: /\?\.[A-Za-z_$[(]/ },
  { name: 'nullish coalescing (Chrome 80+)', pattern: /\?\?/ },
  { name: 'logical assignment (Chrome 85+)', pattern: /\|\|=|&&=|\?\?=/ },
  { name: 'let/const declaration', pattern: /\b(let|const)\s+[A-Za-z_$[]/ },
  { name: 'class declaration', pattern: /\bclass\s+[A-Za-z_$]/ },
  { name: 'template literal', pattern: /`/ },
  { name: 'spread/rest syntax', pattern: /\.\.\./ },
  { name: 'for..of statement', pattern: /\bfor\s*\(\s*(var|let|const)?\s*[A-Za-z_$]+\s+of\s/ },
  { name: 'destructuring declaration', pattern: /\b(var|let|const)\s*[{[][^}]*}\s*=/ }
];

const BANNED_RUNTIME_APIS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'globalThis', pattern: /globalThis/ },
  { name: 'Object.assign', pattern: /Object\.assign\(/ },
  { name: 'Array.from', pattern: /Array\.from\(/ },
  { name: 'Array.prototype.includes', pattern: /\.includes\(/ },
  { name: 'Array.prototype.at', pattern: /\.at\(/ },
  { name: 'Number.isFinite', pattern: /Number\.isFinite\(/ },
  { name: 'Object.fromEntries', pattern: /Object\.fromEntries\(/ },
  { name: 'String.padStart/padEnd', pattern: /\.pad(Start|End)\(/ },
  { name: 'String.replaceAll', pattern: /\.replaceAll\(/ },
  { name: 'Promise.finally/allSettled/any', pattern: /Promise\.(finally|allSettled|any)\b/ },
  { name: 'Map/Set construction', pattern: /new (Map|Set|WeakMap|WeakSet)\(/ },
  { name: 'structuredClone', pattern: /structuredClone\(/ },
  { name: 'dynamic import()', pattern: /[^.]\bimport\s*\(/ },
  { name: 'AbortController construction', pattern: /new AbortController\(/ },
  { name: 'AbortSignal', pattern: /AbortSignal/ },
  { name: 'ReadableStream construction', pattern: /new ReadableStream\(/ },
  { name: 'ReadableStream reader', pattern: /\.getReader\(/ },
  { name: 'BroadcastChannel construction', pattern: /new BroadcastChannel\(/ },
  { name: 'ResizeObserver construction', pattern: /new ResizeObserver\(/ },
  { name: 'IntersectionObserver construction', pattern: /new IntersectionObserver\(/ },
  { name: 'MediaSource usage', pattern: /new (MediaSource|WebKitMediaSource)\(/ },
  { name: 'module syntax', pattern: /^\s*(export|import)\s/m }
];

describe('player scripts are ES5', () => {
  for (const file of SCRIPT_FILES) {
    it(`${file} parses with acorn at ecmaVersion 5`, () => {
      const code = readScript(file);
      expect(code.length).toBeGreaterThan(100);
      expect(() => acorn.parse(code, { ecmaVersion: 5 })).not.toThrow();
    });

    it(`${file} avoids syntax newer than Chromium 38 accepts`, () => {
      const code = stripComments(readScript(file));
      for (const rule of BANNED_SYNTAX) {
        const match = rule.pattern.exec(code);
        const context = match ? code.slice(Math.max(0, match.index - 60), match.index + 60) : '';
        expect(match, `${file} uses ${rule.name} near: ${context}`).toBeNull();
      }
    });

    it(`${file} avoids APIs that do not exist on Chromium 38`, () => {
      const code = stripComments(readScript(file));
      for (const rule of BANNED_RUNTIME_APIS) {
        const match = rule.pattern.exec(code);
        const context = match ? code.slice(Math.max(0, match.index - 60), match.index + 60) : '';
        expect(match, `${file} uses ${rule.name} near: ${context}`).toBeNull();
      }
    });
  }

  it('the runtime delegates hashing to the shipped sha256 module (Blob.arrayBuffer is not assumed)', () => {
    const runtime = stripComments(readScript('runtime.js'));
    expect(runtime).toContain('SignageSha256');
    expect(runtime).toContain('readAsArrayBuffer');
    const sha = stripComments(readScript('sha256.js'));
    expect(sha).toContain('create');
    expect(sha).toContain('digestHex');
  });

  it('falls back to muted autoplay and reuses a persistent video element', () => {
    const runtime = stripComments(readScript('runtime.js'));
    expect(runtime).toContain('function createVideoElement()');
    expect(runtime).toContain('if (state.videoElement) return state.videoElement;');
    expect(runtime).toMatch(/setAttribute\(['"]muted/);
    expect(runtime).toMatch(/video\.muted\s*=\s*true/);
    expect(runtime).toContain('video_auto_resume');
  });
});

describe('the /player shell document', () => {
  const html = renderPlayerShell();

  it('references no Next.js or module-script assets', () => {
    expect(html).not.toContain('/_next/');
    expect(html).not.toContain('type="module"');
    expect(html).not.toContain('nomodule');
    expect(html).not.toContain('crossorigin');
    expect(html).not.toContain('react');
  });

  it('loads the three classic scripts with a cache-busting version', () => {
    for (const asset of PLAYER_ASSETS) {
      expect(html).toContain(`${asset}?v=${PLAYER_VERSION}`);
    }
    const srcs = Array.from(html.matchAll(/<script[^>]*src="([^"]+)"/g)).map((match) => match[1]);
    expect(srcs).toHaveLength(PLAYER_ASSETS.length);
    expect(srcs.every((src) => src.startsWith('/player/'))).toBe(true);
  });

  it('paints an automatic-recovery status without a manual link before scripts run', () => {
    expect(html).toContain('مشغل الشاشة');
    expect(html).toContain('جارٍ تشغيل المشغل…');
    expect(html).toContain('يحاول المشغل استعادة ملفات التشغيل تلقائياً');
    expect(html).not.toContain('<a ');
    expect(html).toContain('<noscript>');
  });

  it('contains the automatic-recovery message with runtime diagnostics', () => {
    expect(html).toContain('المشغل يحاول استعادة التشغيل تلقائياً');
    expect(html).toContain('id="signage-fatal-reason"');
    expect(html).toContain('id="signage-fatal-ua"');
    expect(html).toContain('__signageGuard');
    expect(html).toContain('__signageBooted');
  });

  it('forces fullscreen cover sizing without introducing browser-new CSS', () => {
    expect(html).toContain('.sp-media, .sp-video {');
    expect(html).toMatch(/\.sp-media, \.sp-video \{[^}]*position: fixed;[^}]*top: 0;[^}]*left: 0;[^}]*width: 100vw;[^}]*height: 100vh/s);
    expect(html).toMatch(/\.sp-media, \.sp-video \{[^}]*margin: 0;[^}]*padding: 0;[^}]*border: 0;[^}]*object-fit: cover;/s);
    expect(html).toMatch(/\.sp-media, \.sp-video \{[^}]*opacity: 1;[^}]*visibility: visible;[^}]*filter: none;/s);
    expect(html).not.toContain('rgba(5, 10, 18, .82)');
  });

  it('uses only CSS that Chromium 38 understands', () => {
    const css = html.split('<style>')[1].split('</style>')[0];
    const banned = [
      { name: 'CSS custom properties', pattern: /var\(--/ },
      { name: 'grid layout', pattern: /display:\s*grid/ },
      { name: 'flex gap', pattern: /[^-]gap:\s*\d/ },
      { name: 'min()/max()/clamp()', pattern: /\b(min|max|clamp)\(/ },
      { name: 'logical inset shorthand', pattern: /\binset:\s/ },
      { name: 'aspect-ratio', pattern: /aspect-ratio/ },
      { name: 'position: sticky', pattern: /position:\s*sticky/ }
    ];
    for (const rule of banned) {
      const match = rule.pattern.exec(css);
      const context = match ? css.slice(Math.max(0, match.index - 50), match.index + 50) : '';
      expect(match, `shell CSS uses ${rule.name} near: ${context}`).toBeNull();
    }
  });

  it('keeps every inline script ES5-parseable', () => {
    const inlineBlocks = Array.from(html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)).map((match) => match[1]);
    expect(inlineBlocks.length).toBeGreaterThan(0);
    for (const block of inlineBlocks) {
      expect(() => acorn.parse(block, { ecmaVersion: 5 })).not.toThrow();
      expect(block).not.toContain('=>');
      expect(block).not.toContain('`');
      expect(block).not.toMatch(/\b(const|let)\s/);
    }
    const attributeHandlers = Array.from(html.matchAll(/onerror="([^"]*)"/g)).map((match) => match[1]);
    for (const handler of attributeHandlers) {
      expect(() => acorn.parse(handler, { ecmaVersion: 5 })).not.toThrow();
    }
  });

  it('arms a boot guard so a failed script cannot leave a blank screen', () => {
    const guard = /__signageGuard\('the player did not report readiness/.exec(html);
    expect(guard).not.toBeNull();
    expect(html).toContain("if (w.__signageBooted) return;");
    const errorHandlers = Array.from(html.matchAll(/onerror="([^"]*)"/g)).map((match) => match[1]);
    expect(errorHandlers.length).toBe(PLAYER_ASSETS.length);
    expect(errorHandlers.every((handler) => handler.includes('__signageGuard'))).toBe(true);
  });
});

describe('the deployed /player document', () => {
  // `npm run build` writes the prerendered page here; the deploy check only runs after a build.
  const builtPath = path.join(process.cwd(), '.next', 'server', 'app', 'player.body');
  const built = existsSync(builtPath) ? readFileSync(builtPath, 'utf8') : null;

  it.skipIf(!built)('ships no Next.js or module scripts to the TV', () => {
    expect(built).not.toContain('/_next/');
    expect(built).not.toContain('type="module"');
    expect(built).not.toContain('nomodule');
    const srcs = Array.from(built!.matchAll(/<script[^>]*src="([^"]+)"/g)).map((match) => match[1]);
    expect(srcs).toEqual(PLAYER_ASSETS.map((asset) => `${asset}?v=${PLAYER_VERSION}`));
  });

  it.skipIf(!built)('has every inline script parseable as ES5', () => {
    const inline = Array.from(built!.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)).map((match) => match[1]);
    expect(inline.length).toBeGreaterThan(0);
    for (const block of inline) {
      expect(() => acorn.parse(block, { ecmaVersion: 5 })).not.toThrow();
    }
  });

  it.skipIf(!built)('keeps the visible auto-recovery boot panel before any script runs', () => {
    expect(built).toContain('جارٍ تشغيل المشغل…');
    expect(built).toContain('يحاول المشغل استعادة ملفات التشغيل تلقائياً');
    expect(built).not.toContain('<a ');
    expect(built).toContain('id="signage-fatal"');
  });
});

describe('the optional offline shell (service worker)', () => {
  const sw = readFileSync(path.join(process.cwd(), 'public', 'sw.js'), 'utf8');

  it('never touches APIs, storage URLs or older shell caches', () => {
    expect(sw).toContain("signage-player-shell-v4");
    expect(sw).toContain("name.startsWith('signage-player-shell-')");
    expect(sw).toContain("url.pathname.startsWith('/api/')");
    expect(sw).toContain("url.pathname.startsWith('/storage/')");
    expect(sw).not.toContain('/_next/static/');
  });

  it('serves /player navigations network-first with a cached fallback', () => {
    const navigation = sw.slice(sw.indexOf('if (isPlayerNavigation) {'), sw.indexOf('const cached = await cache.match(request'));
    expect(navigation.indexOf('await fetch(request)')).toBeGreaterThan(-1);
    expect(navigation.indexOf('await fetch(request)')).toBeLessThan(navigation.indexOf('cache.match(SHELL_PATH)'));
  });

  it('is registered by the shell only as a best-effort extra', () => {
    const html = renderPlayerShell();
    expect(html).toContain("serviceWorker.register('/sw.js'");
    expect(html).toContain('} catch (e) { }');
    expect(html).not.toContain('navigator.serviceWorker.register(/sw.js'); // never unconditional
  });
});

describe('the /player route response', () => {
  it('serves the shell document as HTML with a TV-friendly cache policy', async () => {
    const response = getPlayerRoute();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const cacheControl = response.headers.get('cache-control') || '';
    expect(cacheControl).toContain('max-age=300');
    expect(cacheControl).toContain('stale-if-error=604800');
    const body = await response.text();
    expect(body).toContain('/player/runtime.js?v=' + PLAYER_VERSION);
    expect(body).toContain('المشغل يحاول استعادة التشغيل تلقائياً');
  });

  it('never removes the security headers the rest of the site relies on', () => {
    // The route only sets content type and cache policy: next.config.ts keeps adding the global
    // security headers (HSTS, nosniff, frame options) to every response including this one.
    const config = readFileSync(path.join(process.cwd(), 'next.config.ts'), 'utf8');
    expect(config).toContain("key: 'X-Content-Type-Options'");
    expect(config).toContain("key: 'Strict-Transport-Security'");
    expect(config).toContain("source: '/:path*'");
  });
});
