'use strict';
// Запуск: npm test   (node --test). Нужен только SQLite-драйвер (better-sqlite3 или node:sqlite), Telegram не нужен.
process.env.BOT_TOKEN = process.env.BOT_TOKEN || 'test';
process.env.SERVER_SECRET = process.env.SERVER_SECRET || 'test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, openDb, Store, Core } = require('./server.js');

class FakeTg {
  constructor() { this.sent = []; this.edits = []; this.answers = []; this.nextId = 100; this.mode = 'ok'; }
  async send(chatId, text, o = {}) {
    if (this.mode === 'blocked') return { ok: false, code: 403, blocked: true };
    if (this.mode === 'down') return { ok: false, code: 500 };
    const id = this.nextId++; this.sent.push({ chatId, text, o, id }); return { ok: true, id };
  }
  async edit(chatId, msgId, text, o) { this.edits.push({ chatId, msgId, text, o }); return true; }
  async answer(id, text, alert) { this.answers.push({ id, text, alert }); }
  lastCode(chatId) {
    const m = [...this.sent].reverse().find(x => x.chatId === chatId && /<code>\d{6}<\/code>/.test(x.text));
    return m ? m.text.match(/<code>(\d{6})<\/code>/)[1] : null;
  }
}

function setup(env = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'okm-')), 'db.sqlite3');
  const cfg = loadConfig({ BOT_TOKEN: 'x', SERVER_SECRET: 'secretsecretsecret', SQLITE_PATH: file, ADMIN_IDS: '777', ...env });
  const { db } = openDb(file);
  const clock = { t: 1_700_000_000_000 };
  const tg = new FakeTg();
  const core = new Core({ cfg, store: new Store(db), tg, now: () => clock.t });
  return { cfg, db, file, clock, tg, core };
}
const USER = { id: 55, first_name: 'Ali', username: 'ali' };
const CHAT = 55;

async function startFlow(ctx, phone = '+992 90 123 45 67') {
  const r = ctx.core.register({ name: 'Иванов Иван', phone, ip: '1.1.1.1' });
  assert.ok(r.ok, JSON.stringify(r));
  const { token } = r.body;
  await ctx.core.onStart({ payload: token, from: USER, chatId: CHAT });
  await ctx.core.onConfirm({ token, from: USER, chatId: CHAT, cbId: 'cb1' });
  return token;
}

test('полный сценарий: код → verify → привязка → notify', async () => {
  const c = setup();
  const token = await startFlow(c);
  const code = c.tg.lastCode(CHAT);
  assert.match(code, /^\d{6}$/);
  assert.equal(c.core.verify({ token, code: '000000' === code ? '111111' : '000000', ip: 'a' }).body.error, 'Неверный код');
  const ok = c.core.verify({ token, code, ip: 'a' });
  assert.ok(ok.ok);
  assert.equal(ok.body.status, 'verified');
  assert.match(ok.body.notifyToken, /^[a-f0-9]{32}$/);
  await new Promise(r => setImmediate(r));
  assert.ok(c.tg.edits.some(e => /Регистрация подтверждена/.test(e.text)), 'код в чате заменён на «подтверждено»');
  assert.ok(c.tg.sent.some(m => m.chatId === 777 && /Новая регистрация/.test(m.text)), 'админ уведомлён');
  const n = await c.core.notify({ phone: '901234567', notifyToken: ok.body.notifyToken, title: 'Продажа', message: 'Новая продажа <b>' });
  assert.ok(n.ok);
  assert.equal(c.tg.sent.at(-1).text, 'Продажа\n\nНовая продажа <b>'); // plain, без HTML-разметки
  const bad = await c.core.notify({ phone: '901234567', notifyToken: 'f'.repeat(32), message: 'x' });
  assert.equal(bad.status, 403);
});

test('состояние переживает перезапуск (notifyToken остаётся рабочим)', async () => {
  const c = setup();
  const token = await startFlow(c);
  const v = c.core.verify({ token, code: c.tg.lastCode(CHAT), ip: 'a' });
  c.db.close();
  const { db } = openDb(c.file);
  const core2 = new Core({ cfg: c.cfg, store: new Store(db), tg: c.tg, now: () => c.clock.t });
  const n = await core2.notify({ phone: '901234567', notifyToken: v.body.notifyToken, message: 'после рестарта' });
  assert.ok(n.ok);
});

test('код истёк: таймер правит сообщение, кнопка даёт новый код, старый не подходит', async () => {
  const c = setup();
  const token = await startFlow(c);
  const oldCode = c.tg.lastCode(CHAT);
  c.clock.t += 5 * 60_000 + 1000;
  assert.equal(c.core.verify({ token, code: oldCode, ip: 'a' }).status, 410);
  await c.core.tick();
  assert.ok(c.tg.edits.some(e => /истёк/.test(e.text) && e.o.markup), 'сообщение с кодом заменено на «истёк» + кнопка');
  await c.core.onNewCode({ token, from: USER, chatId: CHAT, cbId: 'cb2' });
  const newCode = c.tg.lastCode(CHAT);
  assert.ok(newCode);
  if (newCode !== oldCode) assert.equal(c.core.verify({ token, code: oldCode, ip: 'a' }).status, 400);
  assert.ok(c.core.verify({ token, code: newCode, ip: 'a' }).ok);
});

test('повторная отправка: кулдаун и лимит; API resend не обходит подтверждение', async () => {
  const c = setup();
  const r = c.core.register({ name: 'Иванов Иван', phone: '901234567', ip: 'z' });
  const token = r.body.token;
  await c.core.onStart({ payload: token, from: USER, chatId: CHAT });
  assert.equal((await c.core.resend({ token, ip: 'z' })).status, 409, 'до подтверждения в боте код слать нельзя');
  await c.core.onConfirm({ token, from: USER, chatId: CHAT, cbId: 'c' });
  const cool = await c.core.resend({ token, ip: 'z' });
  assert.equal(cool.status, 429);
  assert.ok(cool.body.retryAfter > 0);
  for (let i = 0; i < c.cfg.maxResends; i++) {
    c.clock.t += 60_000;
    assert.ok((await c.core.resend({ token, ip: 'z' })).ok, `resend #${i + 1}`);
  }
  c.clock.t += 60_000;
  assert.equal((await c.core.resend({ token, ip: 'z' })).status, 429, 'лимит повторных отправок');
});

test('неверные коды: 5 на код, 15 всего → блокировка; брутфорс через resend невозможен', async () => {
  const c = setup();
  const token = await startFlow(c);
  const real = c.tg.lastCode(CHAT);
  const wrong = real === '123456' ? '654321' : '123456';
  for (let i = 1; i <= 5; i++) {
    const r = c.core.verify({ token, code: wrong, ip: 'a' });
    assert.equal(r.status, 400);
    assert.equal(r.body.attemptsLeft, 5 - i);
  }
  assert.equal(c.core.verify({ token, code: real, ip: 'a' }).status, 429, 'после 5 ошибок даже верный код не принимается');
  for (let round = 0; round < 2; round++) {
    c.clock.t += 60_000;
    assert.ok((await c.core.resend({ token, ip: 'a' })).ok);
    const w = c.tg.lastCode(CHAT) === wrong ? '999999' : wrong;
    for (let i = 0; i < 5; i++) c.core.verify({ token, code: w, ip: `ip${round}` });
  }
  const s = c.db.prepare('SELECT status FROM sessions WHERE token=?').get(token);
  assert.equal(s.status, 'blocked');
});

test('чужой Telegram не может занять ссылку; чужой пользователь не жмёт кнопки', async () => {
  const c = setup();
  const { token } = c.core.register({ name: 'Иванов Иван', phone: '901234567', ip: 'x' }).body;
  await c.core.onStart({ payload: token, from: USER, chatId: CHAT });
  await c.core.onStart({ payload: token, from: { id: 99 }, chatId: 99 });
  assert.match(c.tg.sent.at(-1).text, /уже использована/);
  await c.core.onConfirm({ token, from: { id: 99 }, chatId: 99, cbId: 'evil' });
  assert.equal(c.tg.answers.at(-1).text, 'Нет доступа');
  assert.equal(c.tg.lastCode(99), null);
});

test('REQUIRE_CONTACT: чужой номер → блокировка, свой номер → код', async () => {
  const c = setup({ REQUIRE_CONTACT: '1' });
  let { token } = c.core.register({ name: 'Иванов Иван', phone: '901234567', ip: 'x' }).body;
  await c.core.onStart({ payload: token, from: USER, chatId: CHAT });
  await c.core.onConfirm({ token, from: USER, chatId: CHAT, cbId: 'c' });
  assert.equal(c.tg.lastCode(CHAT), null, 'без контакта кода нет');
  assert.equal((await c.core.resend({ token, ip: 'x' })).status, 409, 'через API тоже не обойти');
  await c.core.onContact({ contact: { user_id: 12345, phone_number: '992901234567' }, from: USER, chatId: CHAT });
  assert.equal(c.tg.lastCode(CHAT), null, 'контакт другого человека не принимается');
  await c.core.onContact({ contact: { user_id: USER.id, phone_number: '+992 900 00 00 00' }, from: USER, chatId: CHAT });
  assert.equal(c.db.prepare('SELECT status FROM sessions WHERE token=?').get(token).status, 'blocked');

  ({ token } = c.core.register({ name: 'Иванов Иван', phone: '901234567', ip: 'x' }).body);
  await c.core.onStart({ payload: token, from: USER, chatId: CHAT });
  await c.core.onConfirm({ token, from: USER, chatId: CHAT, cbId: 'c2' });
  await c.core.onContact({ contact: { user_id: USER.id, phone_number: '992901234567' }, from: USER, chatId: CHAT });
  assert.match(c.tg.lastCode(CHAT), /^\d{6}$/);
});

test('сбой Telegram: код не «сгорает», notify помечает заблокировавшего бота', async () => {
  const c = setup();
  const { token } = c.core.register({ name: 'Иванов Иван', phone: '901234567', ip: 'x' }).body;
  await c.core.onStart({ payload: token, from: USER, chatId: CHAT });
  c.tg.mode = 'down';
  await c.core.onConfirm({ token, from: USER, chatId: CHAT, cbId: 'c' });
  assert.equal(c.db.prepare('SELECT status FROM sessions WHERE token=?').get(token).status, 'pending_telegram');
  c.tg.mode = 'ok';
  await c.core.onConfirm({ token, from: USER, chatId: CHAT, cbId: 'c2' });
  const v = c.core.verify({ token, code: c.tg.lastCode(CHAT), ip: 'a' });
  assert.ok(v.ok);
  c.tg.mode = 'blocked';
  const n = await c.core.notify({ phone: '901234567', notifyToken: v.body.notifyToken, message: 'x' });
  assert.equal(n.status, 410);
  c.tg.mode = 'ok';
  assert.equal((await c.core.notify({ phone: '901234567', notifyToken: v.body.notifyToken, message: 'x' })).status, 409, 'уведомления отключены');
});

test('повторный verify после успеха (потерялся ответ) выдаёт новый рабочий токен', async () => {
  const c = setup();
  const token = await startFlow(c);
  const code = c.tg.lastCode(CHAT);
  const v1 = c.core.verify({ token, code, ip: 'a' });
  const v2 = c.core.verify({ token, code, ip: 'a' });
  assert.ok(v2.ok);
  assert.notEqual(v1.body.notifyToken, v2.body.notifyToken);
  assert.ok((await c.core.notify({ phone: '901234567', notifyToken: v2.body.notifyToken, message: 'ok' })).ok);
  assert.equal((await c.core.notify({ phone: '901234567', notifyToken: v1.body.notifyToken, message: 'old' })).status, 403);
  assert.equal(c.core.verify({ token, code: '000000', ip: 'a' }).status, 400, 'без верного кода — нельзя');
});

test('перепривязка номера к другому Telegram предупреждает прежнего владельца', async () => {
  const c = setup();
  const t1 = await startFlow(c);
  c.core.verify({ token: t1, code: c.tg.lastCode(CHAT), ip: 'a' });
  const other = { id: 66, first_name: 'Eve' };
  const { token } = c.core.register({ name: 'Eve', phone: '901234567', ip: 'b' }).body;
  await c.core.onStart({ payload: token, from: other, chatId: 66 });
  await c.core.onConfirm({ token, from: other, chatId: 66, cbId: 'e' });
  c.core.verify({ token, code: c.tg.lastCode(66), ip: 'b' });
  await new Promise(r => setImmediate(r));
  assert.ok(c.tg.sent.some(m => m.chatId === CHAT && /привязан к другому аккаунту/.test(m.text)));
});

test('лимиты регистрации: по IP и по номеру; валидация', () => {
  const c = setup();
  assert.equal(c.core.register({ name: 'x', phone: '901234567', ip: '1' }).status, 400);
  assert.equal(c.core.register({ name: 'Иванов Иван', phone: '123', ip: '1' }).status, 400);
  for (let i = 0; i < c.cfg.maxSessionsPerPhoneHour; i++) assert.ok(c.core.register({ name: 'Иванов Иван', phone: '911111111', ip: `p${i}` }).ok);
  assert.equal(c.core.register({ name: 'Иванов Иван', phone: '911111111', ip: 'pX' }).status, 429);
  const c2 = setup();
  for (let i = 0; i < 10; i++) assert.ok(c2.core.register({ name: 'Иванов Иван', phone: `90000000${i}`, ip: 'same' }).ok);
  assert.equal(c2.core.register({ name: 'Иванов Иван', phone: '900000099', ip: 'same' }).status, 429);
});

test('команды: /status, /unlink, /stats, /find, /revoke', async () => {
  const c = setup();
  const token = await startFlow(c);
  const v = c.core.verify({ token, code: c.tg.lastCode(CHAT), ip: 'a' });
  await new Promise(r => setTimeout(r, 20)); // дать фоновым уведомлениям (админу) завершиться
  await c.core.cmdStatus(CHAT);
  assert.match(c.tg.sent.at(-1).text, /включены/);
  await c.core.cmdStats(777);
  assert.match(c.tg.sent.at(-1).text, /Подтверждённых аккаунтов: <b>1<\/b>/);
  await c.core.cmdFind(777, '+992901234567');
  assert.match(c.tg.sent.at(-1).text, /Иванов Иван/);
  await c.core.cmdUnlink(CHAT);
  assert.equal((await c.core.notify({ phone: '901234567', notifyToken: v.body.notifyToken, message: 'x' })).status, 409);
  await c.core.cmdRevoke(777, '901234567');
  assert.equal((await c.core.notify({ phone: '901234567', notifyToken: v.body.notifyToken, message: 'x' })).status, 403);
});

test('чистка: старые незавершённые сессии удаляются, живые остаются', async () => {
  const c = setup();
  const a = c.core.register({ name: 'Иванов Иван', phone: '901234567', ip: 'q' }).body.token;
  c.clock.t += 3 * 3_600_000;
  const b = c.core.register({ name: 'Иванов Иван', phone: '907654321', ip: 'q' }).body.token;
  await c.core.tick();
  assert.equal(c.core.session(a), undefined);
  assert.ok(c.core.session(b));
});
