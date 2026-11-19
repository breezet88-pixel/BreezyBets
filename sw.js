// ApexBucks service worker. Build bc17577a8b.
const V = 'apexbucks-bc17577a8b';
const SHELL = ["./","index.html","manifest.webmanifest","logo.jpg","icons/icon-192.png","icons/icon-512.png","icons/icon-maskable-512.png","icons/apple-touch-icon-180.png"];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('apexbucks-') && k !== V && k !== 'apexbucks-fonts').map((k) => caches.delete(k))))
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
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open('apexbucks-fonts').then((c) => c.match(req).then((hit) => {
      const net = fetch(req).then((res) => { c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    })));
  }
});
