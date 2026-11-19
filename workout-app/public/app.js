// Member app: browse workouts, save them for offline use, download them as a file.
// Display only: all workout content comes from the server.
import { h, api, restLabel } from './common.js';

const app = document.getElementById('app');
const banner = document.getElementById('banner');
const SAVED_KEY = 'fl.saved';
const IMG_CACHE = 'fl-saved-v1';

// ---------- saved-on-this-device store ----------
function getSaved() {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY) || '{}'); } catch { return {}; }
}
function setSaved(obj) {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(obj)); return true; } catch { return false; }
}
const imgUrl = (f) => `/uploads/${f}`;

async function saveOffline(w) {
  if ('caches' in window) {
    const cache = await caches.open(IMG_CACHE);
    await Promise.all(w.exercises.filter((e) => e.image).map((e) => cache.add(imgUrl(e.image))));
  }
  const all = getSaved();
  all[w.id] = w;
  if (!setSaved(all)) throw new Error('Your browser would not let us save on this device.');
}

async function removeSaved(w) {
  const all = getSaved();
  delete all[w.id];
  setSaved(all);
  if ('caches' in window) {
    const stillUsed = new Set(Object.values(all).flatMap((x) => x.exercises.map((e) => e.image)));
    const cache = await caches.open(IMG_CACHE);
    await Promise.all(w.exercises.filter((e) => e.image && !stillUsed.has(e.image)).map((e) => cache.delete(imgUrl(e.image))));
  }
}

// ---------- download as a self-contained file ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

async function downloadFile(w) {
  const pics = {};
  await Promise.all(w.exercises.filter((e) => e.image).map(async (e) => {
    const res = await fetch(imgUrl(e.image));
    if (res.ok) pics[e.image] = await toDataUrl(await res.blob());
  }));
  const meta = [w.category, w.level, w.duration_min ? `${w.duration_min} min` : ''].filter(Boolean).join(' · ');
  const rows = w.exercises.map((e, i) => {
    const facts = [e.sets && e.reps ? `${e.sets} × ${e.reps}` : e.sets || e.reps, restLabel(e.rest_sec)].filter(Boolean).join(' · ');
    return `<section><h2>${i + 1}. ${esc(e.name)}</h2>` +
      (facts ? `<p class="facts">${esc(facts)}</p>` : '') +
      (e.image && pics[e.image] ? `<img src="${pics[e.image]}" alt="How to do ${esc(e.name)}">` : '') +
      (e.muscles ? `<p><b>Muscles:</b> ${esc(e.muscles)}</p>` : '') +
      (e.equipment ? `<p><b>Equipment:</b> ${esc(e.equipment)}</p>` : '') +
      (e.cues ? `<p>${esc(e.cues)}</p>` : '') + '</section>';
  }).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(w.title)}</title>` +
    '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:720px;margin:0 auto;padding:20px;color:#111}h1{margin:0 0 4px}.meta{color:#555;margin:0 0 12px}' +
    'section{border-top:1px solid #ddd;padding:14px 0;break-inside:avoid}h2{margin:0 0 4px;font-size:1.15rem}.facts{font-weight:600;color:#0f766e;margin:0 0 8px}' +
    'img{max-width:100%;height:auto;border-radius:8px;border:1px solid #eee}p{margin:6px 0}</style></head><body>' +
    `<h1>${esc(w.title)}</h1><p class="meta">${esc(meta)}</p>${w.description ? `<p>${esc(w.description)}</p>` : ''}${rows}</body></html>`;
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const a = h('a', { href: url, download: `${w.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'workout'}.html` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------- views ----------
function setBanner(msg) {
  banner.textContent = msg || '';
  banner.hidden = !msg;
}

function setTab(name) {
  document.getElementById('tab-all').classList.toggle('on', name === 'all');
  document.getElementById('tab-saved').classList.toggle('on', name === 'saved');
}

function meta(w) {
  const n = w.exercise_count ?? w.exercises?.length ?? 0;
  return [w.level, w.duration_min ? `${w.duration_min} min` : '', n ? `${n} exercise${n === 1 ? '' : 's'}` : '']
    .filter(Boolean).join(' · ');
}

function card(w, saved) {
  const cover = w.cover || (w.exercises || []).find((e) => e.image)?.image;
  return h('a', { class: 'card', href: `#/w/${w.id}` },
    cover ? h('img', { src: imgUrl(cover), alt: '', loading: 'lazy' }) : h('div', { class: 'ph', 'aria-hidden': 'true' }, '🏋️'),
    h('div', { class: 'card-body' },
      h('h3', {}, w.title),
      w.category ? h('span', { class: 'chip static' }, w.category) : null,
      h('p', { class: 'muted' }, meta(w)),
      saved ? h('span', { class: 'saved-badge' }, '✓ Saved') : null));
}

async function listView({ onlySaved }) {
  setTab(onlySaved ? 'saved' : 'all');
  let workouts = [];
  let offline = false;
  const saved = getSaved();
  if (onlySaved) {
    workouts = Object.values(saved);
  } else {
    try {
      workouts = (await api('/api/workouts')).workouts;
    } catch {
      offline = true;
      workouts = Object.values(saved);
    }
  }
  setBanner(offline ? 'You are offline. Showing the workouts you saved on this device.' : '');

  let query = '';
  let cat = '';
  const grid = h('div', { class: 'grid' });
  const cats = [...new Set(workouts.map((w) => w.category).filter(Boolean))].sort();
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Category' });

  const draw = () => {
    const q = query.toLowerCase();
    const shown = workouts.filter((w) =>
      (!cat || w.category === cat) &&
      (!q || `${w.title} ${w.category} ${w.level} ${w.description}`.toLowerCase().includes(q)));
    grid.replaceChildren(...(shown.length
      ? shown.map((w) => card(w, !!saved[w.id]))
      : [h('p', { class: 'muted pad' }, onlySaved
        ? 'Nothing saved yet. Open a workout and tap “Save to this device”.'
        : workouts.length ? 'No workouts match.' : 'No workouts yet. Check back soon.')]));
    chips.replaceChildren(...['', ...cats].map((c) =>
      h('button', { class: `chip${c === cat ? ' on' : ''}`, 'aria-pressed': c === cat ? 'true' : 'false', onclick: () => { cat = c; draw(); } }, c || 'All')));
  };

  app.replaceChildren(
    h('h1', { class: 'sr-only' }, onlySaved ? 'Saved workouts' : 'All workouts'),
    h('div', { class: 'toolbar' },
      h('input', { type: 'search', placeholder: 'Search workouts', 'aria-label': 'Search workouts', oninput: (e) => { query = e.target.value; draw(); } }),
      cats.length ? chips : null),
    grid);
  draw();
}

async function detailView(id) {
  setTab('');
  let w;
  let offline = false;
  const saved = getSaved();
  try {
    w = (await api(`/api/workouts/${id}`)).workout;
    // keep the saved copy fresh when we're online
    if (saved[id] && saved[id].updated_at !== w.updated_at) saveOffline(w).catch(() => {});
  } catch (e) {
    if (e.status === 404) {
      if (saved[id]) { delete saved[id]; setSaved(saved); }
      app.replaceChildren(h('p', { class: 'pad' }, 'This workout is no longer available. '), h('a', { class: 'pad', href: '#/' }, '← Back to all workouts'));
      return;
    }
    w = saved[id];
    offline = true;
  }
  if (!w) {
    app.replaceChildren(h('p', { class: 'pad' }, 'You are offline and this workout is not saved on this device. '), h('a', { class: 'pad', href: '#/' }, '← Back'));
    return;
  }
  setBanner(offline ? 'You are offline. Showing your saved copy.' : '');

  const status = h('p', { class: 'muted', role: 'status' });
  const isSaved = () => !!getSaved()[w.id];
  const saveBtn = h('button', { class: 'btn' });
  const paintSave = () => { saveBtn.textContent = isSaved() ? '✓ Saved on this device (tap to remove)' : 'Save to this device'; };
  paintSave();
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      if (isSaved()) { await removeSaved(w); status.textContent = 'Removed from this device.'; }
      else { await saveOffline(w); status.textContent = 'Saved. You can open it without internet.'; }
    } catch (e) { status.textContent = e.message || 'Could not save. Check your connection and try again.'; }
    saveBtn.disabled = false;
    paintSave();
  });
  const dlBtn = h('button', { class: 'btn ghost', onclick: async (ev) => {
    ev.target.disabled = true;
    status.textContent = 'Preparing your download…';
    try { await downloadFile(w); status.textContent = 'Downloaded. Open the file on any device, or print it to PDF.'; }
    catch { status.textContent = 'Could not download. Check your connection and try again.'; }
    ev.target.disabled = false;
  } }, 'Download file');

  app.replaceChildren(
    h('a', { class: 'back', href: '#/' }, '← All workouts'),
    h('article', { class: 'detail' },
      h('h1', {}, w.title),
      h('p', { class: 'muted' }, [w.category, meta(w)].filter(Boolean).join(' · ')),
      w.description ? h('p', {}, w.description) : null,
      h('div', { class: 'actions' }, saveBtn, dlBtn),
      status,
      h('ol', { class: 'exercises' }, w.exercises.map((e) => {
        const facts = [e.sets && e.reps ? `${e.sets} × ${e.reps}` : e.sets || e.reps, restLabel(e.rest_sec)].filter(Boolean).join(' · ');
        return h('li', { class: 'ex' },
          h('h2', {}, e.name),
          facts ? h('p', { class: 'facts' }, facts) : null,
          e.image ? h('img', { src: imgUrl(e.image), alt: `How to do ${e.name}`, loading: 'lazy' }) : null,
          e.muscles ? h('p', {}, h('b', {}, 'Muscles: '), e.muscles) : null,
          e.equipment ? h('p', {}, h('b', {}, 'Equipment: '), e.equipment) : null,
          e.cues ? h('p', {}, e.cues) : null);
      }))));
}

async function route() {
  const hash = location.hash || '#/';
  let m;
  try {
    if ((m = hash.match(/^#\/w\/(\d+)$/))) await detailView(Number(m[1]));
    else if (hash === '#/saved') await listView({ onlySaved: true });
    else await listView({ onlySaved: false });
  } catch (e) {
    console.error(e);
    app.replaceChildren(h('p', { class: 'pad' }, 'Something went wrong. Please refresh.'));
  }
  window.scrollTo(0, 0);
}
addEventListener('hashchange', route);
route();

// ---------- install + offline ----------
const installBtn = document.getElementById('install');
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let deferred;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; installBtn.hidden = false; });
addEventListener('appinstalled', () => { installBtn.hidden = true; });
if (ios && !standalone) installBtn.hidden = false;
installBtn.addEventListener('click', async () => {
  if (deferred) { deferred.prompt(); await deferred.userChoice; deferred = null; installBtn.hidden = true; }
  else setBanner('To install on iPhone or iPad: tap the Share button, then “Add to Home Screen”.');
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
