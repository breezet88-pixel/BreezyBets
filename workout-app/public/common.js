// Tiny helpers shared by the member app and the admin page. No framework.
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'hidden') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body !== undefined && !(opts.body instanceof Blob) ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body === undefined ? undefined : opts.body instanceof Blob ? opts.body : JSON.stringify(opts.body),
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data.message || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function restLabel(sec) {
  if (sec === null || sec === undefined || sec === '') return '';
  return sec >= 60 && sec % 60 === 0 ? `${sec / 60} min rest` : `${sec}s rest`;
}
