// Build step for static hosts (Vercel): writes public/config.js, which tells the app where the API is.
// On Vercel the API is on the same address as the website, so API_URL is empty by default.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const api = (process.env.API_URL || '').replace(/\/+$/, '');
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'config.js');
fs.writeFileSync(file, `// Written by write-config.mjs at build time.\nglobalThis.FL_API_URL = ${JSON.stringify(api)};\n`);
console.log(`config.js: API ${api || '(same address as the website)'}`);
