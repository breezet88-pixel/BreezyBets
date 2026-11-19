// Vercel entry point: every /api/... request is routed here (see ../vercel.json) and handled by the
// same code that runs locally. On Vercel the database is Turso and the pictures are in Vercel Blob,
// picked up from the environment variables those integrations set.
import { createHandler } from '../backend/server/server.js';

// Settings Vercel must have before the app can run. Names only, so it is safe to show them.
const REQUIRED = ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'BLOB_READ_WRITE_TOKEN', 'ADMIN_USERNAME', 'ADMIN_PASSWORD'];
const missing = REQUIRED.filter((k) => !process.env[k]);

const site = process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '';

const app = missing.length ? null : createHandler({
  trustProxy: true,                      // Vercel sets x-forwarded-for to the visitor's address
  appUrl: process.env.APP_URL || site,   // used in the links inside emails
  maxEmbedBytes: 3.5 * 1024 * 1024,      // Vercel responses are capped at 4.5 MB
});

export default async function handler(req, res) {
  if (missing.length) {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      error: 'setup_needed',
      message: `Hosting is not finished. Add these to the Vercel project, then redeploy: ${missing.join(', ')}. See workout-app/docs/hosting.md.`,
      missing,
    }));
  }
  // vercel.json rewrites /api/<path> to /api/handler?__path=<path>; restore the original path.
  const url = new URL(req.url, 'http://localhost');
  const path = url.searchParams.get('__path');
  if (path !== null) {
    url.searchParams.delete('__path');
    req.url = `/api/${path}${url.search}`;
  }
  return app.handle(req, res);
}
