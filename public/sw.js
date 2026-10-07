/* The service worker caches only the player app shell and immutable app bundles.
   Signage media is stored separately in IndexedDB; APIs and signed media URLs are NEVER cached here. */
const CACHE_NAME = 'signage-player-shell-v1';
const SHELL_PATH = '/player';

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(SHELL_PATH, { cache: 'reload', credentials: 'same-origin' });
      if (response.ok) {
        const copy = response.clone();
        await cache.put(SHELL_PATH, copy);
        const html = await response.text();
        const assets = [...new Set((html.match(/\/_next\/static\/[A-Za-z0-9_./-]+/g) || []))];
        await Promise.all(assets.map(path => cache.add(path).catch(() => undefined)));
      }
    } catch { /* A failed install leaves the browser's regular app cache usable. */ }
    await cache.add('/manifest.webmanifest').catch(() => undefined);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('signage-player-shell-') && name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/storage/')) return;

  const isPlayerNavigation = request.mode === 'navigate' && (url.pathname === '/player' || url.pathname === '/player/');
  const isHashedBundle = url.pathname.startsWith('/_next/static/');
  const isManifest = url.pathname === '/manifest.webmanifest';
  if (!isPlayerNavigation && !isHashedBundle && !isManifest) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cacheKey = isPlayerNavigation ? SHELL_PATH : request;
    const cached = await cache.match(cacheKey, { ignoreSearch: isHashedBundle });
    if (cached) {
      if (!isPlayerNavigation) return cached;
      // App shell navigation is cache-first for offline TV restarts. Background refresh is best-effort.
      fetch(request).then(response => { if (response.ok) cache.put(SHELL_PATH, response.clone()); }).catch(() => undefined);
      return cached;
    }
    try {
      const response = await fetch(request);
      if (response.ok) cache.put(cacheKey, response.clone()).catch(() => undefined);
      return response;
    } catch (error) {
      if (isPlayerNavigation) {
        const fallback = await cache.match(SHELL_PATH);
        if (fallback) return fallback;
      }
      throw error;
    }
  })());
});
