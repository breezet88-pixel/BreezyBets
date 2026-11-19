// Service worker: makes the app installable and keeps the shell, public workouts and
// pictures available offline. Anything private (sign-in, admin, downloads) is never cached.
importScripts('/config.js');
const API = new URL(globalThis.FL_API_URL || self.location.origin).origin;
const SHELL = 'fl-shell-v3';
const RUNTIME = 'fl-runtime-v3';
const KEEP = [SHELL, RUNTIME, 'fl-saved-v1'];
const ASSETS = ['/', '/config.js', '/app.js', '/common.js', '/styles.css', '/manifest.webmanifest', '/icon.svg', '/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(RUNTIME)).put(req, res.clone());
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

// The workout of the day is deliberately NOT cached here (it must never be a stale "today"):
// the app keeps its own saved copy for offline use.
const PUBLIC_API = /^\/api\/workouts(\/\d+)?$/;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET') return;

  if (url.origin === API) {
    if (url.pathname.startsWith('/uploads/')) {
      // picture filenames are random and never change, so cache-first is safe
      e.respondWith(caches.match(req).then((hit) => hit || networkFirst(req)));
    } else if (PUBLIC_API.test(url.pathname)) {
      e.respondWith(networkFirst(req));
    }
    return; // everything else on the API (accounts, downloads, admin) goes straight to the network
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/admin')) return; // never cache the coach page
  if (req.mode === 'navigate') e.respondWith(fetch(req).catch(() => caches.match('/')));
  else e.respondWith(staleWhileRevalidate(req));
});
