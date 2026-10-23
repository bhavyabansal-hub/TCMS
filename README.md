# TCMS — Test Case Management System

A test case management web application for QA teams: modules, test cases, bug tracking, review workflows (per case and per module), wiki knowledge base, role-based access control, activity logging, notifications, reports, and Crew Desk integration.

- **App version:** 0.3.0 · **Framework:** Next.js 16 (App Router) + React 19 + TypeScript
- **Database:** MySQL 8.4 (utf8mb4, strict mode) via Prisma — all queries are raw SQL · **UI:** Tailwind CSS 4 + shadcn/ui + React Query 5
- **Status (2026-10-16):** runs on MySQL 8.4 locally (Windows) with all definition-of-done suites green. Production go-live on the company MySQL server is waiting for IT answers ([`docs/deploy/it-request-mysql.md`](./docs/deploy/it-request-mysql.md)).

## Feature highlights

| Area | What you get |
|------|--------------|
| Test cases | Full CRUD, rich editor, CSV/XLSX import (`docs/guides/import-test-cases.md`), bulk delete, hover preview, deep-linked filters (`?moduleId=&status=&priority=&q=`) |
| Modules | Module tree, per-module detail, module review workflow |
| Reviews | Case and module reviews, verdicts with flagged fields (shown to the author), forward / change reviewer; one open review per case |
| Bugs & tasks | Bug tracker linked to test cases, Kanban drag & drop, daily work logs, monthly export |
| Wiki | Rich-text knowledge base, sanitized server-side, authenticated attachments (10 MB cap, allowlist) |
| Access control | 6 roles (`viewer < qa_engineer < developer < product < manager < vp`), a 126-cell permission matrix the VP edits at runtime (Settings → Permissions), server-side checks on every API; only a VP sets roles; new signups are `viewer` |
| Safety | Concurrent edits answer 409 *"changed by someone else — reload"* instead of overwriting; MySQL errors map to clean 400/409/503; read-only maintenance mode (`TCMS_READ_ONLY`); `GET /api/ready`; per-IP sign-in limit (429); CSV formula-injection guard |
| Security | httpOnly-cookie JWT sessions, CSRF header + origin checks, XSS sanitizer allowlist, WS ticket auth, security headers, production startup guard |
| Ops | Activity log, notifications (in-app + optional WebSocket + optional email/Telegram), global search, reports, nightly mysqldump backups (14-day retention) |

## Quick start (Windows, local)

Full steps: [`docs/deploy/local-setup-windows.md`](./docs/deploy/local-setup-windows.md). In short:

```bash
npm install                 # also runs prisma generate
cp .env.example .env        # set DATABASE_URL / DIRECT_URL to mysql://…@127.0.0.1:5500/tcms_test
npx prisma migrate deploy   # create the schema (the only DDL path)
npm run dev                 # scripts/dev-tcms.mjs — MySQL-only wrapper, http://localhost:3000
```

Local MySQL is `127.0.0.1:5500` (schema `tcms_test`); never use port 3306 on the dev machine.
With `TCMS_ENABLE_SEED=true`, `POST /api/seed` once creates demo data and one account per
role (for example **admin@tcms.com / Admin@123**, a VP). Local only — never seed a shared database.

Production (Linux + nginx, one instance): [`docs/deploy/PRODUCTION-CHECKLIST.md`](./docs/deploy/PRODUCTION-CHECKLIST.md)
and [`docs/deploy/DEPLOYMENT.md`](./docs/deploy/DEPLOYMENT.md). Production starts empty: `npx prisma migrate deploy` +
`scripts/create-first-vp.mjs` (decision D2).

### Environment variables

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` / `DIRECT_URL` | MySQL 8.4: app user (DML) / migrate user (DDL, `prisma migrate deploy`) |
| `BACKUP_DATABASE_URL` | Read-only user for the nightly mysqldump |
| `JWT_SECRET`, `WS_NOTIFY_SECRET` | Session signing / WebSocket ticket secret — strong random values |
| `TCMS_DEPLOY_ENV=production` | Turns on the production startup guard |
| `TCMS_READ_ONLY` | `true` pauses every write (503) while sign-in and reading keep working |
| `TCMS_ENABLE_SEED`, `TCMS_ALLOW_SIGNUP` | Demo seed / self-signup — **keep OFF in production** |
| `CREWDESK_*` | Crew Desk integration; unset/`test` = comments only to the designated test ticket (1355) |
| `SMTP_*`, `TELEGRAM_BOT_TOKEN`, `WS_NOTIFY_URL` | Optional notification channels |

Full annotated list: `.env.example`.

## Verification suites (scripts/)

The definition-of-done list is in [`docs/CODING-STANDARDS.md`](./docs/CODING-STANDARDS.md) §5. Latest results (2026-10-16):
`tsc` 0 errors · `eslint` 0 errors · `audit-standards` 0 violations · verify-permissions 37/0 ·
verify-review-matrix 36/0 · verify-ui-gates 159/0 · verify-concurrency 34/0 ·
verify-role-flows-e2e 556/0 · verify-permission-toggle-e2e 1495/0. The suites only run against
`127.0.0.1:5500/tcms_test` and delete the rows they create. Latest QA report:
[`docs/qa/DEEP-TEST-2026-10-16.md`](./docs/qa/DEEP-TEST-2026-10-16.md).

## Documentation

Start at [`docs/README.md`](./docs/README.md). Rules: [`docs/CODING-STANDARDS.md`](./docs/CODING-STANDARDS.md).
Folders: `docs/architecture/` (HLD, LLD, database, API, auth, frontend), `docs/guides/` (pages, flows),
`docs/deploy/`, `docs/process/`, `docs/qa/`. Code map: [`docs/CODEBASE-MAP.md`](./docs/CODEBASE-MAP.md).
Changes: [`docs/CHANGELOG.md`](./docs/CHANGELOG.md). Engineering log: [`docs/worklog.md`](./docs/worklog.md).

## Repository hygiene

- `.env` is git-ignored and never committed; rotate `JWT_SECRET` and Crew Desk credentials before any shared deployment.
- Commit code, scripts and one summary report per task; raw test output and evidence files stay out of git (`docs/CODING-STANDARDS.md` §6).
