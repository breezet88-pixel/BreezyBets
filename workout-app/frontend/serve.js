// Tiny static file server for local use / simple hosting. The front end is only
// static files in public/, so you can host it on any static host instead (see README).
// It reads API_URL (where the back end lives) and uses it for config.js and the CSP.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

export function createFrontend({ apiUrl = process.env.API_URL || 'http://localhost:3100' } = {}) {
  const api = new URL(apiUrl).origin;
  const csp = `default-src 'self'; img-src 'self' data: blob: ${api}; style-src 'self'; script-src 'self'; connect-src 'self' ${api}; ` +
    "manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

  return http.createServer((req, res) => {
    const send = (status, body, type = 'text/plain; charset=utf-8', extra = {}) => {
      res.writeHead(status, {
        'Content-Type': type, 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-cache', ...extra,
      });
      res.end(body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method not allowed');
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return send(400, 'Bad path'); }
    if (rel === '/config.js') return send(200, `globalThis.FL_API_URL = ${JSON.stringify(api)};\n`, MIME['.js']);
    if (rel === '/') rel = '/index.html';
    if (rel === '/admin') rel = '/admin.html';
    const file = path.join(PUBLIC_DIR, path.normalize(rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || path.basename(file).startsWith('_')) return send(404, 'Not found');
    fs.readFile(file, (err, data) => {
      if (err) return send(404, 'Not found');
      send(200, data, MIME[path.extname(file)] || 'application/octet-stream');
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8080);
  createFrontend().listen(port, () => {
    console.log(`FitLibrary web app:  http://localhost:${port}`);
    console.log(`Coach admin page:    http://localhost:${port}/admin`);
    console.log(`Talking to the API at ${process.env.API_URL || 'http://localhost:3100'}`);
  });
}
