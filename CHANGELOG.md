# Changelog

## 2026-10-16 — FIX deep-test bugs (docs/qa/DEEP-TEST-2026-10-16.md)

- **Roles (R2-3):** only a VP can set or change a role, and never their own; other user managers can create viewer accounts only. Role pickers are disabled for non-VPs.
- **Bugs (T1-1, T1-2, R2-2):** editing a bug, test case or work log no longer resets fields you did not send; saving a bug with an unchanged assignee no longer needs assign rights; assigning on create needs assign rights.
- **Reviews (R2-1, R2-4, R2-5, R2-6):** a resubmit or module submit closes the old open review; cases in review or approved cannot be submitted again (400); authors see the flagged fields on the test-case page; a bulk module verdict sends one notification per person.
- **Permissions (T1-5, DOC-T1-6):** turning a permission back to its default reports `source: 'default'`; docs/03 tables match the code (21 permissions, 126 cells).

## 2026-10-16 — MAINT production run

- **Safety:** new `GET /api/ready` (database check); `TCMS_READ_ONLY=true` pauses every change with a clear 503 while sign-in and reading keep working; CSV exports of bugs and work logs are now quoted and protected against spreadsheet formula injection like test cases; too many failed sign-ins from one network now get 429.
- **Database errors:** duplicate, foreign-key, too-long and similar MySQL errors now answer a clear 400/409 (DB down or busy: 503) instead of a generic 500; SQL text never reaches the client. Two saves of the same day's work log at once no longer fail.
- **Concurrent edits:** saving a test case, bug, module, review verdict/forward or a module bulk verdict that someone else changed since you opened it now answers **409 "This item was changed by someone else — reload"** instead of silently overwriting (optimistic lock on the loaded updatedAt). Parallel test-case saves and parallel verdicts no longer fail with a 500 deadlock.

## 2026-10-14 — Owner 8-step plan (steps 1–3) + Phase 2 hardening (post-migration)

- **Step 1:** Crew Desk testing normalized to designated ticket **1355-only** —
  fixed 6 stale `4190` remnants including the functional default in
  `src/lib/server/config.ts`; `rg 4190` over the repo = 0. Ticket 4191 survives
  only as the guard-refusal probe (asserted refused, never written to).
- **Step 2:** The two battery checks rewritten during the migration were
  independently audited with evidence (`git show` archaeology + live MySQL
  probes) — both old versions were stale on ANY database (CSRF
  marker-allows-Origin is the guard's documented design; the bare `steps` field
  no longer exists in the product). Battery 63/63 is honest.
- **Step 3:** IT request for the real production MySQL server drafted →
  `download/it-request-mysql.md` (server/port, TEST schema + limited user with
  grant list, TLS/sql_mode/charset/timezone, backup ownership, Workbench access,
  where real data lives).
- **Phase 2 hardening (5 groups, suites green after each):**
  1. `scripts/mysql-env.sh` = single source of DB wiring (safe env parser immune
     to the `source .env` `&`-truncation bug); repair-only `.env` self-heal;
     unquoted-`.env` standard; battery self-boots.
  2. Unknown `moduleId`/`assignee` on test-case/bug create/update → proper
     404s (was raw FK 500). 22-probe sweep: zero 500s.
  3. Backup scheduler wired into autostart (pgrep-guarded, idempotent);
     backup log lines; CSV import completion log line.
  4. Twelve stale docs updated for MySQL 8.4 (schema, API reference + new
     endpoint sections, runbook rewritten to mysqldump drills, file index,
     deployment/scaling/realtime banners; Vercel-era guides marked HISTORICAL).
  5. `src/lib/auth.ts` SQL moved to the user repository (no import cycle);
     SMTP lazy singleton; eslint ignores vendored code (490 errors → 0);
     stale `scripts/tcms-package/` removed (zip 759 → 443 files);
     Crew Desk identity cache invalidation on user changes.

## 2026-10-14 — PostgreSQL → MySQL 8.4 migration (MySQL-only)

- Adopted TCMS-complete-2026-10-14.zip as the baseline (settings reorg, cookie
  auth, wiki, search, backup scheduler, Crew Desk v2, Register kept).
- Prisma schema converted to MySQL 8.4 (provider swap; explicit native types
  on every String — CHAR(36) uuids, VARCHAR sized per validation caps,
  TEXT/MEDIUMTEXT long text; DATETIME(3) everywhere; JSON expression defaults;
  case-sensitive collations for password_hash + refresh token).
- All raw SQL rewritten for MySQL across 20 repositories (RETURNING →
  insert+read-back with app-side uuids, ILIKE → LIKE, ON CONFLICT →
  ON DUPLICATE KEY, interval/cast/JSONB fixes, Number() coercions, boolean
  normalization). No raw SQL outside repositories (unchanged rule).
- keep-alive route removed (Supabase/PG pool leftover); its cron removed;
  scripts updated to use /api health.
- Backup scheduler: mysqldump-based (scripts/backup-db-mysql.sh, same
  14-retention policy) + restore drill (scripts/restore-mysql.sh, scratch
  schema, verified 17 tables).
- One-time data migration script (scripts/migration/migrate-pg-to-mysql.mjs):
  batched, dependency-ordered, idempotent, dry-run mode, FK-orphan audit,
  utf8mb4 + strict-mode probes. PG source stays READ-ONLY.
- Verification: battery 63/63, Crew Desk mock suite 5/5, import suite 33/33,
  250-row import probe PASS (cap enforced), 200-VU load test 0 errors.
  Full numbers: docs/migration/03-verification.md.
- Cutover + rollback plan: docs/migration/04-cutover-rollback.md.

## 2026-10-08 — Adopted baseline (zip lineage)

- Crew Desk integration (shared account, mock-only in sandbox, email check,
  1355-designated-ticket rule), settings reorg, cookie sessions, wiki, search,
  backup scheduler, self-signup Register tab.
