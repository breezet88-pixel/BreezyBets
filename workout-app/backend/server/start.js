import crypto from 'node:crypto';
import { createApp } from './server.js';

const port = Number(process.env.PORT || 3100);
let adminEmail = process.env.ADMIN_EMAIL;
let adminPassword = process.env.ADMIN_PASSWORD;

if (!adminEmail || !adminPassword) {
  if (process.env.NODE_ENV === 'production') {
    console.warn('ADMIN_EMAIL and ADMIN_PASSWORD are not both set: there is no admin account.');
  } else {
    adminEmail = adminEmail || 'admin@example.com';
    adminPassword = adminPassword || crypto.randomBytes(9).toString('base64url');
    console.log(`Development admin login:  ${adminEmail}  /  ${adminPassword}`);
  }
}

const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:8080').split(',').map((s) => s.trim()).filter(Boolean);

const app = createApp({
  dbPath: process.env.DB_PATH || './data/fitlibrary.db',
  uploadDir: process.env.UPLOAD_DIR || './data/uploads',
  adminEmail, adminPassword, corsOrigins,
});
await app.ready;
app.server.listen(port, () => console.log(`FitLibrary API on http://localhost:${port}  (allowed web origins: ${corsOrigins.join(', ')})`));
