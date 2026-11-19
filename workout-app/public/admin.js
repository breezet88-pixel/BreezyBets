// Admin page: sign in, add/edit workouts and exercises, upload exercise images,
// and build a ready-to-paste prompt for your AI image tool.
import { h, api } from './common.js';

const app = document.getElementById('app');
const logoutLink = document.getElementById('logout');
const STYLE_KEY = 'fl.imageStyle';

export const DEFAULT_STYLE =
  'Clean flat vector illustration in a consistent style: one gender-neutral athlete with a plain face, dark grey fitted sportswear, ' +
  'solid white background, soft ground shadow, teal (#0f766e) used only to highlight the working muscles. ' +
  'The same character, same line weight and same colours in every image of this series.';

function getStyle() {
  try { return localStorage.getItem(STYLE_KEY) || DEFAULT_STYLE; } catch { return DEFAULT_STYLE; }
}
function setStyle(v) {
  try { localStorage.setItem(STYLE_KEY, v); } catch { /* ignore */ }
}

// Builds the prompt you paste into the image generator for one exercise.
export function buildPrompt(ex, style) {
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

const state = { workouts: [], editing: null };

function say(el, msg, bad) {
  el.textContent = msg;
  el.className = bad ? 'err' : 'muted';
}

// ---------- sign in ----------
function loginView(enabled) {
  logoutLink.hidden = true;
  const msg = h('p', { class: 'err', role: 'alert' });
  const pw = h('input', { type: 'password', id: 'pw', autocomplete: 'current-password', required: true });
  const form = h('form', { class: 'panel', onsubmit: async (e) => {
    e.preventDefault();
    try { await api('/api/admin/login', { method: 'POST', body: { password: pw.value } }); await start(); }
    catch (err) { msg.textContent = err.message; }
  } },
  h('h1', {}, 'Admin sign in'),
  enabled ? null : h('p', { class: 'err' }, 'Admin is disabled: set the ADMIN_PASSWORD environment variable on the server.'),
  h('label', { for: 'pw' }, 'Password'), pw,
  h('div', { class: 'toolrow' }, h('button', { class: 'btn', type: 'submit', disabled: !enabled }, 'Sign in')), msg);
  app.replaceChildren(form);
  pw.focus();
}

// ---------- workout list ----------
async function listView() {
  logoutLink.hidden = false;
  state.editing = null;
  state.workouts = (await api('/api/admin/workouts')).workouts;
  app.replaceChildren(
    h('div', { class: 'list-item' }, h('h1', {}, 'Workouts'),
      h('button', { class: 'btn', onclick: () => editView({ title: '', description: '', category: '', level: '', duration_min: '', published: false, exercises: [] }) }, '+ New workout')),
    h('div', { class: 'panel' }, state.workouts.length
      ? state.workouts.map((w) => h('div', { class: 'list-item' },
        h('div', {}, h('strong', {}, w.title), ' ', h('span', { class: `tag${w.published ? '' : ' draft'}` }, w.published ? 'Published' : 'Draft'),
          h('div', { class: 'muted' }, `${w.exercise_count} exercises${w.category ? ` · ${w.category}` : ''}`)),
        h('button', { class: 'btn ghost small', onclick: async () => editView((await api(`/api/admin/workouts/${w.id}`)).workout) }, 'Edit')))
      : h('p', { class: 'muted' }, 'No workouts yet. Tap “New workout”.')));
}

// ---------- editor ----------
function field(label, input) {
  const id = `f${Math.random().toString(36).slice(2, 8)}`;
  input.id = id;
  return h('div', {}, h('label', { for: id }, label), input);
}

function editView(w) {
  const wk = JSON.parse(JSON.stringify(w));
  const status = h('p', { role: 'status', class: 'muted' });
  const exBox = h('div');

  const bind = (obj, key, el) => { el.addEventListener('input', () => { obj[key] = el.value; }); return el; };
  const text = (obj, key, attrs = {}) => bind(obj, key, h('input', { type: 'text', value: obj[key] ?? '', ...attrs }));

  function drawExercises() {
    exBox.replaceChildren(...wk.exercises.map((ex, i) => exerciseCard(ex, i)));
  }

  function exerciseCard(ex, i) {
    const preview = h('img', { class: 'thumb', alt: `${ex.name} preview`, hidden: !ex.image, src: ex.image ? `/uploads/${ex.image}` : undefined });
    const upStatus = h('p', { role: 'status', class: 'muted' });
    const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', onchange: async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      say(upStatus, 'Uploading…');
      try {
        const r = await api('/api/admin/upload', { method: 'POST', body: f });
        ex.image = r.file;
        preview.src = `/uploads/${r.file}`;
        preview.hidden = false;
        say(upStatus, 'Image added. Remember to save the workout.');
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
      h('div', { class: 'toolrow' },
        h('button', { class: 'btn ghost small', type: 'button', onclick: () => {
          promptBox.value = buildPrompt(ex, getStyle());
          promptWrap.hidden = false;
        } }, '✨ Create image prompt')),
      promptWrap,
      field('Exercise image (from your image tool)', fileInput),
      preview, upStatus);
  }

  const styleBox = h('textarea', { rows: 4, value: getStyle(), 'aria-label': 'Image style', oninput: (e) => setStyle(e.target.value) });

  const save = async () => {
    say(status, 'Saving…');
    try {
      const body = { ...wk, exercises: wk.exercises.map((e) => ({ ...e, rest_sec: e.rest_sec === '' ? null : e.rest_sec })) };
      const r = wk.id
        ? await api(`/api/admin/workouts/${wk.id}`, { method: 'PUT', body })
        : await api('/api/admin/workouts', { method: 'POST', body });
      Object.assign(wk, r.workout);
      say(status, wk.published ? 'Saved and live for members.' : 'Saved as a draft. Members cannot see it yet.');
    } catch (e) { say(status, e.message, true); }
  };

  const published = h('input', { type: 'checkbox', id: 'pub', checked: !!wk.published, onchange: (e) => { wk.published = e.target.checked; } });
  drawExercises();

  app.replaceChildren(
    h('a', { class: 'back', href: '#', onclick: (e) => { e.preventDefault(); listView(); } }, '← All workouts'),
    h('div', { class: 'panel' },
      h('div', { class: 'row' },
        field('Workout title', text(wk, 'title', { required: true, maxlength: 120 })),
        field('Category', text(wk, 'category', { placeholder: 'Strength, HIIT, Mobility…', maxlength: 40 })),
        field('Level', text(wk, 'level', { placeholder: 'Beginner', maxlength: 40 })),
        field('Minutes', text(wk, 'duration_min', { inputmode: 'numeric', placeholder: '30' }))),
      field('Description', bind(wk, 'description', h('textarea', { maxlength: 2000, value: wk.description || '' }))),
      h('p', {}, published, ' ', h('label', { for: 'pub', style: false }, 'Published (visible to members)'))),
    h('details', { class: 'panel' }, h('summary', {}, 'Image style used in every prompt'),
      h('p', { class: 'muted' }, 'Keep this the same for every exercise so all your pictures look like one set.'), styleBox),
    exBox,
    h('div', { class: 'toolrow' },
      h('button', { class: 'btn ghost', type: 'button', onclick: () => { wk.exercises.push({ name: '', muscles: '', equipment: '', sets: '', reps: '', rest_sec: '', cues: '', image: '' }); drawExercises(); } }, '+ Add exercise'),
      h('button', { class: 'btn', type: 'button', onclick: save }, 'Save workout'),
      wk.id ? h('button', { class: 'btn danger', type: 'button', onclick: async () => {
        if (!confirm(`Delete “${wk.title}”? This cannot be undone.`)) return;
        try { await api(`/api/admin/workouts/${wk.id}`, { method: 'DELETE' }); await listView(); } catch (e) { say(status, e.message, true); }
      } }, 'Delete') : null),
    status);
}

// ---------- start ----------
async function start() {
  const me = await api('/api/admin/me');
  if (!me.admin) return loginView(me.enabled);
  await listView();
}

logoutLink.addEventListener('click', async (e) => {
  e.preventDefault();
  await api('/api/admin/logout', { method: 'POST', body: {} });
  await start();
});

start().catch((e) => { app.replaceChildren(h('p', { class: 'err pad' }, e.message)); });
