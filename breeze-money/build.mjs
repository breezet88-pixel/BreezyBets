// Builds the installable ApexBucks web app (PWA) from index.html. No dependencies.
//   node breeze-money/build.mjs      ->  breeze-money/dist/  (upload that folder to any static host)
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'icons'), { recursive: true });

const src = readFileSync(join(here, 'index.html'), 'utf8');
const logo = readFileSync(join(here, 'logo.jpg'));
const cut = src.indexOf('<div class="app" id="app">');
if (cut < 0) throw new Error('App root not found in index.html');

// Everything before the app root is head material (title, fonts, styles); the rest is the body.
const head = src.slice(0, cut)
  .replace(/<meta name="claude:viewport-fit-sides"[^>]*>\n?/, '')
  .replace(/<link rel="icon"[^>]*>\n?/, '');
const body = src.slice(cut);

const build = createHash('sha256').update(src).update(logo).digest('hex').slice(0, 10);

const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" type="image/png" href="icons/icon-192.png">
<link rel="apple-touch-icon" href="icons/apple-touch-icon-180.png">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="ApexBucks">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<style>:root{padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px);color-scheme:light}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>
${head}</head>
<body>
${body}
</body>
</html>
`;
writeFileSync(join(out, 'index.html'), doc);

writeFileSync(join(out, 'manifest.webmanifest'), JSON.stringify({
  id: './',
  name: 'ApexBucks',
  short_name: 'ApexBucks',
  description: 'Class income, salary, expenses and savings in one place.',
  start_url: './',
  scope: './',
  display: 'standalone',
  background_color: '#0c0c0e',
  theme_color: '#0c0c0e',
  icons: [
    { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}, null, 2));

const shell = ['./', 'index.html', 'manifest.webmanifest', 'logo.jpg',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon-180.png'];
writeFileSync(join(out, 'sw.js'), `// ApexBucks service worker. Build ${build}.
const V = 'apexbucks-${build}';
const SHELL = ${JSON.stringify(shell)};
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
`);

cpSync(join(here, 'logo.jpg'), join(out, 'logo.jpg'));
for (const f of readdirSync(join(here, 'icons'))) cpSync(join(here, 'icons', f), join(out, 'icons', f));
writeFileSync(join(out, '.nojekyll'), '');
console.log('Built ApexBucks', build, '->', out);
