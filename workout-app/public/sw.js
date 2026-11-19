// Service worker: makes the app installable and usable offline.
// Admin pages and admin API calls are never cached.
const SHELL = 'fl-shell-v1';
const RUNTIME = 'fl-runtime-v1';
const KEEP = [SHELL, RUNTIME, 'fl-saved-v1'];
const ASSETS = ['/', '/app.js', '/common.js', '/styles.css', '/manifest.webmanifest', '/icon.svg', '/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

async function networkFirst(req, cacheName) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(cacheName)).put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await caches.match(req);
    if (hit) return hit;
    throw err;
  }
}

async function staleWhileRevalidate(req) {
  const hit = await caches.match(req);
  const fresh = fetch(req).then(async (res) => {
    if (res.ok) (await caches.open(SHELL)).put(req, res.clone());
    return res;
  }).catch(() => hit);
  return hit || fresh;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/admin') || url.pathname.startsWith('/api/admin')) return; // never cache admin

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/')));
  } else if (url.pathname.startsWith('/api/')) {
    e.respondWith(networkFirst(req, RUNTIME));
  } else if (url.pathname.startsWith('/uploads/')) {
    // filenames are random and never change, so cache-first is safe
    e.respondWith(caches.match(req).then((hit) => hit || networkFirst(req, RUNTIME)));
  } else {
    e.respondWith(staleWhileRevalidate(req));
  }
});
