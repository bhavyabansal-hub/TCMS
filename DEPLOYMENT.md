# TCMS — Deployment Guide (MySQL 8.4)

Current as of **2026-10-16**. TCMS runs on **MySQL 8.4 only** (utf8mb4, strict mode).
Two deployment realities are documented:

- **Local (Windows)** — MySQL 8.4 on `127.0.0.1:5500`, schema `tcms_test`: [`docs/LOCAL-SETUP-WINDOWS.md`](docs/LOCAL-SETUP-WINDOWS.md).
- **Company IT (production)** — Linux + nginx, one app instance, the real MySQL server operated by IT.
  Step by step: [`docs/deploy/PRODUCTION-CHECKLIST.md`](docs/deploy/PRODUCTION-CHECKLIST.md);
  the questions for IT: [`docs/deploy/it-request-mysql.md`](docs/deploy/it-request-mysql.md).

---

## 0. What you are deploying

| Piece | What it is | Needs a server? |
|---|---|---|
| Next.js 16 app (UI + API routes) | The whole TCMS: auth, RBAC, test cases, bugs, reviews, wiki, reports, users, notifications | Yes — one Node 20+ process (single instance, decision D8) |
| MySQL 8.4 database | 17 tables, schema via `npx prisma migrate deploy` from `prisma/migrations/` | IT-operated MySQL 8.4 |
| Notifications WS mini-service | Realtime push (`mini-services/notifications`, Bun) | Optional — without it the app degrades to **refresh-visible** delivery: the DB row shows on the client's next list fetch |
| Backup scheduler | `scripts/backup-scheduler.mjs` → `mysqldump` nightly, 14-day retention | Strongly recommended (cron, PRODUCTION-CHECKLIST §5) |

---

## 1. Local deployment (Windows)

```bash
npm install                     # also runs prisma generate
cp .env.example .env            # DATABASE_URL / DIRECT_URL = mysql://…@127.0.0.1:5500/tcms_test
npx prisma migrate deploy       # schema (the only DDL path, decision D4)
npm run dev                     # scripts/dev-tcms.mjs — refuses a non-mysql DATABASE_URL
```

- Never use port 3306 on the dev machine (a different MySQL server).
- DB wiring for the Linux shell scripts has a **single source of truth**: `scripts/mysql-env.sh`.
- Demo data: with `TCMS_ENABLE_SEED=true`, `POST /api/seed` once (local only).

## 2. Production deployment on company IT

**Step-by-step for the server: [`docs/deploy/PRODUCTION-CHECKLIST.md`](docs/deploy/PRODUCTION-CHECKLIST.md)**
(every env key, systemd units for both processes, nginx, backups cron, go-live steps).
Summary of the sequence:

1. **Send the IT request** ([`docs/deploy/it-request-mysql.md`](docs/deploy/it-request-mysql.md)): server/port + MySQL 8.4
   version, TEST schema + limited app user (exact grant list included), TLS certs,
   `sql_mode` (STRICT_ALL_TABLES or STRICT_TRANS_TABLES), `utf8mb4` + timezone,
   `max_connections`, backup ownership + one-off restore drill permission,
   Workbench access for the manager, and where real data lives.
2. **Receive creds → set env**: `DATABASE_URL` (app user) / `DIRECT_URL` (migrate user)
   to the IT host, production `JWT_SECRET`, `TCMS_DEPLOY_ENV=production`,
   `TCMS_ENABLE_SEED` **off**.
3. **Schema**: `npx prisma migrate deploy` (or hand IT the SQL in `prisma/migrations/`).
4. **First VP**: `scripts/create-first-vp.mjs` (doc 17 §6).
   Production is a fresh start: no data is copied (decision D2).
5. **Certify and go live** per PRODUCTION-CHECKLIST §6; one backup + restore drill on IT hardware.

Rollback of a release = redeploy the previous tag (doc 17 §2.2); data rollback = restore the
last mysqldump (doc 17 §2.1).

## 3. Environment variable reference

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` / `DIRECT_URL` | ✅ | MySQL 8.4: `DATABASE_URL` = app user (DML only), `DIRECT_URL` = migration user (DDL) — two different users |
| `JWT_SECRET` | ✅ | Signs session tokens. Long random value in production (`openssl rand -hex 32`) |
| `TCMS_DEPLOY_ENV` | ✅ in production | `production` turns on the startup guard (refuses unsafe settings) |
| `BACKUP_DATABASE_URL` | recommended | Read-only dump user for `scripts/backup-db-mysql.sh` |
| `TCMS_READ_ONLY` | optional | `true` pauses every write with a clear 503 (maintenance) |
| `TCMS_ENABLE_SEED` | local only | Allows `/api/seed` on an empty DB — keep OFF in production |
| `TCMS_EXTRA_ALLOWED_HOSTS` | optional | Extra hosts accepted by the allowed-hosts guard |
| `TCMS_PUBLIC_ORIGIN` | optional | Explicit public origin baked into Crew Desk comment links |
| `CREWDESK_*` | optional | Crew Desk integration (`BASE_URL`, `AUTH`/`TOKEN` or login, `USER_ID`, `MODE`, `TEST_TICKET_ID` — 1355 in dev, `TIMEOUT_MS`) |
| `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` `SMTP_FROM` `SMTP_SECURE` | optional | Email notification channel (skipped with a log line when unset) |
| `TELEGRAM_BOT_TOKEN` | optional | Telegram notification channel |
| `WS_NOTIFY_URL`, `WS_NOTIFY_SECRET` | optional | Loopback broadcast URL + shared secret of the WS mini-service |
| `LOG_DIR`, `LOG_RETENTION_DAYS`, `TELEGRAM_LOG_*` | optional | Rotating file logs + optional log mirroring to Telegram |

Full annotated list: `.env.example`; production values: PRODUCTION-CHECKLIST §1.

## 4. Email & Telegram notifications

A channel that is not configured is **skipped with a log line** and never blocks a
business action. Variable names are in `.env.example`; how delivery works is in
[`docs/12-realtime-and-deployment.md`](docs/12-realtime-and-deployment.md) §6. Check the
setup without sending anything: `node scripts/send-test-notification.mjs --check`.

## 5. Go-live checklist (short)

- [ ] `GET /api` → `{"status":"ok","service":"tcms-api"}` and `GET /api/ready` → 200
- [ ] `SELECT @@version` ≥ 8.4, `@@sql_mode` includes a STRICT mode, charset `utf8mb4`
- [ ] Sign-in works; dashboard renders
- [ ] First VP created with `scripts/create-first-vp.mjs`; `TCMS_ENABLE_SEED` unset
- [ ] Register tab hidden (signup off); a Viewer account gets 403s for writes
- [ ] Create a test case + assign a bug → recipient sees the in-app notification
- [ ] Backup cron installed, one restore drill completed
- [ ] Full list: PRODUCTION-CHECKLIST §6
