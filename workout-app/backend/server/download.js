// Builds the downloadable "workout of the day": one self-contained HTML file with the
// pictures embedded, so it opens offline on any device and prints to PDF.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const extOf = (ref) => (/\.(png|jpg|webp|gif)$/.exec(String(ref)) || [])[1];

function restLabel(sec) {
  if (sec === null || sec === undefined) return '';
  return sec >= 60 && sec % 60 === 0 ? `${sec / 60} min rest` : `${sec}s rest`;
}

export function slug(title) {
  return String(title).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'workout';
}

// files: the picture store. maxEmbedBytes: pictures are embedded until this many bytes; after that a picture
// that has a public web address is linked instead (keeps the file under the host's response-size limit).
export async function buildWorkoutHtml(w, day, files, maxEmbedBytes = Infinity) {
  const meta = [w.category, w.level, w.duration_min ? `${w.duration_min} min` : ''].filter(Boolean).join(' · ');
  let embedded = 0;
  const rows = [];
  for (const [i, e] of w.exercises.entries()) {
    const facts = [e.sets && e.reps ? `${e.sets} × ${e.reps}` : e.sets || e.reps, restLabel(e.rest_sec)].filter(Boolean).join(' · ');
    let img = '';
    if (e.image) {
      const bytes = embedded < maxEmbedBytes ? await files.read(e.image) : null;
      if (bytes && embedded + bytes.length <= maxEmbedBytes) {
        embedded += bytes.length;
        img = `<img src="data:${MIME[extOf(e.image)]};base64,${bytes.toString('base64')}" alt="How to do ${esc(e.name)}">`;
      } else if (/^https:\/\//.test(e.image)) {
        img = `<img src="${esc(e.image)}" alt="How to do ${esc(e.name)}">`;
      }
    }
    rows.push(`<section><h2>${i + 1}. ${esc(e.name)}</h2>` +
      (facts ? `<p class="facts">${esc(facts)}</p>` : '') + img +
      (e.muscles ? `<p><b>Muscles:</b> ${esc(e.muscles)}</p>` : '') +
      (e.equipment ? `<p><b>Equipment:</b> ${esc(e.equipment)}</p>` : '') +
      (e.cues ? `<p>${esc(e.cues)}</p>` : '') + '</section>');
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(w.title)}</title>` +
    '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:720px;margin:0 auto;padding:20px;color:#111}h1{margin:0 0 4px}.meta{color:#555;margin:0 0 12px}' +
    'section{border-top:1px solid #ddd;padding:14px 0;break-inside:avoid}h2{margin:0 0 4px;font-size:1.15rem}.facts{font-weight:600;color:#0f766e;margin:0 0 8px}' +
    'img{max-width:100%;height:auto;border-radius:8px;border:1px solid #eee}p{margin:6px 0}</style></head><body>' +
    `<p class="meta">Workout of the day · ${esc(day)}</p><h1>${esc(w.title)}</h1><p class="meta">${esc(meta)}</p>` +
    `${w.description ? `<p>${esc(w.description)}</p>` : ''}${rows.join('')}</body></html>`;
}
