# OK-Mobile — Telegram Verification Bot

Backend service that verifies new OK-Mobile Бухгалтерия accounts via a Telegram
6-digit code. Deployed separately from the frontend, on Railway.

## What it does

1. Frontend calls `POST /api/auth/register` → gets back a one-time `token` and
   a Telegram deep link (`https://t.me/<bot>?start=<token>`).
2. User opens the link, taps **Подтвердить регистрацию** in the bot chat.
3. Bot generates a secure 6-digit code, hashes it, and sends it in Telegram.
4. Frontend calls `POST /api/auth/verify` with `{ token, code }`.
5. Bot checks the hash, expiry (5 min) and attempt count (max 5), and
   responds with `verified` or an error.

No secrets ever touch the frontend — `BOT_TOKEN` and `SERVER_SECRET` live only
in this service's environment variables.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
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

For local testing without a public URL, you can temporarily use polling
instead of a webhook (swap `bot.webhookCallback(...)` for `bot.launch()` in
`server.js`) — but production on Railway should use the webhook as shipped.

## Deploy to Railway — step by step

1. **Create a GitHub repository** and push this `ok-mobile-verification-bot/`
   folder to it (as its own repo, separate from the frontend).
2. **Upload the bot project** — make sure `package.json`, `server.js`,
   `.env.example` and this `README.md` are all committed. Do **not** commit a
   real `.env` file.
3. **Open Railway** ([railway.app](https://railway.app)) and sign in.
4. **Create a new project** → "Deploy from GitHub repo" → select the repo
   from step 1.
5. **Deploy from GitHub** — Railway will detect `package.json` and run
   `npm install` automatically.
6. **Add environment variables** in the Railway project's **Variables** tab:
   - `BOT_TOKEN` — from [@BotFather](https://t.me/BotFather)
   - `SERVER_SECRET` — a long random string (see `.env.example` for how to
     generate one)
   - `BACKEND_URL` — leave blank for the first deploy; you'll fill it in
     after step 8
   - `ALLOWED_ORIGINS` — your frontend's origin, e.g.
     `https://okmobile.example.com`
   - `BOT_USERNAME` — your bot's `@username`, without the `@`
7. **Deploy** — trigger a deploy (Railway does this automatically after you
   connect the repo, and again whenever you push).
8. **Copy the Railway public URL** — in the service's **Settings →
   Networking** tab, generate a public domain, e.g.
   `https://ok-mobile-bot-production.up.railway.app`.
9. **Configure the Telegram webhook** — set `BACKEND_URL` to that URL in
   Railway's Variables tab (no trailing slash) and redeploy. On boot,
   `server.js` automatically calls `setWebhook` for you. You can confirm it
   worked by visiting:
   `https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo`
10. **Test `/start`** — open `https://t.me/<your_bot_username>` in Telegram
    and send `/start` (or use the deep link with a real token from
    `/api/auth/register`). You should see the "Подтвердить регистрацию"
    button.
11. **Test registration verification** — from the OK-Mobile frontend (or
    `curl`), call `/api/auth/register`, open the returned deep link, tap
    confirm, receive the code in Telegram, then call `/api/auth/verify` with
    that code and confirm you get `{ "status": "verified" }`.

## Production notes

- Sessions are stored **in memory** in this demo (`Map`). That's fine for a
  single Railway instance but is lost on restart/redeploy and won't work if
  you scale to multiple instances. Swap the `sessions` Map for Redis or a
  Postgres table before relying on this in production.
- Rotate `SERVER_SECRET` and `BOT_TOKEN` if they're ever exposed.
- The main user database, password hashing, and session/JWT issuance for the
  logged-in app belong in your primary backend — this service only handles
  Telegram verification.
