# OK-Mobile — one-file deployment (site + API + Telegram bot)

`server.js` is now the entire application. It serves:

- **The OK-Mobile web app itself** at `GET /` (the full `index.html` is
  embedded inside `server.js` as a string — there is no separate frontend
  file to host anywhere).
- **The `/api/auth/...` endpoints** the app calls to register and verify
  accounts.
- **The Telegram bot** that sends the 6-digit verification code.

One Railway service now does all three jobs. You do **not** need Netlify,
Vercel, GitHub Pages, or any second deployment for the frontend anymore.

## What changed from the two-file version

- The embedded copy of the app has `DEMO_MODE = false` and
  `API_BASE_URL = ''` baked in, so it calls `/api/auth/...` on its own
  origin — no separate backend URL to configure on the frontend side.
- `GET /` and `GET /index.html` return the app.
- A catch-all `GET *` also returns the app (SPA fallback), so it never
  matters if someone loads any path — everything else (routing between
  screens) happens client-side inside the app itself, exactly as before.
- `POST /api/...`, `POST /telegram/webhook`, and `GET /health` are
  unchanged.

If you ever edit the frontend, you have to regenerate the embedded copy
inside `server.js` (ask me to do this again and hand me the updated
`index.html` — I'll rebuild `server.js` with the new version baked in).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/`, `/index.html`, or any other path | The OK-Mobile web app |
| POST | `/api/auth/register` | Create a verification session, return the Telegram deep link |
| POST | `/api/auth/verify` | Check a submitted code against the session |
| POST | `/api/auth/resend-verification` | Send a fresh code to an already-linked chat |
| POST | `/telegram/webhook` | Telegram webhook endpoint (used by Telegraf, not called directly) |
| GET | `/health` | Health check for Railway |

## Local setup

```bash
npm install
cp .env.example .env
# fill in BOT_TOKEN, SERVER_SECRET, etc. in .env
npm start
```

Then open `http://localhost:3000` in a browser — that's the app, served
straight from `server.js`.

For local testing without a public URL, you can temporarily use polling
instead of a webhook (swap `bot.webhookCallback(...)` for `bot.launch()` in
`server.js`) — but production on Railway should use the webhook as shipped.

## Deploy to Railway — step by step

1. **Create a GitHub repository** and push `server.js`, `package.json`,
   `.env.example`, and this `README.md`. That's the whole repo now — no
   `index.html` needed alongside it (it's embedded in `server.js`).
2. **Open Railway** ([railway.app](https://railway.app)) and sign in.
3. **New Project → Deploy from GitHub repo** → select the repo.
4. Railway detects `package.json` and runs `npm install` automatically.
5. **Add environment variables** in the Railway project's **Variables** tab:
   - `BOT_TOKEN` — from [@BotFather](https://t.me/BotFather)
   - `BOT_USERNAME` — your bot's `@username`, without the `@`
   - `SERVER_SECRET` — a long random string (see `.env.example` for how to
     generate one)
   - `BACKEND_URL` — leave blank for the first deploy; fill in after step 7
   - `ALLOWED_ORIGINS` — can stay blank now that the app and API share one
     origin; only needed if some other site will also call this API
6. **Deploy** — Railway does this automatically once the repo is connected.
7. **Copy the Railway public URL** — **Settings → Networking → Generate
   Domain**, e.g. `https://ok-mobile-production.up.railway.app`.
8. **Set `BACKEND_URL`** to that same URL in Railway's Variables tab (no
   trailing slash) and redeploy. On boot, `server.js` calls `setWebhook`
   for you automatically.
9. **Open the Railway URL in a browser** — you should see the OK-Mobile
   app itself (splash screen, login, etc.), served directly by this
   service.
10. **Test the full flow** — Регистрация → Продолжить should open the real
    Telegram bot, which sends a real code, which the app then verifies
    against `/api/auth/verify` on this same server.

Confirm the webhook is correctly set:
```
https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo
```

## Production notes

- Sessions are stored **in memory** in this demo (`Map`). That's fine for a
  single Railway instance but is lost on restart/redeploy and won't work if
  you scale to multiple instances. Swap the `sessions` Map for Redis or a
  Postgres table before relying on this in production.
- Rotate `SERVER_SECRET` and `BOT_TOKEN` if they're ever exposed.
- The main user database, password hashing, and session/JWT issuance for the
  logged-in app belong in your primary backend if you build one later — this
  service currently only handles Telegram verification (the app itself
  keeps its data in the browser / Firebase, as already wired into it).
- Because the frontend now lives inside `server.js` as a big string, treat
  `server.js` as a build artifact for the frontend, not something to
  hand-edit — regenerate it from `index.html` when the app changes.
