// Member app. Customers can: view workouts, read and add comments/reviews (signed in),
// and download (or save offline) today's workout of the day (signed in).
// Display only: every rule is enforced by the back end.
import { h, tokenStore, makeApi, restLabel, stars, assetUrl } from './common.js';

const app = document.getElementById('app');
const banner = document.getElementById('banner');
const store = tokenStore(localStorage, 'fl.token');
const api = makeApi(store);
const SAVED_KEY = 'fl.wod';
const IMG_CACHE = 'fl-saved-v1';

let me = null; // signed-in user, or null
let flash = ''; // one-time message shown on the next sign-in page
let verificationRequired = false; // does the server want customers to confirm their email first?

// ---------- small helpers ----------
function setBanner(msg) { banner.textContent = msg || ''; banner.hidden = !msg; }

function setTab(name) {
  for (const t of ['today', 'workouts', 'account']) document.getElementById(`tab-${t}`).classList.toggle('on', t === name);
}

function paintAccountTab() {
  document.getElementById('tab-account').textContent = me ? me.name.split(' ')[0] : 'Sign in';
}

const go = (hash) => { location.hash = hash; };

const needsVerify = () => !!(me && verificationRequired && !me.email_verified);

// Shown instead of the post/download buttons until the customer confirms their email.
function verifyNotice() {
  const status = h('p', { class: 'muted', role: 'status' });
  return h('div', { class: 'panel' },
    h('p', {}, h('strong', {}, 'Please confirm your email address.'), ` We sent a link to ${me.email}. Open it, then come back and refresh this page.`),
    h('div', { class: 'toolrow' }, h('button', { class: 'btn ghost small', onclick: async (e) => {
      e.target.disabled = true;
      try { await api('/api/auth/resend-verification', { method: 'POST', body: {} }); status.textContent = 'Sent again. Check your inbox and spam folder.'; }
      catch (err) { status.textContent = err.message; }
      e.target.disabled = false;
    } }, 'Send the email again')), status);
}

function meta(w) {
  const n = w.exercise_count ?? w.exercises?.length ?? 0;
  return [w.level, w.duration_min ? `${w.duration_min} min` : '', n ? `${n} exercise${n === 1 ? '' : 's'}` : '']
    .filter(Boolean).join(' · ');
}

function ratingLine(w) {
  return w.rating_count ? `★ ${w.rating_avg} (${w.rating_count} review${w.rating_count === 1 ? '' : 's'})` : 'No reviews yet';
}

function card(w) {
  const cover = w.cover || (w.exercises || []).find((e) => e.image)?.image;
  return h('a', { class: 'card', href: `#/w/${w.id}` },
    cover ? h('img', { src: assetUrl(cover), alt: '', loading: 'lazy' }) : h('div', { class: 'ph', 'aria-hidden': 'true' }, '🏋️'),
    h('div', { class: 'card-body' },
      h('h3', {}, w.title),
      w.category ? h('span', { class: 'chip static' }, w.category) : null,
      h('p', { class: 'muted' }, meta(w)),
      h('p', { class: 'muted' }, ratingLine(w))));
}

// ---------- today's workout: download / save offline (signed in only) ----------
function getSavedWod() { try { return JSON.parse(localStorage.getItem(SAVED_KEY) || 'null'); } catch { return null; } }

async function saveWodOffline(day, w) {
  if ('caches' in window) {
    const cache = await caches.open(IMG_CACHE);
    await Promise.all(w.exercises.filter((e) => e.image).map((e) => cache.add(assetUrl(e.image))));
  }
  try { localStorage.setItem(SAVED_KEY, JSON.stringify({ day, workout: w })); }
  catch { throw new Error('Your browser would not let us save on this device.'); }
}

async function downloadWod() {
  const res = await api.raw('/api/wod/download');
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'workout-of-the-day.html';
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function wodActions(day, w) {
  const status = h('p', { class: 'muted', role: 'status' });
  if (needsVerify()) return verifyNotice();
  if (!me) {
    return h('div', {},
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => go('#/account?next=' + encodeURIComponent(location.hash.slice(1) || '/')) }, 'Sign in to download today’s workout')),
      h('p', { class: 'muted' }, 'It’s free. You only need an account to download and to leave reviews.'));
  }
  const dl = h('button', { class: 'btn', onclick: async (e) => {
    e.target.disabled = true;
    status.textContent = 'Preparing your download…';
    try { await downloadWod(); status.textContent = 'Downloaded. Open the file on any device, or print it to PDF.'; }
    catch (err) { status.textContent = err.message; }
    e.target.disabled = false;
  } }, 'Download today’s workout');
  const saved = () => getSavedWod()?.day === day && getSavedWod()?.workout.id === w.id;
  const save = h('button', { class: 'btn ghost' });
  const paint = () => { save.textContent = saved() ? '✓ Saved for offline (tap to remove)' : 'Save for offline use'; };
  paint();
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      if (saved()) { localStorage.removeItem(SAVED_KEY); status.textContent = 'Removed from this device.'; }
      else { await saveWodOffline(day, w); status.textContent = 'Saved. Today’s workout now opens without internet.'; }
    } catch (err) { status.textContent = err.message; }
    save.disabled = false;
    paint();
  });
  return h('div', {}, h('div', { class: 'actions' }, dl, save), status);
}

// ---------- views ----------
async function todayView() {
  setTab('today');
  let day = '';
  let w = null;
  let offline = false;
  try {
    ({ day, workout: w } = await api('/api/wod'));
  } catch (e) {
    if (!e.offline) throw e;
    offline = true;
    const s = getSavedWod();
    if (s) { day = s.day; w = s.workout; }
  }
  setBanner(offline ? 'You are offline. Showing the workout you saved on this device.' : '');
  if (!w) {
    app.replaceChildren(h('h1', {}, 'Today’s workout'),
      h('p', { class: 'muted' }, offline ? 'Nothing saved on this device yet.' : 'The coach has not posted today’s workout yet. Check back soon, or browse all workouts.'),
      h('a', { class: 'btn ghost', href: '#/workouts' }, 'Browse workouts'));
    return;
  }
  const cover = w.exercises.find((e) => e.image)?.image;
  app.replaceChildren(
    h('p', { class: 'eyebrow' }, `Workout of the day · ${day}`),
    h('h1', {}, w.title),
    h('p', { class: 'muted' }, [w.category, meta(w), ratingLine(w)].filter(Boolean).join(' · ')),
    cover ? h('img', { class: 'hero', src: assetUrl(cover), alt: '' }) : null,
    w.description ? h('p', {}, w.description) : null,
    offline ? null : h('a', { class: 'btn ghost', href: `#/w/${w.id}` }, 'See all exercises & reviews'),
    offline ? exerciseList(w) : null,
    wodActions(day, w));
}

function exerciseList(w) {
  return h('ol', { class: 'exercises' }, w.exercises.map((e) => {
    const facts = [e.sets && e.reps ? `${e.sets} × ${e.reps}` : e.sets || e.reps, restLabel(e.rest_sec)].filter(Boolean).join(' · ');
    return h('li', { class: 'ex' },
      h('h2', {}, e.name),
      facts ? h('p', { class: 'facts' }, facts) : null,
      e.image ? h('img', { src: assetUrl(e.image), alt: `How to do ${e.name}`, loading: 'lazy' }) : null,
      e.muscles ? h('p', {}, h('b', {}, 'Muscles: '), e.muscles) : null,
      e.equipment ? h('p', {}, h('b', {}, 'Equipment: '), e.equipment) : null,
      e.cues ? h('p', {}, e.cues) : null);
  }));
}

async function listView() {
  setTab('workouts');
  setBanner('');
  let workouts;
  try { workouts = (await api('/api/workouts')).workouts; }
  catch (e) {
    if (!e.offline) throw e;
    app.replaceChildren(h('p', { class: 'pad' }, 'You are offline. Open the Today tab to see the workout you saved.'));
    return;
  }
  let query = '';
  let cat = '';
  const grid = h('div', { class: 'grid' });
  const cats = [...new Set(workouts.map((w) => w.category).filter(Boolean))].sort();
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Category' });
  const draw = () => {
    const q = query.toLowerCase();
    const shown = workouts.filter((w) => (!cat || w.category === cat) && (!q || `${w.title} ${w.category} ${w.level} ${w.description}`.toLowerCase().includes(q)));
    grid.replaceChildren(...(shown.length ? shown.map(card) : [h('p', { class: 'muted pad' }, workouts.length ? 'No workouts match.' : 'No workouts yet. Check back soon.')]));
    chips.replaceChildren(...['', ...cats].map((c) => h('button', { class: `chip${c === cat ? ' on' : ''}`, 'aria-pressed': c === cat ? 'true' : 'false', onclick: () => { cat = c; draw(); } }, c || 'All')));
  };
  app.replaceChildren(
    h('h1', { class: 'sr-only' }, 'All workouts'),
    h('div', { class: 'toolbar' },
      h('input', { type: 'search', placeholder: 'Search workouts', 'aria-label': 'Search workouts', oninput: (e) => { query = e.target.value; draw(); } }),
      cats.length ? chips : null),
    grid);
  draw();
}

function reviewForm(workoutId, youRated, onPosted) {
  const status = h('p', { role: 'status', class: 'muted' });
  let rating = 0;
  const starBtns = [1, 2, 3, 4, 5].map((n) => h('button', {
    type: 'button', class: 'star', 'aria-label': `${n} star${n > 1 ? 's' : ''}`, 'aria-pressed': 'false',
    onclick: () => { rating = rating === n ? 0 : n; starBtns.forEach((b, i) => { b.textContent = i < rating ? '★' : '☆'; b.setAttribute('aria-pressed', String(i + 1 === rating)); }); },
  }, '☆'));
  const body = h('textarea', { maxlength: 1000, placeholder: youRated ? 'Add a comment' : 'Write a comment or review (optional if you pick stars)', 'aria-label': 'Your comment' });
  return h('form', { class: 'panel', onsubmit: async (e) => {
    e.preventDefault();
    status.textContent = 'Posting…';
    try {
      await api(`/api/workouts/${workoutId}/feedback`, { method: 'POST', body: { rating: rating || undefined, body: body.value } });
      onPosted();
    } catch (err) { status.textContent = err.message; }
  } },
  h('h3', {}, youRated ? 'Add a comment' : 'Leave a review or comment'),
  youRated ? null : h('div', { class: 'stars', role: 'group', 'aria-label': 'Star rating' }, starBtns),
  body,
  h('div', { class: 'toolrow' }, h('button', { class: 'btn', type: 'submit' }, 'Post')),
  status);
}

async function detailView(id) {
  setTab('workouts');
  setBanner('');
  let w;
  let wod = null;
  try {
    [{ workout: w }, wod] = await Promise.all([api(`/api/workouts/${id}`), api('/api/wod').catch(() => null)]);
  } catch (e) {
    app.replaceChildren(h('p', { class: 'pad' }, e.status === 404 ? 'This workout is no longer available.' : e.message), h('a', { class: 'pad', href: '#/workouts' }, '← All workouts'));
    return;
  }
  const fb = await api(`/api/workouts/${id}/feedback`).catch(() => ({ feedback: [], you_rated: false }));
  const isWod = wod?.workout?.id === w.id;

  const feedbackBox = h('section', { class: 'reviews' },
    h('h2', {}, 'Reviews & comments'),
    h('p', { class: 'muted' }, ratingLine(w)),
    needsVerify() ? verifyNotice() : me ? reviewForm(w.id, fb.you_rated, detailsRefresh)
      : h('p', {}, h('a', { href: `#/account?next=${encodeURIComponent(`/w/${w.id}`)}` }, 'Sign in'), ' to leave a review or comment.'),
    fb.feedback.length
      ? h('ul', { class: 'fb-list' }, fb.feedback.map((f) => h('li', {},
        h('div', {}, h('strong', {}, f.name), ' ', f.rating ? h('span', { class: 'stars-static', 'aria-label': `${f.rating} out of 5 stars` }, stars(f.rating)) : null,
          ' ', h('span', { class: 'muted' }, new Date(f.created_at).toLocaleDateString())),
        f.body ? h('p', {}, f.body) : null)))
      : h('p', { class: 'muted' }, 'Be the first to comment.'));

  function detailsRefresh() { detailView(id); }

  app.replaceChildren(
    h('a', { class: 'back', href: '#/workouts' }, '← All workouts'),
    h('article', { class: 'detail' },
      h('h1', {}, w.title),
      isWod ? h('p', { class: 'eyebrow' }, 'Today’s workout of the day') : null,
      h('p', { class: 'muted' }, [w.category, meta(w)].filter(Boolean).join(' · ')),
      w.description ? h('p', {}, w.description) : null,
      isWod ? wodActions(wod.day, w) : h('p', { class: 'muted note' }, 'Downloads are available for the workout of the day.'),
      exerciseList(w),
      feedbackBox));
}

function accountView(query) {
  setTab('account');
  setBanner('');
  const next = new URLSearchParams(query).get('next') || '/';
  if (me) {
    app.replaceChildren(h('h1', {}, `Hi, ${me.name}`), h('p', { class: 'muted' }, me.email),
      needsVerify() ? verifyNotice() : null,
      me.role === 'admin' ? h('p', {}, h('a', { href: '/admin' }, 'Open the coach page →')) : null,
      h('button', { class: 'btn ghost', onclick: async () => { await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {}); store.clear(); me = null; paintAccountTab(); go('#/'); } }, 'Sign out'));
    return;
  }
  let mode = 'login';
  const box = h('div');
  const notice = flash ? h('p', { class: 'banner', role: 'status' }, flash) : null;
  flash = '';
  const draw = () => {
    const status = h('p', { class: 'err', role: 'alert' });
    const name = h('input', { type: 'text', autocomplete: 'name', required: true, maxlength: 60 });
    const email = h('input', { type: 'email', autocomplete: 'email', required: true });
    const pw = h('input', { type: 'password', autocomplete: mode === 'login' ? 'current-password' : 'new-password', required: true, minlength: mode === 'login' ? 1 : 8 });
    const field = (label, input) => { const id = `a-${label.replace(/\W/g, '')}`; input.id = id; return h('div', { class: 'f' }, h('label', { for: id }, label), input); };
    box.replaceChildren(h('form', { class: 'panel', onsubmit: async (e) => {
      e.preventDefault();
      status.textContent = '';
      try {
        const r = await api(`/api/auth/${mode === 'login' ? 'login' : 'register'}`, { method: 'POST', body: { name: name.value, email: email.value, password: pw.value } });
        store.set(r.token);
        me = r.user;
        verificationRequired = !!r.verification_required;
        paintAccountTab();
        go(`#${next}`);
      } catch (err) { status.textContent = err.message; }
    } },
    h('h1', {}, mode === 'login' ? 'Sign in' : 'Create your account'),
    mode === 'login' ? null : field('Your name (shown with your reviews)', name),
    field('Email', email),
    field(mode === 'login' ? 'Password' : 'Password (at least 8 characters)', pw),
    mode === 'login' ? null : h('p', { class: 'muted' }, 'We keep your name and email only to run your account. Your email is never shown to other members.'),
    mode === 'login' ? h('p', {}, h('a', { href: '#/forgot' }, 'Forgot your password?')) : null,
    h('div', { class: 'toolrow' }, h('button', { class: 'btn', type: 'submit' }, mode === 'login' ? 'Sign in' : 'Create account'),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => { mode = mode === 'login' ? 'register' : 'login'; draw(); } }, mode === 'login' ? 'New here? Create an account' : 'I already have an account')),
    status));
  };
  draw();
  app.replaceChildren(notice, box);
}

function forgotView() {
  setTab('account');
  setBanner('');
  const email = h('input', { type: 'email', id: 'fe', autocomplete: 'email', required: true });
  const status = h('p', { role: 'status', class: 'muted' });
  app.replaceChildren(h('form', { class: 'panel', onsubmit: async (e) => {
    e.preventDefault();
    try {
      await api('/api/auth/forgot', { method: 'POST', body: { email: email.value } });
      status.textContent = 'If that email has an account, we have sent a link to choose a new password. It works for 1 hour. Check your spam folder too.';
    } catch (err) { status.textContent = err.message; }
  } },
  h('h1', {}, 'Forgot your password?'),
  h('p', { class: 'muted' }, 'Enter your email and we will send you a link to choose a new one.'),
  h('div', { class: 'f' }, h('label', { for: 'fe' }, 'Email'), email),
  h('div', { class: 'toolrow' }, h('button', { class: 'btn', type: 'submit' }, 'Send me the link'), h('a', { class: 'btn ghost', href: '#/account' }, 'Back to sign in')),
  status));
}

function resetView(query) {
  setTab('account');
  setBanner('');
  const token = new URLSearchParams(query).get('token') || '';
  const pw = h('input', { type: 'password', id: 'np', autocomplete: 'new-password', required: true, minlength: 8 });
  const status = h('p', { class: 'err', role: 'alert' });
  app.replaceChildren(h('form', { class: 'panel', onsubmit: async (e) => {
    e.preventDefault();
    try {
      await api('/api/auth/reset', { method: 'POST', body: { token, password: pw.value } });
      store.clear();
      me = null;
      paintAccountTab();
      flash = 'Password changed. Sign in with your new password.';
      go('#/account');
    } catch (err) { status.textContent = err.message; }
  } },
  h('h1', {}, 'Choose a new password'),
  h('div', { class: 'f' }, h('label', { for: 'np' }, 'New password (at least 8 characters)'), pw),
  h('div', { class: 'toolrow' }, h('button', { class: 'btn', type: 'submit' }, 'Change password')),
  status));
}

async function verifyView(query) {
  setTab('account');
  setBanner('');
  const token = new URLSearchParams(query).get('token') || '';
  app.replaceChildren(h('p', { class: 'pad' }, 'Confirming your email…'));
  try {
    await api('/api/auth/verify', { method: 'POST', body: { token } });
    if (store.get()) { try { me = (await api('/api/me')).user; } catch { /* signed out */ } }
    app.replaceChildren(h('h1', {}, 'Email confirmed ✓'), h('p', {}, 'You can now leave reviews and download the workout of the day.'),
      h('a', { class: 'btn', href: me ? '#/' : '#/account' }, me ? 'Go to today’s workout' : 'Sign in'));
  } catch (e) {
    app.replaceChildren(h('h1', {}, 'That link did not work'), h('p', {}, e.message), h('a', { class: 'btn ghost', href: '#/account' }, 'Sign in'));
  }
}

async function route() {
  const [hashPath, query = ''] = (location.hash || '#/').slice(1).split('?');
  let m;
  try {
    if ((m = hashPath.match(/^\/w\/(\d+)$/))) await detailView(Number(m[1]));
    else if (hashPath === '/workouts') await listView();
    else if (hashPath === '/account') accountView(query);
    else if (hashPath === '/forgot') forgotView();
    else if (hashPath === '/reset') resetView(query);
    else if (hashPath === '/verify') await verifyView(query);
    else await todayView();
  } catch (e) {
    console.error(e);
    app.replaceChildren(h('p', { class: 'pad' }, e.offline ? 'You are offline.' : 'Something went wrong. Please refresh.'));
  }
  window.scrollTo(0, 0);
}

async function init() {
  if (store.get()) {
    try { const r = await api('/api/me'); me = r.user; verificationRequired = !!r.verification_required; }
    catch (e) { if (e.status === 401) store.clear(); }
  }
  paintAccountTab();
  addEventListener('hashchange', route);
  route();
}
init();

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
