import crypto from 'node:crypto';
import { createApp } from './server.js';

const port = Number(process.env.PORT || 3100);
let adminUsername = process.env.ADMIN_USERNAME || process.env.ADMIN_EMAIL;
let adminPassword = process.env.ADMIN_PASSWORD;

if (!adminUsername || !adminPassword) {
  if (process.env.NODE_ENV === 'production') {
    console.warn('ADMIN_USERNAME and ADMIN_PASSWORD are not both set: there is no admin account.');
  } else {
    adminUsername = adminUsername || 'admin';
    adminPassword = adminPassword || crypto.randomBytes(9).toString('base64url');
    console.log(`Development admin login:  ${adminUsername}  /  ${adminPassword}`);
  }
}
if (adminPassword && adminPassword.length < 12) {
  console.warn('WARNING: the admin password is short. Anyone who guesses it can change or delete everything.\n' +
    '         The server limits guesses (5 wrong tries locks the account for 15 minutes), but a longer password is much safer.');
}

const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:8080').split(',').map((s) => s.trim()).filter(Boolean);

const app = createApp({
  dbPath: process.env.DB_PATH || './data/fitlibrary.db',
  uploadDir: process.env.UPLOAD_DIR || './data/uploads',
  adminUsername, adminPassword, corsOrigins,
});
await app.ready;
app.server.listen(port, () => console.log(`FitLibrary API on http://localhost:${port}  (allowed web origins: ${corsOrigins.join(', ')})`));
