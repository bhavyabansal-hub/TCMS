# TCMS — Test Case Management System

A production-grade test case management web application for QA teams: modules, test cases, bug tracking, review workflows (per-entity and per-module), wiki knowledge base, role-based access control, activity logging, notifications, reports, and Crew Desk integration.

- **App version:** 0.3.0 · **Framework:** Next.js 16 (App Router) + React 19 + TypeScript
- **Database:** MySQL 8.4 (utf8mb4, strict mode) via Prisma — all queries are raw SQL · **UI:** Tailwind CSS 4 + shadcn/ui + React Query 5
- **Live preview (this session):** https://preview-chat-c07ec613-ee53-4223-b848-dc9b3387e259.space-z.ai/
- **Status:** MySQL 8.4 migration **complete and verified in the sandbox** (2026-10-14). Real-IT cutover is planned and awaiting IT answers — see "Project status" below.

---

## Project status (2026-10-14)

| Item | State |
|------|-------|
| PostgreSQL → MySQL 8.4 migration | ✅ **DONE** — schema converted, all raw SQL rewritten in 20 repositories, data migrated (450 rows, 0 diffs), running on a real MySQL 8.4.6 server |
| Verification suites | ✅ battery 63/63 · Crew Desk 5/5 · CSV import 33/33 · 250-row import probe PASS · 200-VU load test 0 errors · backup/restore drill PASS |
| Crew Desk ticket rule | ✅ Normalized to designated test ticket **1355** everywhere (`rg 4190` = 0 matches); ticket 4191 used only as the guard-refusal probe (never written to) |
| Phase 2 hardening | ✅ 5 fix groups landed (DB wiring, FK 404s, boot/backup logging, docs refresh, repository-only SQL + lint clean) — commits `a281b4e`…`a9ef188` |
| Real-IT cutover (production MySQL) | ⏳ **PENDING IT ANSWERS** — server/port, TEST schema + limited user, TLS certs, `sql_mode`, backup ownership. Request drafted: [`download/it-request-mysql.md`](download/it-request-mysql.md); plan: [`docs/migration/04-cutover-rollback.md`](docs/migration/04-cutover-rollback.md) |
| PostgreSQL fallback | 🔒 Kept READ-ONLY as rollback insurance: `PG_SOURCE_URL`, `scripts/pg-sandbox/` data, `schema.pg.prisma`, `scripts/pg-client/`; rollback plan in `docs/migration/04` |
| Next up (after cutover) | AI-generated test cases feature; Crew Desk stays in guarded test mode (ticket 1355) until the company token is issued |

## Feature Highlights

| Area | What you get |
|------|--------------|
| Test cases | Full CRUD, rich editor, CSV/XLSX sheet import (docs/14), bulk delete with permanent selection row (zero layout shift), hover preview of full case on title, deep-linked filters (`?moduleId=&status=&priority=&q=`) surviving refresh/back-forward |
| Modules | Module pages, per-module detail views, module review workflow with reviewer gating |
| Reviews | Review requests + module review requests, verdicts, change-reviewer dialog, permission-gated actions |
| Bugs & tasks | Bug tracker linked to test cases, task reports, Kanban drag & drop |
| Wiki | Team knowledge base: rich-text editor (headings/lists/links/code), sanitized server-side, authenticated file attachments (10 MB cap, allowlist), matrix permissions, deep links `/wiki`, `/wiki/<id>`, global-search integrated |
| Access control | 6 roles (`viewer < qa_engineer < developer < product < manager < vp`), DB-driven permission matrix editable in Settings → Permissions, server-side `ensurePermission` on every mutating API, new signups default to VIEWER |
| Security | JWT session with fail-fast secret + DB claim revalidation, CSRF header + origin checks on non-GET, XSS sanitizer allowlist, CSV export injection guard, WS ticket auth, security headers, field length caps, one-shot rotation grace |
| Ops | Activity log, notifications (in-app + WS mini-service + optional email/Telegram), global search, reports, health endpoints, mysqldump backup scheduler (14-day retention), Crew Desk integration (manual/test/live modes) |

## Quickstart (MySQL 8.4)

Prerequisites: **Node 20+** and a reachable **MySQL 8.4** server. No MySQL installed?
The sandbox boot script downloads and starts a real MySQL 8.4.6 on `127.0.0.1:5500` automatically.

```bash
npm install                 # installs deps + runs prisma generate automatically

# 1) Configure environment (MySQL URLs; see .env.example for every variable)
cp .env.example .env
#   DATABASE_URL=mysql://tcms_app:pass@127.0.0.1:5500/tcms_test

# 2) Create the schema
npx prisma db push

# 3) Run it
npm run dev                 # scripts/dev-tcms.mjs — MySQL-only wrapper; auto-boots
                            # the sandbox MySQL when pointed at 127.0.0.1:5500
# or
npm run build && npm start  # production build on port 3000
```

First boot auto-seeds baseline data (roles, permission matrix, admin user) when `TCMS_ENABLE_SEED=true`.
Default credentials: **admin@tcms.com / Admin@123** (change after first login).

### Environment variables

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` / `DIRECT_URL` | MySQL 8.4 connection (identical values; raw SQL runs through Prisma's driver) |
| `PG_SOURCE_URL` | **Read-only** PostgreSQL source retained for rollback/migration reference — never written to |
| `JWT_SECRET` | Session signing secret — **set a strong random value in any shared/production environment** |
| `CREWDESK_BASE_URL`, `CREWDESK_TOKEN`/`CREWDESK_AUTH=login…`, `CREWDESK_USER_ID`, `CREWDESK_MODE`, `CREWDESK_TEST_TICKET_ID` | Crew Desk integration; unset/`test` = comments only to the designated ticket (1355 in dev) |
| `TCMS_EXTRA_ALLOWED_HOSTS` | Extra hosts accepted by the allowed-hosts guard (preview domains) |
| `TCMS_ENABLE_SEED` | Allows `/api/seed` on an empty DB — **keep OFF in production** |
| `SMTP_*`, `TELEGRAM_BOT_TOKEN`, `WS_NOTIFY_URL` | Optional notification channels (email, Telegram, realtime push) |

Full reference: `.env.example` · DB wiring internals: `scripts/mysql-env.sh` (single source of truth).

## Verification suites (scripts/)

All green on MySQL 8.4 as of 2026-10-14:

- `verify-battery.sh` (**63 checks**) — end-to-end API + permission + workflow battery; self-boots the stack
- `run-crewdesk-tests.sh` (**5 phases**) — Crew Desk mock suite against ticket 1355 (guard refusal via 4191 asserted)
- `verify-import.mjs` (**33 checks**) — CSV/XLSX import contract; plus `import-250-probe.mjs` (at-cap + over-cap rows)
- `loadtest-200.mjs` — 200-VU load test (autocannon; ~33k requests, 0 errors on MySQL)
- `backup-db-mysql.sh` / `restore-mysql.sh` — mysqldump backup + scratch-schema restore drill
- Older feature suites still runnable: `verify-permission-matrix.mjs` (165), `verify-review-ux-round.mjs` (28), `verify-notifications.mjs` (28), `verify-rbac.sh` (16), `verify-wiki.mjs`, `verify-security-fixes.mjs` (32), `audit-500-hunt.sh`

QA deliverables: `docs/qa/TCMS-MASTER-QA-PROMPT.md` (full-system deep-verification prompt) and `docs/qa/TCMS-TEST-REPORT-2026-10-09.md` (210-case sheet-imported marathon, five-role verdicts, DB deep checks).

## Documentation map (docs/)

`01` overview & architecture · `02` database schema · `03` auth & permissions · `04` API reference · `05` frontend architecture · `06` login & dashboard · `07` modules & test cases · `08` reviews workflow · `09` bugs/tasks/reports · `10` activity/users/notifications/profile · `11` end-to-end flows · `12` realtime & deployment · `13` file index · `14` test-case import · `15` standards & LLD · `16` single-instance & scaling · `17` operations runbook · `18` Crew Desk integration · `migration/` PG→MySQL migration + cutover/rollback plan (01 audit, 02 schema conversion, 03 verification, 04 cutover) · `qa/` master QA prompt + test report · `TCMS-ARCHITECTURE-GUIDE.pdf`

Start at [`docs/README.md`](docs/README.md). Current deployment path: [`DEPLOYMENT.md`](DEPLOYMENT.md) (MySQL 8.4, sandbox + real-IT). Legacy `DEPLOYMENT-GUIDE.md` files (Vercel/Neon/Supabase) are kept **HISTORICAL**.

## Repository hygiene

- `main` branch, clean working tree; latest commit documents every Phase 2 group.
- `.env` is intentionally git-ignored; the sandbox copy is for **local development only** — rotate `JWT_SECRET` and the Crew Desk credentials before any shared deployment.
- `download/tcms-postgresql.zip` is the canonical packaged snapshot (443 files, integrity-checked) refreshed after every verified round.
