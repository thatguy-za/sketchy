// Sketchy's service worker (the build copies this file to dist/sw.js and fills in the version and the file list). It keeps the app
// shell and the hashed build files (the 23 MB CAD kernel among them) so a repeat visit starts at once and the app opens offline.
// What it never touches: /api, /mcp, OAuth, the add-in sandbox page and the add-in files, anything with an Authorization header, any
// response that is not a plain 200 from this origin, and any response that asks not to be stored. Designs and sessions are never cached.
const VERSION = '__SW_VERSION__';
const PRECACHE = __SW_PRECACHE__;
const CACHE = 'sketchy-' + VERSION;
const NEVER = [/^\/api(\/|$)/, /^\/mcp(\/|$)/, /^\/oauth/, /^\/\.well-known\//, /^\/addin-sandbox\.html$/, /^\/addins(\/|$)/, /^\/sw\.js$/];

const cacheable = (res) => res && res.status === 200 && res.type === 'basic' && !res.headers.has('set-cookie') && !/no-store|private/i.test(res.headers.get('cache-control') || '');

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(PRECACHE.map(async (url) => { const res = await fetch(new Request(url, { cache: 'reload' })); if (!cacheable(res)) throw new Error('not cacheable: ' + url); await cache.put(url, res); }));
    await self.skipWaiting(); // a new version takes over as soon as it has everything
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const old = (await caches.keys()).filter((k) => k.startsWith('sketchy-') && k !== CACHE);
    await Promise.all(old.map((k) => caches.delete(k)));
    await self.clients.claim();
    if (old.length) for (const c of await self.clients.matchAll()) c.postMessage({ type: 'sketchy-updated', version: VERSION }); // open pages are told to reload
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || req.headers.has('authorization') || req.headers.has('range')) return;
  if (NEVER.some((re) => re.test(url.pathname))) return;
  if (req.mode === 'navigate') { // the page: the network first (an upgrade shows up at once), the kept copy when offline
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (url.pathname === '/' && cacheable(res)) { const c = await caches.open(CACHE); await c.put('/', res.clone()); }
        return res;
      } catch (err) { const hit = await caches.match('/', { cacheName: CACHE }); if (hit) return hit; throw err; }
    })());
    return;
  }
  if (url.pathname.startsWith('/assets/')) { // hashed build files never change: the kept copy first
    e.respondWith((async () => {
      const c = await caches.open(CACHE), hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (cacheable(res)) await c.put(req, res.clone());
      return res;
    })());
  }
});
