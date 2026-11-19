// Exercise picture storage, the same for every host. Two implementations of one small async interface:
//   isRef(ref)                    is this a picture reference this store could have made?
//   exists(ref)                   does it exist?
//   put(buffer, ext, mime) -> ref store a new picture
//   read(ref) -> Buffer | null    its bytes (for the downloadable workout file)
//   list() -> [{ ref, uploadedAt }]   every stored picture (for removing unused ones)
//   remove([ref, ...])
//
// - Local / Fly / Docker: files in a folder, served by the API at /uploads/<name>. The ref is the file name.
// - Vercel: Vercel Blob over its HTTP API (no npm packages). The ref is the picture's public https address.
//   Vercel sets BLOB_READ_WRITE_TOKEN when you connect a Blob store to the project.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const LOCAL_NAME = /^[a-f0-9]{32}\.(png|jpg|webp|gif)$/;
const newName = (ext) => `${crypto.randomBytes(16).toString('hex')}.${ext}`;

export function openFiles({ uploadDir, blobToken = process.env.BLOB_READ_WRITE_TOKEN, fetchImpl } = {}) {
  if (blobToken) return blobFiles({ token: blobToken, fetchImpl });
  return diskFiles(uploadDir);
}

// ---------------------------------------------------------------- folder on disk
export function diskFiles(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const root = path.resolve(dir);
  const file = (ref) => path.join(root, ref);
  return {
    kind: 'disk',
    root,
    isRef: (ref) => LOCAL_NAME.test(ref),
    async exists(ref) { return LOCAL_NAME.test(ref) && fs.existsSync(file(ref)); },
    async put(buf, ext) { const name = newName(ext); fs.writeFileSync(file(name), buf); return name; },
    async read(ref) { if (!LOCAL_NAME.test(ref)) return null; try { return fs.readFileSync(file(ref)); } catch { return null; } },
    async list() {
      return fs.readdirSync(root).filter((f) => LOCAL_NAME.test(f)).map((f) => {
        try { return { ref: f, uploadedAt: fs.statSync(file(f)).mtimeMs }; } catch { return null; }
      }).filter(Boolean);
    },
    async remove(refs) { for (const r of refs) if (LOCAL_NAME.test(r)) { try { fs.unlinkSync(file(r)); } catch { /* already gone */ } } },
  };
}

// ---------------------------------------------------------------- Vercel Blob
// Same requests the official @vercel/blob client makes (API version 13).
// VERCEL_BLOB_API_URL overrides the API address, exactly as in the official client.
export function blobFiles({ token, apiUrl = process.env.VERCEL_BLOB_API_URL || 'https://vercel.com/api/blob', publicHost, fetchImpl = fetch }) {
  const storeId = String(token).split('_')[3] || '';
  if (!storeId) throw new Error('BLOB_READ_WRITE_TOKEN does not look like a Vercel Blob read-write token.');
  const host = (publicHost || `${storeId}.public.blob.vercel-storage.com`).toLowerCase();
  const isRef = (ref) => {
    try {
      const u = new URL(ref);
      return u.protocol === 'https:' && u.host.toLowerCase() === host && /^\/uploads\/[a-f0-9]{32}\.(png|jpg|webp|gif)$/.test(u.pathname) && !u.search && !u.hash;
    } catch { return false; }
  };
  async function api(pathAndQuery, init) {
    const res = await fetchImpl(apiUrl + pathAndQuery, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'x-api-version': '13', 'x-vercel-blob-store-id': storeId, ...(init.headers || {}) },
    });
    if (!res.ok) throw new Error(`Picture storage request failed (HTTP ${res.status}). Check the Blob store is connected to this project.`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  return {
    kind: 'blob',
    isRef,
    async exists(ref) { return isRef(ref); },
    async put(buf, ext, mime) {
      const pathname = `uploads/${newName(ext)}`;
      const out = await api(`/?${new URLSearchParams({ pathname })}`, {
        method: 'PUT',
        body: buf,
        headers: { 'x-vercel-blob-access': 'public', 'x-content-type': mime, 'x-add-random-suffix': '0', 'x-cache-control-max-age': '31536000' },
      });
      if (!out || !isRef(out.url)) throw new Error('Picture storage returned an unexpected address.');
      return out.url;
    },
    async read(ref) {
      if (!isRef(ref)) return null;
      try {
        const res = await fetchImpl(ref, { signal: AbortSignal.timeout(5000) }); // never let one picture stall a download
        return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
      } catch { return null; }
    },
    async list() {
      const out = [];
      let cursor = null;
      do {
        const q = new URLSearchParams({ prefix: 'uploads/', limit: '1000' });
        if (cursor) q.set('cursor', cursor);
        const page = await api(`?${q}`, { method: 'GET' });
        for (const b of page.blobs || []) out.push({ ref: b.url, uploadedAt: Date.parse(b.uploadedAt) });
        cursor = page.hasMore ? page.cursor : null;
      } while (cursor);
      return out;
    },
    async remove(refs) {
      if (!refs.length) return;
      await api('/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ urls: refs }) });
    },
  };
}
