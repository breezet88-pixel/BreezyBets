import crypto from 'node:crypto';
import { createApp } from './server.js';

const port = Number(process.env.PORT || 3100);
let adminPassword = process.env.ADMIN_PASSWORD;

if (!adminPassword) {
  if (process.env.NODE_ENV === 'production') {
    console.warn('ADMIN_PASSWORD is not set: the admin area is disabled.');
  } else {
    adminPassword = crypto.randomBytes(9).toString('base64url');
    console.log(`No ADMIN_PASSWORD set. Temporary admin password for this run: ${adminPassword}`);
  }
}

const app = createApp({
  dbPath: process.env.DB_PATH || './data/fitlibrary.db',
  uploadDir: process.env.UPLOAD_DIR || './data/uploads',
  adminPassword,
});

app.server.listen(port, () => {
  console.log(`FitLibrary running:  http://localhost:${port}`);
  console.log(`Admin (you only):    http://localhost:${port}/admin`);
});
