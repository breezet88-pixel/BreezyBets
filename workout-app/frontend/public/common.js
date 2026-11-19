// Helpers shared by the member app and the coach admin page. No framework.
export const API = String(globalThis.FL_API_URL || '').replace(/\/$/, '');
export const assetUrl = (file) => `${API}/uploads/${file}`;

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

// A sign-in token kept in the given storage. The member app uses localStorage (stay signed in);
// the coach page uses sessionStorage (signed out when the tab closes).
export function tokenStore(storage, key) {
  return {
    get() { try { return storage.getItem(key) || ''; } catch { return ''; } },
    set(v) { try { storage.setItem(key, v); } catch { /* ignore */ } },
    clear() { try { storage.removeItem(key); } catch { /* ignore */ } },
  };
}

export function makeApi(store) {
  async function raw(path, opts = {}) {
    const headers = {};
    const token = store.get();
    if (token) headers.Authorization = `Bearer ${token}`;
    let body;
    if (opts.body instanceof Blob) body = opts.body;
    else if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }
    let res;
    try { res = await fetch(API + path, { method: opts.method || 'GET', headers, body }); }
    catch { const e = new Error('Cannot reach the server. Check your connection.'); e.offline = true; throw e; }
    if (!res.ok) {
      let data = {};
      try { data = await res.json(); } catch { /* no body */ }
      const e = new Error(data.message || `Request failed (${res.status})`);
      e.status = res.status;
      throw e;
    }
    return res;
  }
  const api = async (path, opts) => (await raw(path, opts)).json();
  api.raw = raw;
  return api;
}

export function restLabel(sec) {
  if (sec === null || sec === undefined || sec === '') return '';
  return sec >= 60 && sec % 60 === 0 ? `${sec / 60} min rest` : `${sec}s rest`;
}

export function stars(n) {
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}
