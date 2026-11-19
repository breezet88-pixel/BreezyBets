// ApexBucks service worker. Build 9d8ed4155b.
const V = 'apexbucks-9d8ed4155b';
const SHELL = ["./","index.html","manifest.webmanifest","logo.jpg","icons/icon-192.png","icons/icon-512.png","icons/icon-maskable-512.png","icons/apple-touch-icon-180.png"];
const EXT = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('apexbucks-') && k !== V && k !== 'apexbucks-ext').map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('message', (e) => { if (e.data === 'skip') self.skipWaiting(); });
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (req.mode === 'navigate') {
      e.respondWith(caches.match('index.html').then((r) => r || fetch(req)));
      return;
    }
    e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(V).then((c) => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  if (EXT.includes(url.hostname)) {
    // Fonts and the on-device photo reader: fetched once with CORS, then served from the cache.
    e.respondWith(caches.open('apexbucks-ext').then(async (c) => {
      const key = new Request(req.url, { mode: 'cors', credentials: 'omit' });
      const hit = await c.match(key);
      if (hit) return hit;
      try {
        const res = await fetch(key);
        if (res.ok) c.put(key, res.clone());
        return res;
      } catch (err) {
        return Response.error();
      }
    }));
  }
});
