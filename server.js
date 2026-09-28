/**
 * OK-Mobile Бухгалтерия — Telegram Verification Bot
 * ---------------------------------------------------
 * Responsibilities:
 *  - Issue short-lived, single-use verification sessions for the frontend
 *  - Open a Telegram deep link (t.me/<bot>?start=<token>) that maps to that session
 *  - Generate a secure 6-digit code, hash it, and send it to the user in Telegram
 *  - Verify the code the frontend submits, with attempt limiting and expiry
 *
 * SECURITY NOTES
 *  - BOT_TOKEN and SERVER_SECRET live only in environment variables (see .env.example).
 *    They are never sent to, or readable by, the frontend.
 *  - Codes are generated with crypto.randomInt (CSPRNG), never Math.random().
 *  - Codes are stored as SHA-256(code + SERVER_SECRET), never in plain text.
 *  - Sessions expire after 5 minutes and allow a maximum of 5 verification attempts.
 *  - This demo uses an in-memory Map for sessions. Replace with Redis/Postgres
 *    for a real multi-instance production deployment (in-memory state is lost
 *    on restart and does not work across multiple server instances).
 */

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { Telegraf } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
const BACKEND_URL = process.env.BACKEND_URL;
const SERVER_SECRET = process.env.SERVER_SECRET;
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

if (!BOT_TOKEN) {
  console.error('FATAL: BOT_TOKEN is not set. Add it to your environment variables.');
  process.exit(1);
}
if (!SERVER_SECRET) {
  console.error('FATAL: SERVER_SECRET is not set. Add it to your environment variables.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

// --- Minimal CORS (frontend only, no external libs) ---
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// -------------------------------------------------------------------------
// In-memory session store
// sessions: token -> { status, name, phone, telegramChatId, codeHash, expiresAt, attempts, createdAt }
// -------------------------------------------------------------------------
const sessions = new Map();
const CODE_TTL_MS = 5 * 60 * 1000;      // 5 minutes
const MAX_ATTEMPTS = 5;
const SESSION_TTL_MS = 15 * 60 * 1000;  // drop abandoned sessions after 15 min

function hashCode(code, token) {
  return crypto.createHash('sha256').update(`${code}:${token}:${SERVER_SECRET}`).digest('hex');
}
function generateCode() {
  // Cryptographically secure 6-digit code, 000000–999999, zero-padded.
  return crypto.randomInt(0, 1000000).toString().padStart(6, '0');
}
function generateToken() {
  return crypto.randomBytes(16).toString('hex'); // random, short-lived, single-use
}
function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [token, s] of sessions.entries()) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(token);
  }
}
setInterval(cleanupExpiredSessions, 60 * 1000);

// -------------------------------------------------------------------------
// PUBLIC API — called by the OK-Mobile frontend
// -------------------------------------------------------------------------

/**
 * POST /api/auth/register
 * Body: { name, phone, password }
 * Creates a pending registration + verification session.
 * NOTE: in this demo, password handling/hashing and the real user DB write
 * belong in your main backend, not this bot service. This endpoint only
 * issues the verification token the frontend needs to open Telegram.
 */
app.post('/api/auth/register', (req, res) => {
  const { name, phone } = req.body || {};
  if (!name || !phone) {
    return res.status(400).json({ error: 'name and phone are required' });
  }
  const token = generateToken();
  sessions.set(token, {
    status: 'pending_telegram',
    name,
    phone,
    telegramChatId: null,
    codeHash: null,
    expiresAt: null,
    attempts: 0,
    createdAt: Date.now(),
  });

  const botUsername = process.env.BOT_USERNAME || 'OKMobileBot';
  const deepLink = `https://t.me/${botUsername}?start=${token}`;
  res.json({ token, telegramDeepLink: deepLink });
});

/**
 * POST /api/auth/verify
 * Body: { token, code }
 */
app.post('/api/auth/verify', (req, res) => {
  const { token, code } = req.body || {};
  const session = sessions.get(token);

  if (!session) return res.status(404).json({ error: 'Сессия не найдена' });
  if (session.status !== 'code_sent') return res.status(400).json({ error: 'Код ещё не отправлен' });
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return res.status(410).json({ error: 'Код истёк, запросите новый' });
  }
  if (session.attempts >= MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Превышено число попыток. Запросите новый код.' });
  }

  session.attempts += 1;
  const isValid = session.codeHash === hashCode(code, token);
  if (!isValid) {
    return res.status(400).json({ error: 'Неверный код', attemptsLeft: MAX_ATTEMPTS - session.attempts });
  }

  session.status = 'verified';
  res.json({ status: 'verified', name: session.name, phone: session.phone });
});

/**
 * POST /api/auth/resend-verification
 * Body: { token }
 * Re-sends a fresh code to the same Telegram chat, if already linked.
 */
app.post('/api/auth/resend-verification', async (req, res) => {
  const { token } = req.body || {};
  const session = sessions.get(token);
  if (!session) return res.status(404).json({ error: 'Сессия не найдена' });
  if (!session.telegramChatId) return res.status(400).json({ error: 'Telegram ещё не подключён' });

  await sendVerificationCode(token, session);
  res.json({ status: 'code_resent' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'OK-Mobile Telegram Verification Bot' });
});

// -------------------------------------------------------------------------
// TELEGRAM BOT LOGIC
// -------------------------------------------------------------------------

bot.start(async (ctx) => {
  const token = (ctx.startPayload || '').trim();
  const session = sessions.get(token);

  if (!token || !session) {
    return ctx.reply('Ссылка недействительна или устарела. Начните регистрацию заново в приложении OK-Mobile.');
  }

  session.telegramChatId = ctx.chat.id;

  await ctx.reply(
    'OK-Mobile Бухгалтерия\n\nДля подтверждения регистрации нажмите кнопку ниже.',
    {
      reply_markup: {
        inline_keyboard: [[{ text: 'Подтвердить регистрацию', callback_data: `confirm:${token}` }]],
      },
    }
  );
});

bot.action(/confirm:(.+)/, async (ctx) => {
  const token = ctx.match[1];
  const session = sessions.get(token);
  if (!session) {
    await ctx.answerCbQuery('Сессия не найдена');
    return;
  }
  await sendVerificationCode(token, session, ctx);
  await ctx.answerCbQuery();
});

async function sendVerificationCode(token, session, ctx) {
  const code = generateCode();
  session.codeHash = hashCode(code, token);
  session.expiresAt = Date.now() + CODE_TTL_MS;
  session.attempts = 0;
  session.status = 'code_sent';

  const text = `Ваш код подтверждения OK-Mobile:\n\n${code}\n\nКод действует 5 минут.\nНикому не сообщайте этот код.`;

  if (ctx) {
    await ctx.reply(text);
  } else if (session.telegramChatId) {
    await bot.telegram.sendMessage(session.telegramChatId, text);
  }
}

// -------------------------------------------------------------------------
// WEBHOOK — Railway-friendly (no long polling)
// -------------------------------------------------------------------------
app.use(bot.webhookCallback('/telegram/webhook'));

app.listen(PORT, async () => {
  console.log(`OK-Mobile verification bot listening on port ${PORT}`);
  if (BACKEND_URL) {
    try {
      await bot.telegram.setWebhook(`${BACKEND_URL}/telegram/webhook`);
      console.log(`Webhook set to ${BACKEND_URL}/telegram/webhook`);
    } catch (err) {
      console.error('Failed to set Telegram webhook:', err.message);
    }
  } else {
    console.warn('BACKEND_URL is not set — webhook was not registered automatically.');
  }
});
