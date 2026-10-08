/* Optional offline shell for the signage player.
 *
 * The player NEVER depends on this worker: media lives in IndexedDB, the runtime is four classic
 * scripts, and everything works when no service worker exists (webOS 3.5 has none at all).
 *
 * When a modern browser does register it, it only ever caches the /player shell document and the
 * four player scripts. APIs, storage URLs and signed media URLs are never cached here.
 */
const CACHE_NAME = 'signage-player-shell-v9';
const SHELL_PATH = '/player';
const PLAYER_ASSETS = ['/player/sha256.js', '/player/runtime.js', '/player/watchdog.js', '/player/player.js'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(SHELL_PATH, { cache: 'reload', credentials: 'same-origin' });
      if (!response.ok) throw new Error('player_shell_unavailable');
      await cache.put(SHELL_PATH, response.clone());
      // Do not install/activate a partial player update. A failed asset leaves the currently active
      // service worker and its previous shell cache untouched.
      await Promise.all(PLAYER_ASSETS.map(path => cache.add(new Request(path, { cache: 'reload' }))));
      cache.add(new Request('/manifest.webmanifest', { cache: 'reload' })).catch(() => undefined);
      await self.skipWaiting();
    } catch (error) {
      await caches.delete(CACHE_NAME).catch(() => undefined);
      throw error;
    }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    // Older shell caches may hold an outdated /player document: drop them only after the new worker
    // successfully installed every required script.
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
  const isPlayerAsset = PLAYER_ASSETS.indexOf(url.pathname) !== -1;
  const isManifest = url.pathname === '/manifest.webmanifest';
  if (!isPlayerNavigation && !isPlayerAsset && !isManifest) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    if (isPlayerNavigation) {
      // Network first: a fresh deployment must win whenever the television is online.
      try {
        const response = await fetch(request);
        if (response.ok) cache.put(SHELL_PATH, response.clone()).catch(() => undefined);
        return response;
      } catch (error) {
        const fallback = await cache.match(SHELL_PATH);
        if (fallback) return fallback;
        throw error;
      }
    }
    const cached = await cache.match(request, { ignoreSearch: isPlayerAsset });
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone()).catch(() => undefined);
    return response;
  })());
});
