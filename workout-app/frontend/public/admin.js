// Coach page. The only place anything can be added, edited or removed:
// workouts + exercises + pictures, the workout-of-the-day schedule, reviews/comments and customers.
// (The back end refuses every one of these calls unless you are signed in as the admin.)
import { h, tokenStore, makeApi, stars, assetUrl } from './common.js';

const app = document.getElementById('app');
const tabs = document.getElementById('admin-tabs');
const store = tokenStore(sessionStorage, 'fl.admin'); // signed out when the tab closes
const api = makeApi(store);
const STYLE_KEY = 'fl.imageStyle';

const DEFAULT_STYLE =
  'Clean flat vector illustration in a consistent style: one gender-neutral athlete with a plain face, dark grey fitted sportswear, ' +
  'solid white background, soft ground shadow, teal (#0f766e) used only to highlight the working muscles. ' +
  'The same character, same line weight and same colours in every image of this series.';

const getStyle = () => { try { return localStorage.getItem(STYLE_KEY) || DEFAULT_STYLE; } catch { return DEFAULT_STYLE; } };
const setStyle = (v) => { try { localStorage.setItem(STYLE_KEY, v); } catch { /* ignore */ } };

// The prompt you paste into your AI image tool for one exercise.
function buildPrompt(ex, style) {
  return [
    `Instructional fitness illustration showing ONE athlete performing "${ex.name || 'the exercise'}"${ex.equipment ? ` using ${ex.equipment}` : ''}.`,
    'Two panels side by side, same athlete and same camera angle in both: LEFT = starting position, RIGHT = finishing position (peak of the movement). ' +
      'Use a side view unless the movement is clearer from the front. Full body in frame, 4:3 landscape.',
    ex.muscles ? `Softly highlight the working muscles: ${ex.muscles}.` : '',
    ex.cues ? `Correct form to show: ${ex.cues}` : '',
    'Anatomically correct proportions, natural joint angles, neutral spine, exactly two arms and two legs, correct number of fingers. ' +
      'No text, no labels, no arrows, no watermark, no extra equipment or people.',
    `Style: ${style}`,
  ].filter(Boolean).join('\n');
}

function say(el, msg, bad) { el.textContent = msg; el.className = bad ? 'err' : 'muted'; }
const when = (iso) => new Date(iso).toLocaleString();

function field(label, input) {
  const id = `f${Math.random().toString(36).slice(2, 8)}`;
  input.id = id;
  return h('div', {}, h('label', { for: id }, label), input);
}

// ---------- sign in ----------
function loginView() {
  tabs.hidden = true;
  const msg = h('p', { class: 'err', role: 'alert' });
  const username = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  app.replaceChildren(h('form', { class: 'panel', onsubmit: async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/auth/login', { method: 'POST', body: { login: username.value, password: pw.value } });
      if (r.user.role !== 'admin') {
        await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
        msg.textContent = 'That account is not the coach account.';
        return;
      }
      store.set(r.token);
      location.hash = '#/workouts';
      route();
    } catch (err) { msg.textContent = err.message; }
  } },
  h('h1', {}, 'Coach sign in'), field('Username', username), field('Password', pw),
  h('div', { class: 'toolrow' }, h('button', { class: 'btn', type: 'submit' }, 'Sign in')), msg));
  username.focus();
}

// ---------- workouts ----------
async function workoutsView() {
  const [{ workouts }, { today, schedule }] = await Promise.all([api('/api/admin/workouts'), api('/api/admin/wod')]);
  const todays = schedule.find((s) => s.day === today);
  const status = h('p', { role: 'status', class: 'muted' });
  app.replaceChildren(
    h('div', { class: 'list-item' }, h('h1', {}, 'Workouts'), h('a', { class: 'btn', href: '#/workouts/new' }, '+ New workout')),
    todays ? h('p', { class: 'muted' }, `Today’s workout of the day: ${todays.title}${todays.published ? '' : ' (still a draft, so members cannot see it)'}`) : h('p', { class: 'muted' }, 'No workout of the day set for today.'),
    status,
    h('div', { class: 'panel' }, workouts.length
      ? workouts.map((w) => h('div', { class: 'list-item' },
        h('div', {}, h('strong', {}, w.title), ' ', h('span', { class: `tag${w.published ? '' : ' draft'}` }, w.published ? 'Published' : 'Draft'),
          h('div', { class: 'muted' }, `${w.exercise_count} exercises${w.category ? ` · ${w.category}` : ''}${w.rating_count ? ` · ★ ${w.rating_avg} (${w.rating_count})` : ''}`)),
        h('div', { class: 'toolrow' },
          h('button', { class: 'btn ghost small', onclick: async () => { try { await api(`/api/admin/wod/${today}`, { method: 'PUT', body: { workout_id: w.id } }); await workoutsView(); } catch (e) { say(status, e.message, true); } } }, 'Make today’s workout'),
          h('a', { class: 'btn ghost small', href: `#/workouts/${w.id}` }, 'Edit'),
          h('button', { class: 'btn danger small', onclick: async () => {
            if (!confirm(`Delete “${w.title}”? Its reviews and schedule entries are deleted too. This cannot be undone.`)) return;
            try { await api(`/api/admin/workouts/${w.id}`, { method: 'DELETE' }); await workoutsView(); } catch (e) { say(status, e.message, true); }
          } }, 'Delete'))))
      : h('p', { class: 'muted' }, 'No workouts yet. Tap “New workout”.')));
}

function editView(w) {
  const wk = JSON.parse(JSON.stringify(w));
  const status = h('p', { role: 'status', class: 'muted' });
  const exBox = h('div');
  const bind = (obj, key, el) => { el.addEventListener('input', () => { obj[key] = el.value; }); return el; };
  const text = (obj, key, attrs = {}) => bind(obj, key, h('input', { type: 'text', value: obj[key] ?? '', ...attrs }));
  const drawExercises = () => exBox.replaceChildren(...wk.exercises.map((ex, i) => exerciseCard(ex, i)));

  function exerciseCard(ex, i) {
    const preview = h('img', { class: 'thumb', alt: `${ex.name} preview`, hidden: !ex.image, src: ex.image ? assetUrl(ex.image) : undefined });
    const upStatus = h('p', { role: 'status', class: 'muted' });
    const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', onchange: async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      say(upStatus, 'Uploading…');
      try {
        const r = await api('/api/admin/upload', { method: 'POST', body: f });
        ex.image = r.file;
        preview.src = assetUrl(r.file);
        preview.hidden = false;
        say(upStatus, 'Picture added. Remember to save the workout.');
      } catch (err) { say(upStatus, err.message, true); }
    } });
    const promptBox = h('textarea', { readonly: true, rows: 9, 'aria-label': 'Image prompt' });
    const promptWrap = h('div', { hidden: true }, promptBox,
      h('div', { class: 'toolrow' }, h('button', { class: 'btn small', type: 'button', onclick: async () => {
        promptBox.select();
        try { await navigator.clipboard.writeText(promptBox.value); say(upStatus, 'Prompt copied. Paste it into your image tool.'); }
        catch { say(upStatus, 'Select the text and copy it.'); }
      } }, 'Copy prompt')));
    const move = (d) => () => {
      const j = i + d;
      if (j < 0 || j >= wk.exercises.length) return;
      [wk.exercises[i], wk.exercises[j]] = [wk.exercises[j], wk.exercises[i]];
      drawExercises();
    };
    return h('div', { class: 'panel' },
      h('div', { class: 'list-item' }, h('strong', {}, `Exercise ${i + 1}`),
        h('div', { class: 'toolrow' },
          h('button', { class: 'btn ghost small', type: 'button', 'aria-label': 'Move up', onclick: move(-1) }, '↑'),
          h('button', { class: 'btn ghost small', type: 'button', 'aria-label': 'Move down', onclick: move(1) }, '↓'),
          h('button', { class: 'btn danger small', type: 'button', onclick: () => { wk.exercises.splice(i, 1); drawExercises(); } }, 'Remove'))),
      h('div', { class: 'row' },
        field('Exercise name', text(ex, 'name', { required: true, maxlength: 120 })),
        field('Muscles worked', text(ex, 'muscles', { placeholder: 'Quads, glutes' })),
        field('Equipment', text(ex, 'equipment', { placeholder: 'Dumbbell, or none' }))),
      h('div', { class: 'row' },
        field('Sets', text(ex, 'sets', { placeholder: '3', maxlength: 20 })),
        field('Reps or time', text(ex, 'reps', { placeholder: '10-12 or 30 sec', maxlength: 40 })),
        field('Rest (seconds)', text(ex, 'rest_sec', { inputmode: 'numeric', placeholder: '60' }))),
      field('Form cues / instructions', bind(ex, 'cues', h('textarea', { maxlength: 1500, value: ex.cues || '' }))),
      h('div', { class: 'toolrow' }, h('button', { class: 'btn ghost small', type: 'button', onclick: () => { promptBox.value = buildPrompt(ex, getStyle()); promptWrap.hidden = false; } }, '✨ Create image prompt')),
      promptWrap,
      field('Exercise picture (from your image tool)', fileInput),
      preview,
      ex.image ? h('button', { class: 'btn danger small', type: 'button', onclick: () => { ex.image = ''; drawExercises(); } }, 'Remove picture') : null,
      upStatus);
  }

  const styleBox = h('textarea', { rows: 4, value: getStyle(), 'aria-label': 'Image style', oninput: (e) => setStyle(e.target.value) });
  const published = h('input', { type: 'checkbox', id: 'pub', checked: !!wk.published, onchange: (e) => { wk.published = e.target.checked; } });

  const save = async () => {
    say(status, 'Saving…');
    try {
      const body = { ...wk, exercises: wk.exercises.map((e) => ({ ...e, rest_sec: e.rest_sec === '' ? null : e.rest_sec })) };
      const r = wk.id ? await api(`/api/admin/workouts/${wk.id}`, { method: 'PUT', body }) : await api('/api/admin/workouts', { method: 'POST', body });
      Object.assign(wk, r.workout);
      say(status, wk.published ? 'Saved and live for members.' : 'Saved as a draft. Members cannot see it yet.');
    } catch (e) { say(status, e.message, true); }
  };

  drawExercises();
  app.replaceChildren(
    h('a', { class: 'back', href: '#/workouts' }, '← All workouts'),
    h('div', { class: 'panel' },
      h('div', { class: 'row' },
        field('Workout title', text(wk, 'title', { required: true, maxlength: 120 })),
        field('Category', text(wk, 'category', { placeholder: 'Strength, HIIT, Mobility…', maxlength: 40 })),
        field('Level', text(wk, 'level', { placeholder: 'Beginner', maxlength: 40 })),
        field('Minutes', text(wk, 'duration_min', { inputmode: 'numeric', placeholder: '30' }))),
      field('Description', bind(wk, 'description', h('textarea', { maxlength: 2000, value: wk.description || '' }))),
      h('p', {}, published, ' ', h('label', { for: 'pub' }, 'Published (visible to members)'))),
    h('details', { class: 'panel' }, h('summary', {}, 'Image style used in every prompt'),
      h('p', { class: 'muted' }, 'Keep this the same for every exercise so all your pictures look like one set.'), styleBox),
    exBox,
    h('div', { class: 'toolrow' },
      h('button', { class: 'btn ghost', type: 'button', onclick: () => { wk.exercises.push({ name: '', muscles: '', equipment: '', sets: '', reps: '', rest_sec: '', cues: '', image: '' }); drawExercises(); } }, '+ Add exercise'),
      h('button', { class: 'btn', type: 'button', onclick: save }, 'Save workout')),
    status);
}

// ---------- workout of the day ----------
async function wodView() {
  const [{ workouts }, { today, schedule }] = await Promise.all([api('/api/admin/workouts'), api('/api/admin/wod')]);
  const status = h('p', { role: 'status', class: 'muted' });
  const day = h('input', { type: 'date', value: today, required: true });
  const pick = h('select', {}, workouts.map((w) => h('option', { value: w.id }, `${w.title}${w.published ? '' : ' (draft)'}`)));
  app.replaceChildren(
    h('h1', {}, 'Workout of the day'),
    h('p', { class: 'muted' }, 'Members can download only the workout set for today’s date. Pick a day and a workout. Setting a day that already has one replaces it.'),
    h('form', { class: 'panel', onsubmit: async (e) => {
      e.preventDefault();
      if (!pick.value) { say(status, 'Create a workout first.', true); return; }
      try { await api(`/api/admin/wod/${day.value}`, { method: 'PUT', body: { workout_id: Number(pick.value) } }); await wodView(); }
      catch (err) { say(status, err.message, true); }
    } }, h('div', { class: 'row' }, field('Date', day), field('Workout', pick)),
    h('div', { class: 'toolrow' }, h('button', { class: 'btn', type: 'submit' }, 'Set workout of the day'))),
    status,
    h('div', { class: 'panel' }, schedule.length
      ? schedule.map((s) => h('div', { class: 'list-item' },
        h('div', {}, h('strong', {}, s.day), s.day === today ? ' (today)' : '', ' · ', s.title, s.published ? '' : h('span', { class: 'err' }, ' · draft: members cannot see it')),
        h('button', { class: 'btn danger small', onclick: async () => { await api(`/api/admin/wod/${s.day}`, { method: 'DELETE' }); await wodView(); } }, 'Remove')))
      : h('p', { class: 'muted' }, 'Nothing scheduled.')));
}

// ---------- reviews & comments ----------
async function feedbackView() {
  const { feedback } = await api('/api/admin/feedback');
  app.replaceChildren(
    h('h1', {}, 'Reviews & comments'),
    h('p', { class: 'muted' }, 'Newest first. Delete anything you do not want shown.'),
    h('div', { class: 'panel' }, feedback.length
      ? feedback.map((f) => h('div', { class: 'list-item' },
        h('div', {}, h('strong', {}, f.name), ' ', h('span', { class: 'muted' }, `${f.email} · ${f.workout} · ${when(f.created_at)}`),
          f.rating ? h('div', { class: 'stars-static' }, stars(f.rating)) : null, f.body ? h('p', {}, f.body) : null),
        h('button', { class: 'btn danger small', onclick: async () => { await api(`/api/admin/feedback/${f.id}`, { method: 'DELETE' }); await feedbackView(); } }, 'Delete')))
      : h('p', { class: 'muted' }, 'No comments or reviews yet.')));
}

// ---------- customers ----------
async function customersView() {
  const { users } = await api('/api/admin/users');
  const status = h('p', { role: 'status', class: 'muted' });
  const act = (fn) => async () => { try { await fn(); await customersView(); } catch (e) { say(status, e.message, true); } };
  app.replaceChildren(
    h('h1', {}, 'Customers'),
    h('p', { class: 'muted' }, 'Block someone to sign them out and stop them posting. Delete removes their account and all their reviews.'),
    status,
    h('div', { class: 'panel' }, users.map((u) => h('div', { class: 'list-item' },
      h('div', {}, h('strong', {}, u.name), ' ', u.role === 'admin' ? h('span', { class: 'tag' }, 'Coach') : null, u.blocked ? h('span', { class: 'tag draft' }, 'Blocked') : null,
        h('div', { class: 'muted' }, `${u.email} · joined ${new Date(u.created_at).toLocaleDateString()} · ${u.feedback_count} posts`)),
      u.role === 'admin' ? null : h('div', { class: 'toolrow' },
        h('button', { class: 'btn ghost small', onclick: act(() => api(`/api/admin/users/${u.id}`, { method: 'PUT', body: { blocked: !u.blocked } })) }, u.blocked ? 'Unblock' : 'Block'),
        h('button', { class: 'btn danger small', onclick: () => { if (confirm(`Delete ${u.name} and all their reviews?`)) act(() => api(`/api/admin/users/${u.id}`, { method: 'DELETE' }))(); } }, 'Delete'))))));
}

// ---------- routing ----------
async function route() {
  if (!store.get()) return loginView();
  tabs.hidden = false;
  const path = (location.hash || '#/workouts').slice(1);
  const tab = path.startsWith('/wod') ? 'wod' : path.startsWith('/feedback') ? 'feedback' : path.startsWith('/customers') ? 'customers' : 'workouts';
  tabs.querySelectorAll('[data-tab]').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  const blank = { title: '', description: '', category: '', level: '', duration_min: '', published: false, exercises: [] };
  let m;
  try {
    if (path === '/workouts/new') editView(blank);
    else if ((m = path.match(/^\/workouts\/(\d+)$/))) editView((await api(`/api/admin/workouts/${m[1]}`)).workout);
    else if (tab === 'wod') await wodView();
    else if (tab === 'feedback') await feedbackView();
    else if (tab === 'customers') await customersView();
    else await workoutsView();
  } catch (e) {
    if (e.status === 401 || e.status === 403) { store.clear(); return loginView(); }
    app.replaceChildren(h('p', { class: 'err pad' }, e.message));
  }
}

document.getElementById('logout').addEventListener('click', async (e) => {
  e.preventDefault();
  await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
  store.clear();
  loginView();
});
addEventListener('hashchange', route);
route();
