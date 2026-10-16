# TCMS — Deployment Guide (MySQL 8.4)

Current as of **2026-10-14**. TCMS runs on **MySQL 8.4 only** (utf8mb4, strict mode).
Two deployment realities are documented:

- **Sandbox / local** — a real MySQL 8.4.6 server booted by script on `127.0.0.1:5500` (this is what the live preview uses).
- **Company IT (production)** — the real MySQL server operated by IT. The migration and cutover plan is fully specified in [`docs/migration/04-cutover-rollback.md`](docs/migration/04-cutover-rollback.md); the questions for IT: IT request file: to be recreated (pending).

> The former Vercel + Neon/Supabase guide is retired and kept only as history in
> `archive/postgres/docs/DEPLOYMENT-GUIDE.md` — **do not follow it
> for new deployments**; TCMS no longer speaks PostgreSQL and no longer needs the
> old keep-alive cron.

---

## 0. What you are deploying

| Piece | What it is | Needs a server? |
|---|---|---|
| Next.js 16 app (UI + API routes) | The whole TCMS: auth, RBAC, test cases, bugs, reviews, wiki, reports, users, notifications | Yes — one Node 20+ process |
| MySQL 8.4 database | 17 tables, schema via `npx prisma migrate deploy` from `prisma/migrations/` | Managed/self-hosted MySQL 8.4 |
| Notifications WS mini-service | Realtime toast push (`mini-services/notifications`, Bun) | Optional — without it the app degrades to **refresh-visible** delivery: the DB row shows on the client's next list fetch (page load / socket reconnect / tab re-visible; no polling timers) |
| Backup scheduler | `scripts/backup-scheduler.mjs` → `mysqldump` nightly, 14-day retention | Optional but **strongly recommended** (wired into autostart) |

Required env vars: only **2** (`DATABASE_URL`, `JWT_SECRET`). Everything else is optional.

---

## 1. Sandbox / local deployment (proven path)

```bash
# 1) Code + deps
npm install

# 2) Environment (see .env.example for the full annotated list)
cp .env.example .env
#   DATABASE_URL / DIRECT_URL = mysql://tcms_app:<pass>@127.0.0.1:5500/tcms_test
#   TCMS_ENABLE_SEED=true     # sandbox only — keeps /api/seed available on an empty DB

# 3) MySQL — either point at an existing server, or boot the sandbox:
bash scripts/migration/mysql84-boot.sh    # idempotent; real MySQL 8.4.6 on 127.0.0.1:5500

# 4) Schema + run (one command handles both)
npm run dev                               # scripts/dev-tcms.mjs — MySQL-only wrapper
#   refuses non-mysql DATABASE_URL, boots the sandbox when pointed at :5500
# production: npm run build && npm start
```

- Boot glue for unattended hosts: `scripts/boot-tcms-autostart.sh` (also starts the
  backup scheduler and the WS mini-service). The platform hook `.zscripts/dev.sh`
  dispatches it in the background at container start.
- DB wiring has a **single source of truth**: `scripts/mysql-env.sh` (safe env
  loader, mysql-only enforcement, PG source stays read-only).
- First boot auto-seeds roles, the permission matrix and the admin user
  (`admin@tcms.com / Admin@123` — change immediately).

## 2. Production deployment on company IT (the planned cutover)

**Step-by-step for the server: [`docs/deploy/PRODUCTION-CHECKLIST.md`](docs/deploy/PRODUCTION-CHECKLIST.md)**
(every `.env` key, systemd units for both processes, backups cron, go-live steps).

The full, ordered plan with rollback lives in `docs/migration/04-cutover-rollback.md`.
Summary of the sequence:

1. **Send the IT request** (IT request file: to be recreated (pending)): server/port + MySQL 8.4
   version, TEST schema + limited app user (exact grant list included), TLS certs,
   `sql_mode` (STRICT_ALL_TABLES or STRICT_TRANS_TABLES), `utf8mb4` + timezone,
   `max_connections`, backup ownership + one-off restore drill permission,
   Workbench access for the manager, and where real data lives.
2. **Receive creds → set env**: `DATABASE_URL`/`DIRECT_URL` to the IT host
   (pass-through — `scripts/dev-tcms.mjs` never touches a non-sandbox host),
   production `JWT_SECRET`, `TCMS_ENABLE_SEED` **off**.
3. **Schema**: `npx prisma migrate deploy` against the TEST schema (or hand IT the
   SQL in `prisma/migrations/` if they prefer manual review).
4. **Certify**: run the battery + Crew Desk + import suites against IT's TEST
   schema; run one `backup-db-mysql.sh` + `restore-mysql.sh` drill on IT hardware.
5. **Go live** per the cutover doc's checklist; keep `PG_SOURCE_URL` set for the
   agreed rollback window (plan: `docs/migration/04` §rollback).

## 3. Environment variable reference

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` / `DIRECT_URL` | ✅ | MySQL 8.4: `DATABASE_URL` = app user (DML only), `DIRECT_URL` = migration user (DDL) — two different users |
| `JWT_SECRET` | ✅ | Signs session tokens. Long random value in production (`openssl rand -hex 32`) |
| `PG_SOURCE_URL` | optional | Read-only PG fallback source for the rollback window |
| `TCMS_ENABLE_SEED` | sandbox only | Allows `/api/seed` on an empty DB — keep OFF in production |
| `TCMS_EXTRA_ALLOWED_HOSTS` | optional | Extra hosts accepted by the allowed-hosts guard (preview domains) |
| `TCMS_PUBLIC_ORIGIN` | optional | Explicit public origin baked into Crew Desk comment links |
| `CREWDESK_*` | optional | Crew Desk integration (`BASE_URL`, `AUTH`/`TOKEN` or login, `USER_ID`, `MODE`, `TEST_TICKET_ID` — 1355 in dev, `TIMEOUT_MS`) |
| `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` `SMTP_FROM` `SMTP_SECURE` | optional | Email notification channel (skipped with a log line when unset) |
| `TELEGRAM_BOT_TOKEN` | optional | Telegram notification channel |
| `WS_NOTIFY_URL` | optional | Loopback broadcast URL of the WS mini-service (`http://127.0.0.1:3004/notify` in the sandbox) |
| `LOG_DIR`, `LOG_RETENTION_DAYS`, `TELEGRAM_LOG_*` | optional | Rotating file logs + optional log mirroring to Telegram |

## 4. Email & Telegram notifications

Unchanged by the migration — a channel that is not configured is **skipped with a
log line** and never blocks a business action. Setup steps (SMTP provider choice,
@BotFather bot, per-user chat id in Profile) are documented in the historical
guide, sections 4–5, and remain accurate.

## 5. Go-live checklist (MySQL edition)

- [ ] `GET /api` → `{"status":"ok","service":"tcms-api"}`
- [ ] `SELECT @@version` ≥ 8.4, `@@sql_mode` includes a STRICT mode, charset `utf8mb4`
- [ ] Sign-in works; dashboard charts render
- [ ] First VP created with `scripts/create-first-vp.mjs`; `TCMS_ENABLE_SEED` unset in production
- [ ] Register tab hidden (signup off); a Viewer account correctly gets 403s elsewhere
- [ ] Create a test case + assign a bug → recipient sees in-app notification (email/Telegram if configured)
- [ ] `scripts/verify-battery.sh` green against the production DB
- [ ] Backup scheduler running (`logs/backup.log`), one restore drill completed
- [ ] Rollback window agreed; `PG_SOURCE_URL` documented (cutover doc §rollback)
