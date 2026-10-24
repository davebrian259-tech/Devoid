// Devoid's service worker: the app's own files, served from one versioned cache. It makes the
// wallet open instantly, keeps working with no connection (the wallet itself is in this browser),
// and — the reason it caches whole versions rather than single files — guarantees a visitor never
// mixes modules from two builds, which would break the imports between them.
//
// scripts/build-site.mjs fills in the version and the file list when it builds dist/. The list is
// the app shell, a quarter of a megabyte, downloaded when this worker installs. The WebAssembly
// engine is 15 MB, so it is kept the first time it is actually used rather than up front, and the
// Sapling parameters are never cached (tens of megabytes, immutable, left to the browser's own
// cache). Nothing from the lightwalletd server is ever stored.
const VERSION = '__VERSION__';
const FILES = __FILES__;
const CACHE = `devoid-app-${VERSION}`;
const HOME = new URL('./', location).pathname;
const KEEP_ON_USE = /\/engine\/(?!params\/)/;  // the engine: too big to download before it is wanted

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('devoid-app-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

// The page asks for this when the visitor presses Reload on the "new version" nudge: the waiting
// worker takes over, and with it the whole new set of files at once.
self.addEventListener('message', (e) => { if (e.data === 'devoid-update') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(HOME)) return;  // the Zcash server, never
  if (url.pathname.includes('/engine/params/')) return;                          // big, immutable, left to the browser
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req.mode === 'navigate' ? HOME : req, { ignoreSearch: true });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && KEEP_ON_USE.test(url.pathname)) cache.put(req, res.clone()).catch(() => {});  // no room: carry on
    return res;
  })());
});
