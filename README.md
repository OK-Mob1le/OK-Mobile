# OK-Mobile Бухгалтерия — Backend

Backend API (Node.js + Express) и Telegram-бот подтверждения регистрации для приложения **OK-Mobile Бухгалтерия**.

## Структура

```
OK-Mobile/
├── index.html              # Всё веб-приложение (frontend, один файл)
└── telegram-backend/
    ├── server.js           # Express API + Telegram Bot
    ├── package.json
    ├── .env.example
    └── README.md
```

## Возможности

- Регистрация по номеру телефона с подтверждением через Telegram-бот (6-значный код, срок действия 5 минут).
- JWT-авторизация, привязка `phone + telegram_user_id + registration_session_id`.
- REST API: пользователь, товары, продажи, приход, клиенты, поставщики, дилеры, документы, касса, dashboard, отчёты.
- Бизнес-логика: продажа уменьшает остаток и создаёт документ/операцию кассы; приход увеличивает остаток.
- Хранение данных: **PostgreSQL** (если задан `DATABASE_URL`) или локальный JSON-файл `data.json` (для разработки без БД).
- Готов к деплою на **Railway**.

## Переменные окружения

Скопируйте `.env.example` в `.env`:

```env
BOT_TOKEN=          # токен бота от @BotFather
DATABASE_URL=       # строка подключения PostgreSQL (Railway задаёт сам)
JWT_SECRET=         # длинный случайный секрет
FRONTEND_URL=*      # URL фронтенда для CORS
PORT=3000
DEV_RETURN_CODE=false
```

> ⚠️ `BOT_TOKEN`, `JWT_SECRET`, `DATABASE_URL` **никогда** не должны попадать в `index.html` или клиентский код.

## Локальный запуск

```bash
cd telegram-backend
npm install
cp .env.example .env      # Windows: copy .env.example .env
npm start
```

Сервер поднимется на `http://localhost:3000`. Без `DATABASE_URL` данные сохраняются в `data.json`.
Если `BOT_TOKEN` не задан, бот отключён, а код подтверждения возвращается в ответе API (`dev_code`) — удобно для локальной отладки.

Проверка: `GET http://localhost:3000/api/health`.

## Подключение фронтенда

1. Откройте `index.html`.
2. Вверху скрипта найдите `const CONFIG = { API_BASE: '', ... }`.
3. Укажите URL backend (Railway), например:
   ```js
   API_BASE: 'https://ok-mobile-production.up.railway.app'
   ```
   Это же значение можно задать в приложении: **Настройки → Безопасность → Адрес API (Railway)**.
4. Если `API_BASE` пуст — приложение работает в локальном (демо) режиме на `localStorage`.

## Деплой на Railway

1. Создайте проект на [railway.app](https://railway.app) → **Deploy from GitHub repo**.
2. Root Directory укажите `telegram-backend` (или задеплойте папку отдельно).
3. Добавьте сервис **PostgreSQL** (Railway автоматически создаст переменную `DATABASE_URL`).
4. В **Variables** добавьте:
   - `BOT_TOKEN`
   - `JWT_SECRET`
   - `FRONTEND_URL` (URL, где размещён `index.html`)
5. Railway запустит `npm start`. При старте таблицы БД создаются автоматически.

Файл `index.html` можно раздать тем же сервисом: маршрут `GET /` отдаёт `../index.html`.

## Telegram-бот

1. Создайте бота у [@BotFather](https://t.me/BotFather) → получите `BOT_TOKEN`.
2. Укажите username бота в `index.html`: `CONFIG.BOT_URL` (по умолчанию `https://t.me/OKMobileBot`).
3. Команды: `/start`, `/help`, `/language`, `/support`.
4. Сценарий регистрации:
   - фронтенд вызывает `POST /api/auth/request` → получает `session_id`;
   - открывается `https://t.me/OKMobileBot?start=<session_id>`;
   - бот получает `/start <session_id>`, привязывает `telegram_user_id` и отправляет 6-значный код;
   - пользователь вводит код → `POST /api/auth/verify` → backend выдаёт JWT.

## API

| Метод | Endpoint | Описание |
| --- | --- | --- |
| POST | `/api/auth/request` | Запрос кода подтверждения |
| GET | `/api/auth/session/:id` | Статус привязки Telegram |
| POST | `/api/auth/resend` | Повторная отправка кода |
| POST | `/api/auth/verify` | Проверка кода, выдача JWT |
| GET/PUT | `/api/user` | Профиль пользователя |
| PUT | `/api/company` | Данные компании |
| GET/POST | `/api/products`, `/api/products/:id` (PUT/DELETE) | Товары |
| GET/POST | `/api/sales` | Продажи |
| GET/POST | `/api/purchases` | Приход |
| GET/POST | `/api/customers`, `/api/suppliers`, `/api/dealers` | Контрагенты |
| GET/POST | `/api/documents` | Документы |
| GET/POST | `/api/cash` | Касса |
| GET | `/api/dashboard` | Показатели главной |
| GET | `/api/reports` | Отчёты (фильтр `?from=&to=`) |
| GET | `/api/health` | Проверка состояния |

Все защищённые маршруты требуют заголовок `Authorization: Bearer <JWT>`.

## Таблицы БД

`users`, `companies`, `products`, `sales`, `sale_items`, `purchases`, `purchase_items`, `customers`, `suppliers`, `dealers`, `documents`, `cash_transactions`, `verification_codes`.