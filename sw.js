// Service worker: offline support for the tags app.
//
// Strategy map (see fetch handler):
//   navigations + /api/* GETs → network-first, cached copy as offline fallback
//     (keeps deploys instantly live; cache only serves when the network fails)
//   static assets (icons)     → cache-first
//   /api/admin/* and /cdn-cgi/* (Cloudflare Access) are NEVER intercepted:
//     their redirects and cookies must reach the network untouched.
//   Non-GET requests are never intercepted — a write must never fake success.
//
// Bump the version to invalidate every cached entry on next activate.
const CACHE = 'tags-app-v1';
const SHELL = ['/', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/admin') || url.pathname.startsWith('/cdn-cgi')) return;

  if (req.mode === 'navigate') {
    // The app is a single page — every navigation is the shell, cached as '/'.
    e.respondWith(netFirst(req, '/'));
  } else if (url.pathname.startsWith('/api/')) {
    e.respondWith(netFirst(req));
  } else {
    e.respondWith(cacheFirst(req));
  }
});

async function netFirst(req, cacheKey) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(cacheKey || req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(cacheKey || req);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}
