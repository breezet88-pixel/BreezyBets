# FitLibrary

A workout app with a **separate back end and front end**.

| Who | Can |
|---|---|
| **Anyone** | View published workouts, today's workout of the day, and reviews |
| **Customer** (free account) | Everything above, plus **add comments and reviews** and **download today's workout of the day** |
| **You (coach/admin)** | **Add, edit and remove everything**: workouts, exercises, pictures, the workout-of-the-day schedule, comments/reviews, customers |

Customers can never edit or delete anything (not even their own posts). The back end enforces this on every request; the front end only displays.

```
workout-app/
  backend/    API only (JSON + uploaded pictures). Node, SQLite, no dependencies.
  frontend/   The website/app (static files, installable PWA). No build step, no dependencies.
  docs/       image-prompts.md: which image tool to use and how to prompt it
```

Needs Node >= 22.13. Run the two parts in two terminals:

```
# 1. back end  (http://localhost:3100)
cd backend
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-password' npm start

# 2. front end (http://localhost:8080)
cd frontend
npm start
```

- Customers: http://localhost:8080
- You: http://localhost:8080/admin, signed in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`

If you don't set them, development mode prints a temporary admin login at start. In production (`NODE_ENV=production`) there is no admin until both are set. Changing `ADMIN_PASSWORD` and restarting changes your password. `npm test` in each folder runs its tests.

## Back end (`backend/`)

| Env var | Default | Purpose |
|---|---|---|
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | none | Your one admin account |
| `CORS_ORIGINS` | `http://localhost:8080` | Comma-separated website addresses allowed to call the API, e.g. `https://app.example.com` |
| `PORT` | 3100 | |
| `DB_PATH` / `UPLOAD_DIR` | `./data/...` | SQLite file and pictures. **Back up `data/`**, and keep it on a persistent disk. |
| `TIMEZONE` | `Africa/Johannesburg` | Decides when "today" starts for the workout of the day |
| `TRUST_PROXY` | false | `true` behind a proxy so rate limits see real client IPs |

Sign-in uses a bearer token (no cookies), so the two parts can live on different domains. Passwords are scrypt-hashed, tokens are stored only as hashes, login and sign-up are rate-limited, customers are limited to 10 posts an hour, and uploads are checked by their real file bytes. Blocking a customer ends their session immediately; deleting one removes their reviews. Pictures you stop using are deleted from disk.

## Front end (`frontend/`)

Static files in `public/`. It finds the API from `API_URL` (used by `npm start`) or, on a static host, from `public/config.js`. `public/_headers` has a ready security-header template for Netlify / Cloudflare Pages.

- **Customers** install it like an app: Android/Chrome/Edge/desktop via the *Install app* button, iPhone/iPad via Safari → Share → Add to Home Screen. Today's workout can be saved for offline use or downloaded as one self-contained file (pictures included, prints to PDF).
- **You** use `/admin`: Workouts (with a **✨ Create image prompt** button on every exercise, see [docs/image-prompts.md](docs/image-prompts.md)), Workout of the day (schedule by date), Reviews (delete any), Customers (block / delete).

## Hosting

Host the back end anywhere that runs Node with a persistent disk (Fly.io, Railway, Render, a VPS) behind HTTPS, then host `frontend/public` on any static host (Netlify, Cloudflare Pages, GitHub Pages) or with `npm start`. Set `CORS_ORIGINS` on the back end to the front end's address, and set `API_URL` (or edit `public/config.js` and `_headers`) to the back end's address.

## Before you launch

- **Privacy (POPIA):** you now collect customers' names and emails. Publish a short privacy notice and a way to request deletion (you can already delete accounts from the Customers tab).
- **Emails are not verified** and there is no password reset yet. Ask if you want either (needs an email-sending service).
- **Downloads are limited to the workout of the day** by design. Anyone can still *view* every workout, and the day's file is available to every signed-in customer.
