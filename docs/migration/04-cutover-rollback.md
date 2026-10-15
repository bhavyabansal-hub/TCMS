# Cutover & Rollback Plan (Step 8)

This plan is written for the REAL deployment (company MySQL 8.4). The sandbox
already executed a full rehearsal of every step against the TEST schema.

## Preconditions (from IT)

> Ask: IT request file: to be recreated (pending). Answers also fill the
> "only IT can confirm" list in the phase-1 audit report.

- [ ] MySQL 8.4 host:port reachable from the app server, TLS available.
- [ ] TEST schema created + TWO users (task mysql-baseline-1, 2026-10-15):
      `tcms_app` — app runtime, DML ONLY (SELECT, INSERT, UPDATE, DELETE);
      `tcms_migrate` — schema migrations, DDL rights. No root.
- [ ] Server: utf8mb4 (server + schema default), sql_mode carrying
      STRICT_TRANS_TABLES + ONLY_FULL_GROUP_BY (the full 8.4 default),
      time_zone '+00:00' or 'UTC', max_connections known. All three settings
      are ENFORCED at boot by the DB settings guard (docs/migration/02): a
      non-compliant or unreachable server makes the app exit 1 before it
      opens a port.
- [ ] App host can run mysqldump (backup scheduler — now wired into the boot path).

## Schema build (single versioned step — same in sandbox and production)

1. Point `DIRECT_URL` at the migrate user, `DATABASE_URL` at the app user.
2. Run `npx prisma migrate deploy` — the ONLY schema command. The migrations
   in `prisma/migrations/` create all 17 tables with utf8mb4_unicode_ci
   everywhere, utf8mb4_bin on the two secret columns, the JSON expression
   defaults, and the dashboard/notification indexes. NO db push, NO setup.sql,
   NO fixup scripts (all deleted 2026-10-15 — see docs/migration/02).
3. Verify: a second `migrate deploy` must print "No pending migrations", and
   `SELECT migration_name, applied_steps_count FROM _prisma_migrations;`
   must show every row finished. Seed only AFTER this (TCMS_ENABLE_SEED=true,
   then remove the flag). On the first production boot, the DB settings
   guard re-proves the server contract (sql_mode/time_zone/charsets) on the
   app's own connection — its `[TCMS] db-settings OK:` startup line is part
   of the go-live smoke test (.env.example).

## Cutover (order matters)

1. **Freeze writes**: put TCMS in maintenance (or stop the app) — PostgreSQL
   becomes quiescent. Announce a window (~30 min).
2. **Final backup**: run `scripts/backup-db-mysql.sh` equivalent against PG
   (`archive/postgres/scripts/backup-db.mjs`) + keep the last mysqldump of the TEST schema.
3. **Final copy**: `node --env-file=.env scripts/migration/migrate-pg-to-mysql.mjs`
   (NO --truncate on the real schema unless IT provisioned it empty; the
   script is idempotent — re-running after a failed attempt is safe).
4. **Verify the copy**: the script prints per-table row counts, FK-orphan
   audit, utf8mb4 + strict-mode probes. Differences MUST be zero before
   proceeding. Archive the report to docs/migration/.
5. **Switch the setting**: `.env` → `DATABASE_URL`/`DIRECT_URL` =
   `mysql://<app user>:<pass>@<host>:<port>/<schema>?connection_limit=40&pool_timeout=10`.
   Keep `PG_SOURCE_URL` (read-only) for 2 weeks.
6. **Quick check** (10 min): login (cookies set), dashboard stats render,
   create a test case, submit + record one review, import 10 rows, Crew Desk
   test-mode link on the designated ticket, notifications arrive.
7. **Unfreeze**: end maintenance. Watch error logs for 1 hour.

## Rollback (if quick check fails)

1. Re-point `.env` DATABASE_URL/DIRECT_URL back to the PostgreSQL URL
   (kept read-only for exactly this).
2. Restart the app. No data loss: the frozen PG source was never modified
   (the migration only READS it).
3. Post-mortem: compare the verification report diffs, fix the migration
   script, re-rehearse on the TEST schema, schedule a new window.

## After 2 weeks of stable MySQL operation

- Drop the PostgreSQL read-only source (retire scripts/pg-sandbox from boots).
- Remove `PG_SOURCE_URL` from .env and the migration one-offs from scripts/
  (or archive them under docs/migration/ as historical record).
