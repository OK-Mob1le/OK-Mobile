# OK-Mobile — one-file deployment (v2: polling + SQLite)

`server.js` is the entire application: it serves the OK-Mobile web app
(embedded inside it), the `/api/...` endpoints, and the Telegram bot.

## What changed in v2 — and why

Earlier versions used a **Telegram webhook**, which depends on a public
HTTPS URL (`BACKEND_URL`) being registered with Telegram *exactly*
correctly. One typo, a domain that changed, or a deploy that happened
before the webhook was set — and updates silently stop arriving: no error
anywhere obvious, the bot just never shows the "Подтвердить регистрацию"
button or never sends a code.

v2 uses **long polling** instead (`bot.launch()`), the same approach as
simpler, more robust Telegram bots: this process just asks Telegram "any
updates?" in a loop. There is no URL to register, so there's nothing to
misconfigure. **`BACKEND_URL` no longer exists as a variable at all.**

Verification sessions and phone↔Telegram links also moved from an
in-memory `Map` (wiped on every restart) to a **SQLite file** (via
`better-sqlite3`), so they survive a simple restart. See the note on
Railway Volumes below for surviving a full redeploy too.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/`, `/index.html`, or any other path | The OK-Mobile web app |
| POST | `/api/auth/register` | Create a verification session, return the Telegram deep link |
| POST | `/api/auth/verify` | Check a submitted code against the session |
| POST | `/api/auth/resend-verification` | Send a fresh code to an already-linked chat |
| POST | `/api/notify` | Forward an in-app event to the account's linked Telegram chat |
| GET | `/health` | Health check |

There is no `/telegram/webhook` route any more — not needed with polling.

## Local setup

```bash
npm install
cp .env.example .env
# fill in BOT_TOKEN and BOT_USERNAME in .env
npm start
```

Open `http://localhost:3000` — that's the app, served by `server.js`. The
bot starts polling immediately; no public URL needed even for local testing.

## Deploy to Railway — step by step

1. **Push to GitHub**: `server.js`, `package.json`, `.env.example`, this
   `README.md`. No `index.html` needed — it's embedded in `server.js`.
2. **Railway** → **New Project → Deploy from GitHub repo** → select the repo.
3. Railway runs `npm install` automatically (this now also pulls in
   `better-sqlite3`, which compiles a small native module — normal, no
   action needed on your side).
4. **Variables** tab, add:
   - `BOT_TOKEN` — from [@BotFather](https://t.me/BotFather)
   - `BOT_USERNAME` — your bot's `@username`, without the `@`
   - `SERVER_SECRET` — a long random string (see `.env.example`)
   - `ALLOWED_ORIGINS` — leave blank
   - `SQLITE_PATH` — leave as default unless using a Volume (see below)
5. **Deploy**. Check **Deployments → View Logs** — you should see:
   ```
   OK-Mobile listening on port ...
   Telegram bot started (long polling) ✓
   ```
   If instead you see `FATAL: bot.launch() failed`, the token is wrong.
6. **Generate a domain** (Settings → Networking) if you want the site
   reachable publicly — purely for the website; the bot doesn't need it.
7. **Open the Railway URL** — you should see the OK-Mobile app itself.
8. **Test**: Регистрация → Продолжить → real Telegram bot opens → tap
   "Подтвердить регистрацию" → real code arrives → enter it on the site.

No webhook step, no `getWebhookInfo` check needed anymore — if the logs
show "long polling ✓", the bot is live.

## Persisting data across redeploys (optional but recommended)

Railway's filesystem resets on redeploy by default, which would reset the
SQLite file (losing any *pending, unfinished* verification sessions — not
your actual business data, which lives in Firebase, just short-lived
signup sessions). To keep it:

1. In Railway, open the service → **Settings → Volumes** → **New Volume**.
2. Mount it at, say, `/data`.
3. Set `SQLITE_PATH=/data/okmobile.sqlite3` in Variables.
4. Redeploy.

## Production notes

- `better-sqlite3` is synchronous — fine at this scale (a handful of
  verification sessions at a time), not meant for heavy concurrent load.
- Rotate `SERVER_SECRET` and `BOT_TOKEN` if they're ever exposed.
- The app's actual business data (sales, products, customers, etc.) lives
  in Firebase, wired directly into the frontend — this service only ever
  handles Telegram verification and notification relay.
