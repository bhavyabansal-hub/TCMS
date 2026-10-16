# Operations Runbook — Backup, Rollback, Logging & Tests

> **Backups:** the nightly scheduler runs `scripts/backup-db-mysql.sh` (mysqldump) as the
> read-only **tcms_backup** user, verifies every file it writes, and alerts every
> manage_users holder in-app when a backup fails or the newest valid backup is > 26 h old.
> All commands below target **MySQL 8.4** via `scripts/backup-db-mysql.sh` /
> `restore-mysql.sh` / `scripts/mysql-env.sh`.


> **Status:** verified 2026-10-02 (pre-launch checklist item 4). Every command below was
> executed against the running stack as part of the go-live confirmation; results are quoted
> inline. Companion documents: [docs/architecture/HLD.md](../architecture/HLD.md)
> (scaling limits + load-test numbers) and [PRODUCTION-CHECKLIST.md](./PRODUCTION-CHECKLIST.md)
> (first-time deployment).

---

## 1. Backup plan (verified by a live run)

### 1.1 What exists
- **`scripts/backup-db-mysql.sh`** — THE active backup: one `mysqldump
  --single-transaction --no-tablespaces --hex-blob --routines --triggers` of the whole
  schema, gzipped to `backups/tcms-backup-<UTC-timestamp>.sql.gz` (~350 KB at current
  data volume). Credentials are passed via a per-run `--defaults-extra-file` (mktemp,
  chmod 600, removed on exit) — never `-p` on a command line, so `ps` can never leak the
  password. The dump runs as the **read-only `tcms_backup` user** (SELECT + SHOW VIEW +
  TRIGGER, created by `scripts/migration/mysql84-boot.sh`) — never the DML app user or
  the DDL migrate user. Every backup is VERIFIED before success is reported: non-empty,
  `gzip -t` OK, and the file ends with mysqldump's `-- Dump completed on ...` footer; a
  failed check deletes the file, appends a line to `logs/error-<day>.log` and exits
  non-zero. Retention: files older than 14 days are removed here (age-based), and the
  scheduler additionally keeps only the newest 14 files (count-based).
- **`scripts/restore-mysql.sh`** — restore drill into a scratch schema with per-table
  row-count verification against the live schema (see §2.1).
- **Code artifact** — the project is a git-tracked tree plus a full zip snapshot
  (`tcms-latest.zip` pattern from the delivery flow). The database backup is independent of
  the code snapshot: a rollback may need either or both (see §2).

### 1.2 Verified (mysqldump path, real MySQL 8.4.6 @127.0.0.1:5500/tcms_test)
```
$ node scripts/backup-scheduler.mjs --run-now
backup written: backups/tcms-backup-2026-10-15T04-53-44.sql.gz (64K, 12 INSERT statements)
                — verified: gzip OK, Dump completed footer present

$ gunzip -c backups/tcms-backup-*.sql.gz | tail -1
-- Dump completed on 2026-10-15  4:53:44

$ bash scripts/restore-mysql.sh --file backups/tcms-backup-…sql.gz --database tcms_restore_drill
drill-counts users=35 (live 35)   ... one line per table ...
restore drill OK: 18 tables, every row count matches live schema tcms_test
scratch schema dropped (drill complete)
```
The scheduler-side checks (verification, alerting, staleness) are permanently proven by
`scripts/backup-test.mjs`.

### 1.3 Automated cadence (scheduler)
Backups run **automatically** via `scripts/backup-scheduler.mjs`, started by
`scripts/boot-tcms-autostart.sh` (idempotent — pgrep-guarded, logs to
`/tmp/tcms-backup-scheduler.log`):
- **Daily at `BACKUP_AT`** (default `02:30` local time) — runs `backup-db-mysql.sh` as a
  child process, then prunes old files (keeps the last `BACKUP_KEEP` files, default 14).
- **Verification:** the scheduler treats a run as successful only when a NEW file appears
  in `backups/` that passes the same non-empty / `gzip -t` / "Dump completed" checks.
- **LOUD failure:** a failed run (non-zero child exit, or no valid new file) appends a
  line to `logs/error-<UTC-day>.log` AND inserts an in-app notification (type
  `backup_failed`) for every active user holding **manage_users** (default roles vp and
  manager, plus any runtime `role_permissions` overrides — resolved in SQL). The insert
  uses the app's DML user via a chmod-600 defaults file, so alerts work even when the
  app is down. Recipients' `notify_inapp` preference is intentionally ignored for this
  ops alert. There is no dedup window: each failed check alerts (~1/day while broken).
- **Staleness (26 h):** when the newest VALID backup is older than 26 hours — or none
  exists — the same alert fires. Checked on boot (after catch-up), after every scheduled
  run, and on demand via `node scripts/backup-scheduler.mjs --check-stale` (exit 1 =
  stale).
- **Catch-up on boot:** when the stack starts and the newest valid backup is older than
  20 h (or none exists), a fresh backup is taken immediately — downtime never leaves the
  data without a current point-in-time copy.
- **Manual/on-demand:** `node scripts/backup-scheduler.mjs --run-now` takes one backup
  and exits (non-zero on failure — cron-friendly for hosts that prefer system cron).
- **Dump target:** `BACKUP_DATABASE_URL` (mysql://, read-only tcms_backup user) — set it
  on the real server (.env.example contract). Without it the script falls back to the
  sandbox dump user on DATABASE_URL's host/schema.
- **Off-server copy:** `BACKUP_SHIP_CMD` runs after every successful backup with the
  new file's path (use `{file}` as the placeholder) — e.g. `rclone copy {file}
tcms-backups:tcms/`, `aws s3 cp {file} s3://tcms-backups/`, or `scp {file}
ops@host:/srv/tcms/`. A failed ship is logged loudly but never blocks the schedule.
  On the company MySQL server this matters: whoever owns backups (IT — confirm)
  controls retention, while a shipped logical export restores anywhere (§2.1).

| Frequency | Trigger | Why |
|---|---|---|
| Nightly 02:30 (automatic) | scheduler | Daily RPO of ≤24 h for user-entered work |
| On stack boot (automatic) | scheduler catch-up | Fresh copy after any downtime > 20 h |
| Before every deploy / migration | `--run-now` | One-command undo point for schema-or-code changes |
| Before destructive ops (bulk import, user cleanup) | `--run-now` | Cheap insurance |

The `backups/` folder is append-only; rotate off-server weekly (copy the newest file to
external storage) so a dead disk cannot take the backups with it.

#### 1.3.1 System cron / systemd for IT (recommended on the production host)
The autostart boot script keeps the scheduler daemon alive, but IT can add a system-level
second line of defense (all commands run from the deployment root, e.g. `/srv/tcms`):
- **Nightly backup at 02:30** (independent of the app stack — use instead of, or in
  addition to, the daemon; the two never conflict, both just produce verified files):

  ```cron
  30 2 * * * cd /srv/tcms && /usr/bin/node scripts/backup-scheduler.mjs --run-now >> /var/log/tcms-backup.log 2>&1
  ```

  `--run-now` exits non-zero on failure, so cron's mail / monitoring sees a failed night.
- **Hourly staleness watchdog** (alerts when the newest valid backup is > 26 h old —
  e.g. the daemon died, the disk filled, mysqldump hangs):

  ```cron
  15 * * * * cd /srv/tcms && /usr/bin/node scripts/backup-scheduler.mjs --check-stale >> /var/log/tcms-backup.log 2>&1
  ```

  `--check-stale` takes no action on fresh backups and exits 1 (stale) / 0 (ok) — it is
  safe to run hourly. The equivalent systemd timer units use the same two commands with
  `OnCalendar=*-*-* 02:30:00` and `OnCalendar=hourly`.
- **App-side second safety net (automatic, no IT action needed):** the Next server itself
  checks the newest valid backup once per UTC day — shortly after boot, then at every UTC
  midnight (`src/lib/server/backup-health.ts`, wired in `src/instrumentation-node.ts`). When
  the newest valid backup is older than 26 h (or none exists), it raises the SAME
  `backup_failed` in-app alert to every active manage_users holder — but at most ONE such
  alert per UTC day, even across app restarts (deduped against the notifications table:
  the scheduler's alerts count too). It never throws into a request (fire-and-forget,
  failures only logged) and it is OFF by itself when the backup directory does not exist
  (`TCMS_BACKUP_DIR` override or `<deploy root>/backups`). This is a SECOND safety net —
  it assumes the app is running; the cron/systemd watchdog above covers the case where
  the whole stack is down.

---

## 2. Rollback plan (two independent axes)

### 2.1 Database rollback (data-level)
```
bash scripts/restore-mysql.sh --file backups/<backup>.sql.gz --database tcms_drill
```
- **Drill first, always:** the command above restores into a scratch schema, compares
  EVERY restored table's row count against the live schema and prints one
  `drill-counts <table>=<rows> (live <n>)` line per table — that is the verified
  procedure from §1.2. Any mismatch exits non-zero; the scratch schema is dropped
  afterwards in both outcomes.
- A real restore is destructive to current data; take a fresh backup of the *broken* state
  first (`node scripts/backup-scheduler.mjs --run-now`) so nothing is unrecoverable.
  On the real server run the restore as the DBA account (the script uses the sandbox
  root only because the sandbox app user has no CREATE right on other schemas).
- **RPO/RTO:** RPO = age of the newest backup file (≤24 h on the nightly cadence, with a
  26 h staleness alarm); RTO = minutes — the full verified drill took under a minute at
  current volume.

### 2.2 Application rollback (code-level)
1. Keep the last-known-good artifact: the shipped project zip (`tcms-latest.zip`) and/or the
   previous git commit/tag.
2. Rollback = re-deploy the previous snapshot (unzip → `npm ci` → `npm run build` → restart
   via `scripts/start-tcms.sh`) — or `git revert` + rebuild. The build is reproducible; the
   database schema changes are backward-compatible by convention, so a code rollback rarely
   requires a database rollback.
3. Sessions survive an app rollback: JWTs verify against `JWT_SECRET` (unchanged across
   deploys) and refresh tokens live in the database — users are not logged out by a rollback.

---

## 3. Error logging (verified live)

`src/lib/logger.ts` is the single logging path for every layer:

- **Uniform format:** `[tcms] <ISO-time> <LEVEL> <message> {json-meta}` — grep-friendly.
- **Two transports:** console (always — visible via `docker logs` / `nohup` output) **and**
  daily files in `logs/`:
  - `logs/app-YYYY-MM-DD.log` — info and above (every API request with its status and
    duration, business events like logins, review verdicts, lockouts)
  - `logs/error-YYYY-MM-DD.log` — errors only (500s with name/message/stack, Prisma faults)
- **Request observability:** `withApi()` (`src/lib/api.ts`) logs every API call
  (`METHOD /path -> status, durationMs`), so slow requests and error rates are visible per
  endpoint without extra tooling. The load test confirmed zero ERROR/500 lines under 1×/2×
  and stretch load.
- **Retention:** files older than 14 days (`LOG_RETENTION_DAYS`) are purged automatically on
  the first write of each day.
- **Failure isolation:** if the filesystem rejects a write (permissions, full disk), the file
  transport disables itself for the rest of the day and console logging continues — logging
  can never break a request.
- **Verified today:** `logs/app-2026-10-01.log` and `logs/error-2026-10-01.log` exist and
  receive the expected request stream while the production server runs.

**Where to look when something breaks:** `logs/error-*.log` first (stack traces), then
`logs/app-*.log` around the timestamp (the request + status + duration that triggered it).

---

## 4. Tests for login and the core flows (verified: 65/65 + 34/34)

### 4.1 API verification battery — `scripts/verify-battery.sh` → **65/65 PASS**
Curl-driven, cookie-jar based (mirrors the browser exactly), ~30 s. Coverage:
- **Login:** seeded users, profile+permissions in the response body, **no tokens in the body**
  (httpOnly-cookie contract), no password-hash leakage, brute-force lockout path.
- **Session cookies:** both cookies set `HttpOnly`, access cookie `SameSite=Lax`, refresh
  cookie scoped `path=/api/auth`, no `Secure` downgrade risk (set on https requests).
- **Session expiry:** an expired access JWT → 401; a garbage refresh cookie → hard 401; a
  valid refresh **rotates the pair** (new `Set-Cookie`); refresh body carries no tokens.
- **Logout:** revokes the refresh token server-side AND clears both cookies (`max-age=0`);
  the pre-logout cookie pair can no longer refresh (401, revoked).
- **CSRF:** mutation without the marker → 403; cross-site `Origin` blocked even with the
  marker → 403.
- **Permissions:** 401 without session; role matrix enforcement; VP-togglable overrides.
- **Review integrity (regression added today):** auto-assign never routes a review to the
  requester (no self-review); explicit self-assignment → 400; the full queue → verdict →
  approved chain as the assigned reviewer.
- **Core CRUD:** modules, test cases (create/update/history/version-bump), reviews, module
  reviews, bugs, task reports, notifications, search, import template/CSV (keep-alive
  was REMOVED with the MySQL migration — health checks use `GET /api`).

### 4.2 Browser e2e — `scripts/e2e-verify-routes-reviews-delete.mjs` → **34/34 PASS**
Headless-browser run over the real UI: login through the form, protected-route redirects,
dashboard/modules/test-cases/reviews/bugs/tasks page loads, review workflow through the UI,
delete flows, CSV import (valid row + rejected row), cookie-refresh rotation, CSRF marker
enforcement, import-template shape.

### 4.3 Load — `scripts/loadtest.mjs` (+ `loadtest-s6.mjs`)
1×/2×/stretch mixed traffic, login storm, write path, per-endpoint breakdown; zero errors at
every level. Numbers and analysis: [docs/architecture/HLD.md](../architecture/HLD.md) §6.

### 4.4 Running the suite before any release
```
bash scripts/start-tcms.sh                        # stack up + health gate
bash scripts/verify-battery.sh                    # 70/70
node scripts/e2e-verify-routes-reviews-delete.mjs # 34/34
node scripts/loadtest.mjs                         # report; compare vs §6 baseline
```

### 4.5 Certifying against the company MySQL TEST schema
The app is MySQL-only; pointing it at a different MySQL server is just a `DATABASE_URL`
change. **Never certify against production data** — ask IT for a dedicated TEST schema
and a limited user (IT request: [`deploy/it-request-mysql.md`](./it-request-mysql.md)), then:

```
# 0. IT provides: host, port, TEST schema name, limited user (SELECT/INSERT/UPDATE/
#    DELETE/CREATE/DROP/INDEX/ALTER/REFERENCES/CREATE TEMPORARY TABLES/LOCK TABLES).
# 1. Verify the server BEFORE booting (version, strict mode, charset, timezone):
mysql -h <host> -P <port> -u <testuser> -p -e \
  "SELECT VERSION(), @@sql_mode, @@character_set_server, @@collation_server, @@time_zone, @@max_connections;"
# 2. Export the URL (mysql:// user:pass@host:port/<test_schema>) and boot:
bash scripts/start-tcms.sh        # mysql-env.sh keeps a mysql:// caller URL as-is
# 3. Schema is applied by the boot itself: npx prisma migrate deploy as the
#    DDL-only migrate user (decision D4 — no db push, no fixups)
# 4. Run the full battery: bash scripts/verify-battery.sh  (67 checks)
# 5. Tear down: kill the app; the TEST schema stays with IT.
```

used).
```
Interpretation: with `connection_limit=40` the database sees at most ~45 connections
(app 40 + backup 5 + tools) **regardless of VU count** — 200 users ≠ 200 DB connections.

---

## 5. Go-live sign-off (the four checklist items → evidence)

| # | Requirement | Evidence |
|---|---|---|
| 1 | httpOnly cookies + Secure/SameSite/CSRF; login, logout, expiry work | `auth-cookies.ts` contract; battery §4.1 sections all PASS (65/65); e2e 34/34; tokens absent from every response body and from localStorage |
| 2 | Load test at expected + 2× users; response times, errors, slow points; fix what breaks | 25/50/100 VU runs: 0 errors, p99 ≤ 251 ms; slow points identified (login bcrypt, two JOIN lists) — nothing broke; fixes applied: reviewer self-assignment bug found & fixed during pre-launch verification |
| 3 | Document single-instance only + Redis path | [docs/architecture/HLD.md](../architecture/HLD.md) — in-process state inventory, failure modes, Redis checklist, acceptance tests |
| 4 | Backup/rollback plan, error logging, login & core-flow tests | This document: drill-verified backup+restore (§1.2/§2.1), two-axis rollback (§2), file+console structured logging verified (§3), 65/65 + 34/34 suites (§4) |

---

## 6. First admin on a fresh production database (`scripts/create-first-vp.mjs`)

Seed is blocked in production and self-signup only creates `viewer` accounts, so a new
production database has no VP. Create exactly one with this script, then add every other
user from **Settings → Users**.

```bash
# on the app server, in the app folder, with the production .env in place
TCMS_DEPLOY_ENV=production node scripts/create-first-vp.mjs --email=it.admin@company.com --name="IT Admin"
Password for the new VP:      # hidden, asked twice; min 12 chars, a letter and a number
Repeat the password:
OK: VP created user_id=<uuid> email=it.admin@company.com
```

| Rule | Behaviour |
|---|---|
| Password | Hidden prompt only, never an argument; never printed or logged. bcrypt cost 10 (same as the app). With piped stdin the first two lines are password + confirmation (automation only; keep it out of shell history). |
| Already a VP | Refuses (`REFUSED: an active VP already exists`, exit 1). Two parallel runs are serialized by `GET_LOCK('tcms_first_vp')` and re-checked in one transaction. |
| Email taken | Refuses (exit 1). Email is trimmed and lower-cased like login. |
| Target DB | `DATABASE_URL`. With `TCMS_DEPLOY_ENV=production` it refuses the local sandbox URL; without it only `127.0.0.1:5500/tcms_test` is accepted (exit 2, no connection made). |
| Exit codes | 0 created · 1 refused / invalid input · 2 wrong target or DB error |

Verifier (sandbox only, everything rolled back): `node scripts/create-first-vp-test.mjs`
→ `FIRST-VP RESULT: 15 passed, 0 failed` (2026-10-16).

## 7. Operations quick reference

| Task | How |
|---|---|
| Deploy an app change | checkout the release tag → `npm ci` → `npm run build` → restart `tcms-app` (PRODUCTION-CHECKLIST §3) |
| Change a secret | edit `/etc/tcms/tcms.env` → restart the service (`NEXT_PUBLIC_*` needs a rebuild) |
| Create tables on a fresh DB | `npx prisma migrate deploy` (applies `prisma/migrations/`) |
| First admin | `scripts/create-first-vp.mjs` (`docs/deploy/operations-runbook.md` §6) |
| Pause all writes | `TCMS_READ_ONLY=true` + restart |
| Inspect data | MySQL Workbench / `mysql` client with a read-only user |
| Backups | nightly `mysqldump` via `scripts/backup-scheduler.mjs` (`docs/deploy/operations-runbook.md` §2) |
| Logs | `journalctl -u tcms-app` / `journalctl -u tcms-ws` |
