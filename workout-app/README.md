# FitLibrary

A workout library your members can **view and download but not change**, and an admin page where **only you** add workouts and exercise pictures. It is a Progressive Web App (PWA): one codebase that installs like a normal app on iPhone, iPad, Android, Windows, Mac and Chromebook.

Plain Node (>= 22.13), **zero npm dependencies**, SQLite for data, images stored as files.

## Run it

```
cd workout-app
ADMIN_PASSWORD='choose-a-long-password' npm start
```

- Members: http://localhost:3100
- You (admin): http://localhost:3100/admin

If `ADMIN_PASSWORD` is not set, a temporary one is printed at start (development only). In production, with no password the admin area is switched off.

`npm test` runs the API tests (about 1 second).

| Env var | Default | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | none | Admin sign-in. Required in production. |
| `SESSION_SECRET` | random each start | Signs the admin cookie. Set it so sign-ins survive restarts. |
| `PORT` | 3100 | |
| `DB_PATH` | `./data/fitlibrary.db` | SQLite file |
| `UPLOAD_DIR` | `./data/uploads` | Exercise images |
| `COOKIE_SECURE` | false | Set `true` behind HTTPS |
| `TRUST_PROXY` | false | Set `true` behind a proxy so login rate-limiting sees real client IPs |

`data/` holds everything you create: **back it up**, and put it on a persistent disk or volume when you host.

## How it works

- **Admin** (`/admin`): create a workout, add exercises (name, muscles, equipment, sets, reps, rest, form cues), upload a picture for each, tick *Published* when ready. Drafts are invisible to members. Each exercise has a **✨ Create image prompt** button, see [docs/image-prompts.md](docs/image-prompts.md).
- **Members** (`/`): browse, search and filter workouts. Two ways to keep one:
  - **Save to this device**: works offline inside the app.
  - **Download file**: a single self-contained `.html` file with the pictures embedded. Opens on any device, and prints to PDF.
- Members have no way to write anything: the public API is `GET` only and every admin route needs your signed cookie.
- Security: admin cookie is HttpOnly + SameSite=Strict + HMAC-signed, login is rate-limited, uploads are checked by their real file bytes, strict CSP.

## Getting it onto many devices

1. **Host it** on any HTTPS host that runs Node with a persistent disk (Fly.io, Railway, Render, a VPS). The root of this repo already has a working Fly.io setup for the betting demo you can copy; this app needs only `server/`, `public/`, `package.json` and a volume at `/data`.
2. **Install, no app store needed.** Members open your web address and:
   - Android / Chrome / Edge / Windows / Mac: tap **Install app** (button in the header), or the browser's install icon.
   - iPhone / iPad: Safari → Share → **Add to Home Screen**.
3. **Want to be in the App Store / Google Play?** Wrap this same site with [Capacitor](https://capacitorjs.com) (free) and submit the result. Apple requires a paid developer account (US$99/year), Google a one-off US$25. Do this later, only if you need the store listing.

## Not included (decide before launch)

- Member accounts / payments. Right now anyone with the link can view. If the workouts are paid, add sign-in and a payment provider before hosting publicly; ask and we can build it.
- Image moderation: you upload everything yourself, so there is none.
