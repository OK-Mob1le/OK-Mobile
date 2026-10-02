'use strict';
/* ============================================================
   OK-Mobile Бухгалтерия — Backend (Express + Telegram Bot)
   Данные: PostgreSQL (DATABASE_URL) или локальный JSON-файл.
   ============================================================ */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  PORT: process.env.PORT || 3000,
  BOT_TOKEN: process.env.BOT_TOKEN || '',
  DATABASE_URL: process.env.DATABASE_URL || '',
  JWT_SECRET: process.env.JWT_SECRET || 'ok-mobile-dev-secret-change-me',
  FRONTEND_URL: process.env.FRONTEND_URL || '*',
  DEV_RETURN_CODE: String(process.env.DEV_RETURN_CODE || '').toLowerCase() === 'true',
  CODE_TTL_MIN: 5
};

/* ================= SCHEMA ================= */
const SCHEMA = {
  users: ['id','telegram_id','phone','name','gender','region','company_id','created_at','updated_at'],
  companies: ['id','name','owner_id','currency','language','region','tax_id','phone','address','created_at','updated_at'],
  products: ['id','company_id','name','sku','barcode','category','unit','purchase_price','sale_price','quantity','min_quantity','supplier_id','description','created_at','updated_at'],
  sales: ['id','company_id','customer_id','customer_name','subtotal','discount','tax','total','currency','payment_method','comment','items','created_at','updated_at'],
  sale_items: ['id','company_id','sale_id','product_id','name','quantity','price','total','created_at'],
  purchases: ['id','company_id','supplier_id','supplier_name','number','date','total','currency','comment','items','created_at','updated_at'],
  purchase_items: ['id','company_id','purchase_id','product_id','name','quantity','purchase_price','sale_price','total','created_at'],
  customers: ['id','company_id','name','company','phone','address','tax_id','balance','comment','total_purchases','paid','created_at','updated_at'],
  suppliers: ['id','company_id','name','contact','phone','address','tax_id','balance','created_at','updated_at'],
  dealers: ['id','company_id','name','company','phone','region','discount_percent','status','created_at','updated_at'],
  documents: ['id','company_id','type','number','date','party','total','currency','status','created_by','items','comment','created_at','updated_at'],
  cash_transactions: ['id','company_id','type','method','amount','currency','description','created_at','updated_at'],
  verification_codes: ['id','session_id','phone','name','company','gender','region','telegram_user_id','verification_code','expires_at','verified','created_at','updated_at']
};
const JSON_COLS = ['items'];
const NO_COMPANY = { companies:true, verification_codes:true };

/* ================= DB LAYER ================= */
let pool = null;
let store = null;
const STORE_FILE = path.join(__dirname, 'data.json');

function initStore(){
  try{ store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); }catch(e){ store = { counters:{}, tables:{} }; }
  store.counters = store.counters || {}; store.tables = store.tables || {};
}
function saveStore(){ try{ fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2)); }catch(e){ console.error('store save', e.message); } }

function pick(table, data){
  const cols = SCHEMA[table] || [];
  const out = {};
  cols.forEach(c=>{ if(Object.prototype.hasOwnProperty.call(data, c) && data[c] !== undefined){ out[c] = JSON_COLS.indexOf(c)>=0 && data[c] && typeof data[c]==='object' ? JSON.stringify(data[c]) : data[c]; } });
  return out;
}
function fromDb(table, row){
  if(!row) return row;
  const out = Object.assign({}, row);
  JSON_COLS.forEach(c=>{ if(out[c]!=null && typeof out[c]==='string'){ try{ out[c] = JSON.parse(out[c]); }catch(e){ out[c]=[]; } } });
  ['purchase_price','sale_price','quantity','min_quantity','total','subtotal','discount','tax','balance','amount','discount_percent','total_purchases','paid','price'].forEach(c=>{ if(out[c]!=null) out[c]=Number(out[c]); });
  if(out.telegram_user_id!=null) out.telegram_user_id = String(out.telegram_user_id);
  return out;
}
async function dbList(table, companyId){
  if(pool){
    const cols = SCHEMA[table]||[];
    const useCompany = companyId && !NO_COMPANY[table];
    const sql = 'SELECT * FROM ' + table + (useCompany? ' WHERE company_id=$1':'') + ' ORDER BY id DESC';
    const r = await pool.query(sql, useCompany? [companyId] : []);
    return r.rows.map(row=>fromDb(table,row));
  }
  const arr = (store.tables[table]||[]).filter(row=> (companyId && !NO_COMPANY[table]) ? Number(row.company_id)===Number(companyId) : true);
  return arr.slice().sort((a,b)=>b.id-a.id).map(row=>fromDb(table,row));
}
async function dbGet(table, id){
  if(pool){ const r = await pool.query('SELECT * FROM '+table+' WHERE id=$1',[id]); return fromDb(table, r.rows[0]); }
  return fromDb(table, (store.tables[table]||[]).find(r=>Number(r.id)===Number(id)));
}
async function dbFindOne(table, where){
  const keys = Object.keys(where);
  if(pool){
    const ph = keys.map((k,i)=>k+'=$'+(i+1));
    const r = await pool.query('SELECT * FROM '+table+' WHERE '+ph.join(' AND ')+' LIMIT 1', keys.map(k=>where[k]));
    return fromDb(table, r.rows[0]);
  }
  return fromDb(table, (store.tables[table]||[]).find(r=> keys.every(k=> String(r[k])===String(where[k])) ));
}
async function dbInsert(table, data){
  const clean = pick(table, data);
  const now = new Date().toISOString();
  clean.created_at = clean.created_at || now; clean.updated_at = now;
  if(pool){
    const keys = Object.keys(clean); const ph = keys.map((k,i)=>'$'+(i+1));
    const r = await pool.query('INSERT INTO '+table+' ('+keys.join(',')+') VALUES ('+ph.join(',')+') RETURNING *', keys.map(k=>clean[k]));
    return fromDb(table, r.rows[0]);
  }
  store.counters[table] = (store.counters[table]||0)+1;
  const row = Object.assign({}, clean, {id: store.counters[table]});
  (store.tables[table]=store.tables[table]||[]).push(row); saveStore();
  return fromDb(table, row);
}
async function dbUpdate(table, id, data){
  const clean = pick(table, data); delete clean.id; clean.updated_at = new Date().toISOString();
  const keys = Object.keys(clean); if(!keys.length) return dbGet(table, id);
  if(pool){
    const ph = keys.map((k,i)=>k+'=$'+(i+1));
    const r = await pool.query('UPDATE '+table+' SET '+ph.join(', ')+' WHERE id=$'+(keys.length+1)+' RETURNING *', keys.map(k=>clean[k]).concat([id]));
    return fromDb(table, r.rows[0]);
  }
  const row = (store.tables[table]||[]).find(r=>Number(r.id)===Number(id));
  if(!row) return null; Object.assign(row, clean); saveStore();
  return fromDb(table, row);
}
async function dbDelete(table, id){
  if(pool){ await pool.query('DELETE FROM '+table+' WHERE id=$1',[id]); return true; }
  const arr = store.tables[table]||[]; const i = arr.findIndex(r=>Number(r.id)===Number(id));
  if(i<0) return false; arr.splice(i,1); saveStore(); return true;
}

async function ensureSchema(){
  if(!CONFIG.DATABASE_URL) return;
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: CONFIG.DATABASE_URL, ssl: /railway|render|heroku|amazonaws|neon|supabase/i.test(CONFIG.DATABASE_URL)? { rejectUnauthorized:false } : false });
  const DDL = [
    'CREATE TABLE IF NOT EXISTS companies (id SERIAL PRIMARY KEY, name TEXT, owner_id INTEGER, currency TEXT DEFAULT '+ "'TJS'" +', language TEXT DEFAULT '+ "'ru'" +', region TEXT, tax_id TEXT, phone TEXT, address TEXT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())',
    'CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, telegram_id TEXT, phone TEXT UNIQUE, name TEXT, gender TEXT, region TEXT, company_id INTEGER, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())',
    'CREATE TABLE IF NOT EXISTS products (id SERIAL PRIMARY KEY, company_id INTEGER, name TEXT, sku TEXT, barcode TEXT, category TEXT, unit TEXT DEFAULT '+ "'pcs'" +', purchase_price NUMERIC DEFAULT 0, sale_price NUMERIC DEFAULT 0, quantity NUMERIC DEFAULT 0, min_quantity NUMERIC DEFAULT 0, supplier_id INTEGER, description TEXT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())',
    'CREATE TABLE IF NOT EXISTS sales (id SERIAL PRIMARY KEY, company_id INTEGER, customer_id INTEGER, customer_name TEXT, subtotal NUMERIC DEFAULT 0, discount NUMERIC DEFAULT 0, tax NUMERIC DEFAULT 0, total NUMERIC DEFAULT 0, currency TEXT, payment_method TEXT, comment TEXT, items TEXT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())',
    'CREATE TABLE IF NOT EXISTS sale_items (id SERIAL PRIMARY KEY, company_id INTEGER, sale_id INTEGER, product_id INTEGER, name TEXT, quantity NUMERIC, price NUMERIC, total NUMERIC, created_at TIMESTAMPTZ DEFAULT now())',
    'CREATE TABLE IF NOT EXISTS purchases (id SERIAL PRIMARY KEY, company_id INTEGER, supplier_id INTEGER, supplier_name TEXT, number TEXT, date TEXT, total NUMERIC DEFAULT 0, currency TEXT, comment TEXT, items TEXT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())',
    'CREATE TABLE IF NOT EXISTS purchase_items (id SERIAL PRIMARY KEY, company_id INTEGER, purchase_id INTEGER, product_id INTEGER, name TEXT, quantity NUMERIC, purchase_price NUMERIC, sale_price NUMERIC, total NUMERIC, created_at TIMESTAMPTZ DEFAULT now())',
    'CREATE TABLE IF NOT EXISTS customers (id SERIAL PRIMARY KEY, company_id INTEGER, name TEXT, company TEXT, phone TEXT, address TEXT, tax_id TEXT, balance NUMERIC DEFAULT 0, comment TEXT, total_purchases NUMERIC DEFAULT 0, paid NUMERIC DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())',
    'CREATE TABLE IF NOT EXISTS suppliers (id SERIAL PRIMARY KEY, company_id INTEGER, name TEXT, contact TEXT, phone TEXT, address TEXT, tax_id TEXT, balance NUMERIC DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())',
    'CREATE TABLE IF NOT EXISTS dealers (id SERIAL PRIMARY KEY, company_id INTEGER, name TEXT, company TEXT, phone TEXT, region TEXT, discount_percent NUMERIC DEFAULT 0, status TEXT DEFAULT '+ "'active'" +', created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())',
    'CREATE TABLE IF NOT EXISTS documents (id SERIAL PRIMARY KEY, company_id INTEGER, type TEXT, number TEXT, date TEXT, party TEXT, total NUMERIC DEFAULT 0, currency TEXT, status TEXT, created_by TEXT, items TEXT, comment TEXT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())',
    'CREATE TABLE IF NOT EXISTS cash_transactions (id SERIAL PRIMARY KEY, company_id INTEGER, type TEXT, method TEXT, amount NUMERIC DEFAULT 0, currency TEXT, description TEXT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())',
    'CREATE TABLE IF NOT EXISTS verification_codes (id SERIAL PRIMARY KEY, session_id TEXT, phone TEXT, name TEXT, company TEXT, gender TEXT, region TEXT, telegram_user_id TEXT, verification_code TEXT, expires_at TIMESTAMPTZ, verified BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())'
  ];
  for(const sql of DDL){ try{ await pool.query(sql); }catch(e){ console.error('DDL error:', e.message); } }
  console.log('PostgreSQL schema ready');
}

/* ================= APP ================= */
const app = express();
app.use(cors({ origin: CONFIG.FRONTEND_URL === '*' ? true : CONFIG.FRONTEND_URL, credentials: false }));
app.use(express.json({ limit: '2mb' }));

/* ================= HELPERS ================= */
function genCode(){ return String(Math.floor(100000 + Math.random() * 900000)); }
function today(){ return new Date().toISOString().slice(0,10); }
function signToken(user){ return jwt.sign({ userId:user.id, companyId:user.company_id, name:user.name }, CONFIG.JWT_SECRET, { expiresIn:'30d' }); }
function auth(req,res,next){
  const h = req.headers.authorization || '';
  const token = h.indexOf('Bearer ')===0 ? h.slice(7) : '';
  if(!token) return res.status(401).json({ error:'Unauthorized', code:'unauthorized' });
  try{ req.user = jwt.verify(token, CONFIG.JWT_SECRET); next(); }
  catch(e){ return res.status(401).json({ error:'Invalid token', code:'unauthorized' }); }
}
function companyOf(req){ return req.user.companyId; }

/* ================= TELEGRAM ================= */
let bot = null;
function botUrl(){ return 'https://t.me/OKMobileBot'; }
function codeMessage(code){
  return '🔐 Код подтверждения OK-Mobile\n\nВаш код:\n' + code + '\n\nКод действителен ' + CONFIG.CODE_TTL_MIN + ' минут.\nЕсли вы не запрашивали регистрацию, просто проигнорируйте это сообщение.';
}
function sendTelegram(chatId, text){
  if(!bot || !chatId) return Promise.resolve(false);
  return bot.sendMessage(chatId, text).then(()=>true).catch(err=>{ console.error('sendTelegram:', err.message); return false; });
}
async function linkSession(sessionId, telegramUserId){
  const v = await dbFindOne('verification_codes', { session_id: sessionId });
  if(!v) return null;
  const updated = await dbUpdate('verification_codes', v.id, { telegram_user_id: String(telegramUserId) });
  await sendTelegram(telegramUserId, codeMessage(v.verification_code));
  return updated;
}
function startBot(){
  if(!CONFIG.BOT_TOKEN){ console.warn('BOT_TOKEN not set — Telegram bot disabled (API still works).'); return; }
  const TelegramBot = require('node-telegram-bot-api');
  bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling:true });
  bot.on('polling_error', e=>console.error('polling_error:', e.message));
  bot.onText(/^\/start(?:\s+(.+))?/, async (msg, match)=>{
    const chatId = msg.chat.id;
    const payload = match && match[1] ? match[1].trim() : '';
    if(payload){
      const v = await linkSession(payload, chatId);
      if(!v){ await sendTelegram(chatId, '⚠️ Сессия регистрации не найдена или истекла. Вернитесь на сайт и запросите код заново.'); return; }
      return;
    }
    await sendTelegram(chatId, 'Здравствуйте!\nДобро пожаловать в OK-Mobile Бухгалтерия.\n\nДля регистрации код подтверждения будет отправлен сюда.');
  });
  bot.onText(/^\/help/, (msg)=> sendTelegram(msg.chat.id, 'OK-Mobile Бухгалтерия — бот подтверждения регистрации.\n\nКоманды:\n/start — начать\n/language — язык\n/support — поддержка\n\nКод подтверждения приходит автоматически после запроса с сайта.'));
  bot.onText(/^\/language/, (msg)=> sendTelegram(msg.chat.id, '🌐 Язык / Забон / Language:\n🇹🇯 Тоҷикӣ\n🇷🇺 Русский\n🇬🇧 English\n\nВыберите язык в приложении: Настройки → Язык.'));
  bot.onText(/^\/support/, (msg)=> sendTelegram(msg.chat.id, '🛟 Поддержка OK-Mobile\nНапишите нам: support@ok-mobile.app\nСообщество: https://t.me/kodacommunity'));
  console.log('Telegram bot started (polling)');
}

/* ================= AUTH ROUTES ================= */
app.post('/api/auth/request', async (req,res)=>{
  try{
    const b = req.body || {};
    if(!b.phone) return res.status(400).json({ error:'Phone required', code:'required' });
    const sessionId = b.session_id || ('s_' + Date.now() + Math.random().toString(36).slice(2,8));
    const code = genCode();
    const expires = new Date(Date.now() + CONFIG.CODE_TTL_MIN*60000).toISOString();
    const existing = await dbFindOne('verification_codes', { session_id: sessionId });
    const payload = { phone:b.phone, name:b.name||'', company:b.company||'', gender:b.gender||'none', region:b.region||'TJ', verification_code:code, expires_at:expires, verified:false };
    if(existing) await dbUpdate('verification_codes', existing.id, payload);
    else await dbInsert('verification_codes', Object.assign({ session_id:sessionId }, payload));
    const user = await dbFindOne('users', { phone:b.phone });
    if(user && user.telegram_id) await sendTelegram(user.telegram_id, codeMessage(code));
    const resp = { session_id:sessionId, bot_url: botUrl()+'?start='+sessionId, expires_in: CONFIG.CODE_TTL_MIN*60 };
    if(CONFIG.DEV_RETURN_CODE || !CONFIG.BOT_TOKEN) resp.dev_code = code;
    res.json(resp);
  }catch(e){ console.error(e); res.status(500).json({ error:e.message }); }
});
app.get('/api/auth/session/:id', async (req,res)=>{
  const v = await dbFindOne('verification_codes', { session_id: req.params.id });
  if(!v) return res.status(404).json({ error:'Not found', code:'not_found' });
  res.json({ linked: !!v.telegram_user_id, expires_at: v.expires_at });
});
app.post('/api/auth/resend', async (req,res)=>{
  try{
    const sid = (req.body||{}).registration_session_id;
    const v = await dbFindOne('verification_codes', { session_id: sid });
    if(!v) return res.status(404).json({ error:'Session not found', code:'not_found' });
    const code = genCode();
    const expires = new Date(Date.now() + CONFIG.CODE_TTL_MIN*60000).toISOString();
    await dbUpdate('verification_codes', v.id, { verification_code:code, expires_at:expires, verified:false });
    if(v.telegram_user_id) await sendTelegram(v.telegram_user_id, codeMessage(code));
    const resp = { ok:true };
    if(CONFIG.DEV_RETURN_CODE || !CONFIG.BOT_TOKEN) resp.dev_code = code;
    res.json(resp);
  }catch(e){ res.status(500).json({ error:e.message }); }
});
app.post('/api/auth/verify', async (req,res)=>{
  try{
    const b = req.body || {};
    const v = await dbFindOne('verification_codes', { session_id: b.registration_session_id });
    if(!v) return res.status(400).json({ error:'Invalid session', code:'invalid' });
    if(new Date(v.expires_at) < new Date()) return res.status(400).json({ error:'Code expired', code:'expired' });
    if(String(v.verification_code) !== String(b.code||'')) return res.status(400).json({ error:'Invalid code', code:'invalid' });
    if(CONFIG.BOT_TOKEN && !v.telegram_user_id) return res.status(400).json({ error:'Telegram not linked', code:'not_linked' });
    let user = await dbFindOne('users', { phone: v.phone });
    let company = null;
    if(!user){
      company = await dbInsert('companies', { name: v.company || 'My Company', currency:'TJS', language:'ru', region:v.region });
      user = await dbInsert('users', { telegram_id:v.telegram_user_id||null, phone:v.phone, name:v.name||'', gender:v.gender||'none', region:v.region||'TJ', company_id:company.id });
      await dbUpdate('companies', company.id, { owner_id:user.id });
      await seedCompany(company.id, user.name);
    } else {
      company = user.company_id ? await dbGet('companies', user.company_id) : null;
      if(!company){
        company = await dbInsert('companies', { name: v.company || 'My Company', owner_id:user.id, currency:'TJS', language:'ru', region:v.region });
        user = await dbUpdate('users', user.id, { company_id:company.id });
        await seedCompany(company.id, user.name);
      }
      user = await dbUpdate('users', user.id, { telegram_id:v.telegram_user_id||user.telegram_id, name:v.name||user.name });
    }
    await dbUpdate('verification_codes', v.id, { verified:true });
    const token = signToken(user);
    res.json({
      token,
      user:{ id:user.id, name:user.name, phone:user.phone, gender:user.gender, region:user.region, company_id:user.company_id },
      company:{ id:company.id, name:company.name, currency:company.currency, language:company.language, region:company.region, tax_id:company.tax_id, phone:company.phone, address:company.address }
    });
  }catch(e){ console.error(e); res.status(500).json({ error:e.message }); }
});

/* ================= USER ================= */
app.get('/api/user', auth, async (req,res)=>{
  const u = await dbGet('users', req.user.userId);
  if(!u) return res.status(404).json({ error:'Not found' });
  const c = u.company_id ? await dbGet('companies', u.company_id) : null;
  res.json({ user:u, company:c });
});
app.put('/api/user', auth, async (req,res)=>{
  const b = req.body||{};
  const u = await dbUpdate('users', req.user.userId, { name:b.name, phone:b.phone, gender:b.gender, region:b.region });
  res.json(u);
});
app.put('/api/company', auth, async (req,res)=>{
  const b = req.body||{};
  const c = await dbUpdate('companies', companyOf(req), { name:b.name, tax_id:b.tax_id, phone:b.phone, address:b.address, currency:b.currency, language:b.language });
  res.json(c);
});

/* ================= CRUD ROUTES ================= */
const CRUD_TABLES = { products:'products', customers:'customers', suppliers:'suppliers', dealers:'dealers', documents:'documents' };
Object.keys(CRUD_TABLES).forEach(ep=>{
  const table = CRUD_TABLES[ep];
  app.get('/api/'+ep, auth, async (req,res)=>{ try{ res.json(await dbList(table, companyOf(req))); }catch(e){ res.status(500).json({error:e.message}); } });
  app.post('/api/'+ep, auth, async (req,res)=>{ try{ const row = await dbInsert(table, Object.assign({}, req.body, { company_id:companyOf(req) })); res.json(row); }catch(e){ res.status(500).json({error:e.message}); } });
  app.put('/api/'+ep+'/:id', auth, async (req,res)=>{
    try{
      const row = await dbGet(table, req.params.id);
      if(!row || Number(row.company_id)!==Number(companyOf(req))) return res.status(404).json({ error:'Not found', code:'not_found' });
      res.json(await dbUpdate(table, row.id, req.body));
    }catch(e){ res.status(500).json({error:e.message}); }
  });
  app.delete('/api/'+ep+'/:id', auth, async (req,res)=>{
    try{
      const row = await dbGet(table, req.params.id);
      if(!row || Number(row.company_id)!==Number(companyOf(req))) return res.status(404).json({ error:'Not found', code:'not_found' });
      await dbDelete(table, row.id); res.json({ ok:true });
    }catch(e){ res.status(500).json({error:e.message}); }
  });
});

/* ================= SALES ================= */
app.get('/api/sales', auth, async (req,res)=>{ try{ res.json(await dbList('sales', companyOf(req))); }catch(e){ res.status(500).json({error:e.message}); } });
app.post('/api/sales', auth, async (req,res)=>{
  try{
    const companyId = companyOf(req);
    const b = req.body || {};
    const items = (b.items||[]).filter(i=>i.product_id && Number(i.quantity)>0);
    if(!items.length) return res.status(400).json({ error:'No items', code:'required' });
    for(const it of items){
      const p = await dbGet('products', it.product_id);
      if(!p || Number(p.company_id)!==Number(companyId)) return res.status(404).json({ error:'Product not found', code:'not_found' });
      if(Number(p.quantity) < Number(it.quantity)) return res.status(400).json({ error:'Insufficient stock: '+p.name, code:'insufficient' });
    }
    const subtotal = items.reduce((s,i)=>s+Number(i.price||0)*Number(i.quantity),0);
    const discount = Number(b.discount||0), tax = Number(b.tax||0);
    const total = Math.max(0, subtotal - discount + tax);
    const currency = b.currency || 'TJS', method = b.payment_method || 'cash';
    for(const it of items){ const p = await dbGet('products', it.product_id); await dbUpdate('products', p.id, { quantity: Number(p.quantity) - Number(it.quantity) }); }
    const sale = await dbInsert('sales', { company_id:companyId, customer_id:b.customer_id||null, customer_name:b.customer_name||'', subtotal, discount, tax, total, currency, payment_method:method, comment:b.comment||'', items });
    for(const it of items){ await dbInsert('sale_items', { company_id:companyId, sale_id:sale.id, product_id:it.product_id, name:it.name||'', quantity:Number(it.quantity), price:Number(it.price||0), total:Number(it.price||0)*Number(it.quantity) }); }
    await dbInsert('cash_transactions', { company_id:companyId, type:'income', method, amount:total, currency, description:'Sale #'+sale.id });
    await dbInsert('documents', { company_id:companyId, type:'sale', number:'SALE-'+sale.id, date:today(), party:b.customer_name||'—', total, currency, status:'paid', created_by:req.user.name||'—' });
    if(b.customer_id){
      const c = await dbGet('customers', b.customer_id);
      if(c && Number(c.company_id)===Number(companyId)) await dbUpdate('customers', c.id, { total_purchases:Number(c.total_purchases||0)+total, paid:Number(c.paid||0)+total });
    }
    res.json(sale);
  }catch(e){ console.error(e); res.status(500).json({error:e.message}); }
});

/* ================= PURCHASES ================= */
app.get('/api/purchases', auth, async (req,res)=>{ try{ res.json(await dbList('purchases', companyOf(req))); }catch(e){ res.status(500).json({error:e.message}); } });
app.post('/api/purchases', auth, async (req,res)=>{
  try{
    const companyId = companyOf(req);
    const b = req.body || {};
    const items = (b.items||[]).filter(i=>i.product_id && Number(i.quantity)>0);
    if(!items.length) return res.status(400).json({ error:'No items', code:'required' });
    let total = 0;
    for(const it of items){
      const p = await dbGet('products', it.product_id);
      if(!p || Number(p.company_id)!==Number(companyId)) return res.status(404).json({ error:'Product not found', code:'not_found' });
      const patch = { quantity: Number(p.quantity) + Number(it.quantity) };
      if(it.purchase_price!=null) patch.purchase_price = Number(it.purchase_price);
      if(it.sale_price!=null) patch.sale_price = Number(it.sale_price);
      await dbUpdate('products', p.id, patch);
      total += Number(it.quantity) * Number(it.purchase_price||0);
    }
    const currency = b.currency || 'TJS';
    const purchase = await dbInsert('purchases', { company_id:companyId, supplier_id:b.supplier_id||null, supplier_name:b.supplier_name||'', number:b.number||('PR-'+Date.now().toString().slice(-6)), date:b.date||today(), total, currency, comment:b.comment||'', items });
    for(const it of items){ await dbInsert('purchase_items', { company_id:companyId, purchase_id:purchase.id, product_id:it.product_id, name:it.name||'', quantity:Number(it.quantity), purchase_price:Number(it.purchase_price||0), sale_price:Number(it.sale_price||0), total:Number(it.quantity)*Number(it.purchase_price||0) }); }
    await dbInsert('documents', { company_id:companyId, type:'purchase', number:purchase.number, date:purchase.date, party:b.supplier_name||'—', total, currency, status:'paid', created_by:req.user.name||'—' });
    res.json(purchase);
  }catch(e){ console.error(e); res.status(500).json({error:e.message}); }
});

/* ================= CASH ================= */
app.get('/api/cash', auth, async (req,res)=>{ try{ res.json(await dbList('cash_transactions', companyOf(req))); }catch(e){ res.status(500).json({error:e.message}); } });
app.post('/api/cash', auth, async (req,res)=>{
  try{
    const b = req.body||{};
    const row = await dbInsert('cash_transactions', { company_id:companyOf(req), type:b.type==='expense'?'expense':'income', method:b.method||'cash', amount:Number(b.amount||0), currency:b.currency||'TJS', description:b.description||'' });
    res.json(row);
  }catch(e){ res.status(500).json({error:e.message}); }
});

/* ================= DASHBOARD / REPORTS ================= */
function sum(arr, f){ return arr.reduce((s,x)=>s+Number(f(x)||0),0); }
app.get('/api/dashboard', auth, async (req,res)=>{
  try{
    const companyId = companyOf(req);
    const [sales, purchases, cash, products, customers] = await Promise.all([
      dbList('sales', companyId), dbList('purchases', companyId), dbList('cash_transactions', companyId), dbList('products', companyId), dbList('customers', companyId)
    ]);
    const s = sum(sales, x=>x.total);
    const p = sum(purchases, x=>x.total);
    const exp = sum(cash.filter(c=>c.type==='expense'), x=>x.amount);
    res.json({ sales:s, purchases:p, expenses:exp, profit:s-exp, products:sum(products, x=>x.quantity), debts:sum(customers, x=>Math.max(0, x.balance)), deltas:{ sales:12, purchases:8, expenses:-3, profit:15, products:5, debts:-2 } });
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.get('/api/reports', auth, async (req,res)=>{
  try{
    const companyId = companyOf(req);
    const [sales, purchases, cash, products, customers, suppliers, dealers] = await Promise.all([
      dbList('sales', companyId), dbList('purchases', companyId), dbList('cash_transactions', companyId), dbList('products', companyId), dbList('customers', companyId), dbList('suppliers', companyId), dbList('dealers', companyId)
    ]);
    const from = req.query.from ? new Date(req.query.from+'T00:00:00') : null;
    const to = req.query.to ? new Date(req.query.to+'T23:59:59') : null;
    const inRange = dt => { const d = new Date(dt); if(from && d<from) return false; if(to && d>to) return false; return true; };
    const s = sum(sales.filter(x=>inRange(x.created_at)), x=>x.total);
    const p = sum(purchases.filter(x=>inRange(x.created_at)), x=>x.total);
    const c = cash.filter(x=>inRange(x.created_at));
    const income = sum(c.filter(x=>x.type==='income'), x=>x.amount);
    const exp = sum(c.filter(x=>x.type==='expense'), x=>x.amount);
    res.json({
      sales:{count:sales.length, total:s},
      purchases:{count:purchases.length, total:p},
      warehouse:{count:products.length, qty:sum(products,x=>x.quantity), value:sum(products,x=>Number(x.quantity)*Number(x.sale_price))},
      profit:{sales:s, expenses:exp, profit:s-exp},
      expenses:{total:exp},
      customerDebts:{total:sum(customers,x=>Math.max(0,x.balance)), items:customers.filter(x=>Number(x.balance)>0)},
      supplierDebts:{total:sum(suppliers,x=>Math.max(0,x.balance)), items:suppliers.filter(x=>Number(x.balance)>0)},
      cashflow:{balance:income-exp, income, expense:exp},
      dealers:{count:dealers.length, active:dealers.filter(x=>x.status==='active').length}
    });
  }catch(e){ res.status(500).json({error:e.message}); }
});

/* ================= DEMO SEED ================= */
async function seedCompany(companyId, ownerName){
  const P = [
    {name:'Смартфон Samsung A15', sku:'SM-A15', category:'Электроника', unit:'pcs', purchase_price:1400, sale_price:1850, quantity:120, min_quantity:20},
    {name:'Ноутбук Lenovo IdeaPad', sku:'LP-14', category:'Электроника', unit:'pcs', purchase_price:4200, sale_price:5400, quantity:45, min_quantity:10},
    {name:'Наушники JBL Tune', sku:'JBL-T', category:'Электроника', unit:'pcs', purchase_price:180, sale_price:280, quantity:200, min_quantity:30},
    {name:'Телевизор LG 43"', sku:'LG-43', category:'Электроника', unit:'pcs', purchase_price:2200, sale_price:2900, quantity:30, min_quantity:5},
    {name:'Чайник Beko', sku:'BK-K', category:'Бытовая техника', unit:'pcs', purchase_price:120, sale_price:190, quantity:150, min_quantity:25},
    {name:'Миксер Philips', sku:'PH-M', category:'Бытовая техника', unit:'pcs', purchase_price:350, sale_price:490, quantity:80, min_quantity:15},
    {name:'Пылесос Dyson V8', sku:'DY-V', category:'Бытовая техника', unit:'pcs', purchase_price:2600, sale_price:3400, quantity:18, min_quantity:5},
    {name:'Футболка мужская', sku:'TS-M', category:'Одежда', unit:'pcs', purchase_price:45, sale_price:89, quantity:300, min_quantity:50},
    {name:'Джинсы Classic', sku:'JN-32', category:'Одежда', unit:'pcs', purchase_price:120, sale_price:220, quantity:90, min_quantity:20},
    {name:'Кроссовки Nike', sku:'NK-42', category:'Обувь', unit:'pcs', purchase_price:380, sale_price:620, quantity:70, min_quantity:15},
    {name:'Рюкзак городской', sku:'BP-01', category:'Аксессуары', unit:'pcs', purchase_price:90, sale_price:160, quantity:110, min_quantity:20},
    {name:'Часы Casio', sku:'CS-01', category:'Аксессуары', unit:'pcs', purchase_price:260, sale_price:420, quantity:32, min_quantity:10}
  ];
  const prods = [];
  for(const x of P){ prods.push(await dbInsert('products', Object.assign({ company_id:companyId }, x))); }
  const cust = await dbInsert('customers', { company_id:companyId, name:'ООО «Ромашка»', company:'ООО «Ромашка»', phone:'+992 900 11 22 33', address:'г. Душанбе, ул. Рудаки 45', tax_id:'0100123456', balance:18500, total_purchases:18500, paid:0, comment:'Постоянный клиент' });
  await dbInsert('customers', { company_id:companyId, name:'Магазин «Барака»', company:'ИП Каримов', phone:'+992 900 55 66 77', address:'г. Худжанд', balance:0 });
  await dbInsert('customers', { company_id:companyId, name:'Эхсон Рахимов', phone:'+992 900 99 88 77', address:'г. Душанбе', balance:0 });
  const sup = await dbInsert('suppliers', { company_id:companyId, name:'ООО «ТехноСнаб»', contact:'Рустам Ахмедов', phone:'+992 900 10 20 30', address:'г. Душанбе', tax_id:'0100345678', balance:12000 });
  await dbInsert('suppliers', { company_id:companyId, name:'Global Trade LLC', contact:'Alex Wang', phone:'+86 138 0000 1111', address:'г. Гуанчжоу', balance:0 });
  await dbInsert('dealers', { company_id:companyId, name:'Азиз Каримов', company:'«Азиз Трейд»', phone:'+992 900 77 88 99', region:'TJ', discount_percent:10, status:'active' });
  await dbInsert('dealers', { company_id:companyId, name:'Иван Петров', company:'«Петров Групп»', phone:'+7 900 222 33 44', region:'RU', discount_percent:7, status:'active' });
  const now = new Date().toISOString();
  const saleItems = [{ product_id:prods[0].id, name:prods[0].name, quantity:10, price:1850, total:18500 }];
  await dbInsert('sales', { company_id:companyId, customer_id:cust.id, customer_name:cust.name, subtotal:18500, discount:0, tax:0, total:18500, currency:'TJS', payment_method:'cash', comment:'', items:saleItems, created_at:now });
  const purItems = [{ product_id:prods[1].id, name:prods[1].name, quantity:10, purchase_price:4200, sale_price:5400, total:42000 }];
  await dbInsert('purchases', { company_id:companyId, supplier_id:sup.id, supplier_name:sup.name, number:'PR-1001', date:today(), total:42000, currency:'TJS', comment:'', items:purItems, created_at:now });
  await dbInsert('cash_transactions', { company_id:companyId, type:'income', method:'cash', amount:50000, currency:'TJS', description:'Начальный остаток' });
  await dbInsert('cash_transactions', { company_id:companyId, type:'income', method:'cash', amount:18500, currency:'TJS', description:'Поступления от продаж (наличные)' });
  await dbInsert('cash_transactions', { company_id:companyId, type:'expense', method:'cash', amount:8200, currency:'TJS', description:'Аренда офиса' });
  await dbInsert('documents', { company_id:companyId, type:'sale', number:'SALE-1', date:today(), party:cust.name, total:18500, currency:'TJS', status:'paid', created_by:ownerName||'—' });
  await dbInsert('documents', { company_id:companyId, type:'purchase', number:'PR-1001', date:today(), party:sup.name, total:42000, currency:'TJS', status:'paid', created_by:ownerName||'—' });
  console.log('Demo data seeded for company', companyId);
}

/* ================= HEALTH / STATIC / START ================= */
app.get('/api/health', (req,res)=> res.json({ ok:true, db: pool? 'postgres' : 'json', bot: !!bot, time:new Date().toISOString() }));
app.get('/', (req,res)=>{
  const file = path.join(__dirname, '..', 'index.html');
  if(fs.existsSync(file)) res.sendFile(file); else res.json({ name:'OK-Mobile Бухгалтерия API', status:'ok' });
});
app.use((err, req, res, next)=>{ console.error(err); res.status(500).json({ error: err.message }); });

(async function start(){
  try{
    if(CONFIG.DATABASE_URL){ await ensureSchema(); }
    else { initStore(); console.log('Using local JSON store:', STORE_FILE); }
    startBot();
    app.listen(CONFIG.PORT, ()=> console.log('OK-Mobile backend listening on port ' + CONFIG.PORT));
  }catch(e){ console.error('Fatal start error:', e); process.exit(1); }
})();
