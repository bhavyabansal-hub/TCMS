# TCMS PostgreSQL → MySQL 8.4 Migration — Audit & Estimate (Step 1)

Baseline: TCMS-complete-2026-10-14.zip (adopted 2026-10-14, git 87e5014).
Scope: MySQL-only after cutover. PostgreSQL stays the read-only source for the
one-time data copy. Crew Desk stays on the local mock only; the real host
(dev.eng4.back.shipgl.in) is never called from this sandbox.

## 1. Environment facts (sandbox stand-in for IT answers)

| Item | Value |
|---|---|
| MySQL version | 8.4.6 Community Server (official tarball, real server — not simulated) |
| Host:port | 127.0.0.1:5500 (TEST schema only) |
| Schema | `tcms_test` (separate from any real schema) |
| App user | `tcms_app` — limited rights on `tcms_test` only, not root |
| Auth plugin | `caching_sha2_password` (8.4 default) — verified working |
| TLS | Verified: TLS_AES_128_GCM_SHA256 on the app user session |
| sql_mode | STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION (strict ON) |
| Charset/collation | utf8mb4 / utf8mb4_0900_ai_ci |
| time zone | UTC (+00:00) |
| max_connections | 200 |
| mysqldump | available at /tmp/mysql84/bin/mysqldump (backup scheduler compatible) |

Still needed from the real IT team (cannot be answered from the sandbox):
real host/port, real test-schema name + credentials, firewall reachability,
their server's sql_mode/charset/timezone/max_connections, backup ownership,
and whether the app host may run mysqldump.

## 2. Where the real data lives today (owner question answered)

- The only data that exists anywhere is TEST data: the embedded PostgreSQL in
  this sandbox (localhost:5499/tcms), seeded 7 team accounts + demo modules/
  cases, plus test artifacts from self-tests. Full snapshot taken:
  `backups/tcms-backup-2026-10-14T12-07-15-527Z.json.gz` (pre-migration).
- The uploaded zip contains NO data dump (DDL helpers only). The blocked chat's
  deployment had its own sandbox PG — also test data.
- **No production/real dataset exists in any system I can see.** If the team
  keeps real data elsewhere, it was never connected to TCMS; that system (if
  any) is the true source for the copy and needs a read-only export for me.

## 3. PostgreSQL-specific inventory (code scan of the adopted baseline)

Raw SQL lives ONLY in `*.repository.ts` files + `src/lib/server/*.repository.ts`
(20 files). No raw SQL in services/controllers (verified by scan).

| Construct | Count | MySQL 8.4 treatment |
|---|---|---|
| `RETURNING` (INSERT/UPDATE ... RETURNING) | 24 in 10 files | rewrite: `INSERT` then re-`SELECT` by PK (or `LAST_INSERT_ID()` for auto-ids — not needed here, PKs are uuid) |
| `ILIKE` | 12 | `LOWER(col) LIKE LOWER(?)` (utf8mb4_0900_ai_ci makes plain LIKE case-insensitive too; LOWER() kept for determinism) |
| `ON CONFLICT ... DO UPDATE/NOTHING` | 3 | `INSERT ... ON DUPLICATE KEY UPDATE` (semantics equivalent here) |
| `::int`, `::text` casts | 28 | remove; MySQL casts: `CAST(x AS UNSIGNED)` where needed |
| `gen_random_uuid()::text` DB default | 1 (schema, all PKs) | `CHAR(36) DEFAULT (uuid())` — expression default, supported since 8.0.13 |
| JSONB (Prisma `Json`, `?|`, jsonb funcs in SQL) | 19 refs | MySQL native `JSON`; `->>`/`JSON_EXTRACT` rewrites where raw SQL touches JSON |
| `INTERVAL '7 days'` style | 4 | `INTERVAL 7 DAY` syntax |
| `COALESCE` | 3 | identical in MySQL — no change |
| array params `= ANY($n)` | 0 | none found |
| `date_trunc`, `DISTINCT ON`, `NULLS LAST` | 0 | none found |
| `FOR UPDATE`/`SKIP LOCKED` | 0 in raw SQL (Prisma interactive tx used) | MySQL 8.4 supports both if needed |
| `$1 $2` placeholders | throughout | Prisma parameterizes; raw SQL uses `$n` (PG driver) → `?` (mysql2) |

Schema-level deltas (Prisma → MySQL):
- provider `postgresql` → `mysql`; drop nothing else. `directUrl` retained.
- EVERY `String` gets an explicit native type (none had any — PG defaulted
  everything to TEXT): `CHAR(36)` ids, `VARCHAR(n)` sized per validation caps
  (title 200, email 254, comment 2000, task notes 4000, crewdesk note 1200,
  wiki content MEDIUMTEXT), indexed/unique/searched columns are VARCHAR per
  the MySQL index-key rule.
- EVERY `DateTime` gets `@db.DateTime(3)` — without it MySQL silently drops
  milliseconds and history/audit ordering breaks.
- `Json` → MySQL native JSON columns.
- Case sensitivity (decision): `utf8mb4_0900_ai_ci` everywhere — emails,
  usernames and duplicate checks are case-INSENSITIVE on purpose (matches the
  Crew Desk email check). Exceptions made case-SENSITIVE via per-column
  collation after push: `password_hash`, `refresh_tokens.token` (secrets must
  compare exactly).
- Emoji/Hindi: verified path utf8mb4 end-to-end (server default + connection).

## 4. Other PG-only infrastructure to replace (step 4)

- `scripts/pg-sandbox/*` — embedded PG runtime; stays ONLY as the read-only
  migration source, then retired from boot.
- `scripts/backup-db.mjs` (now `archive/postgres/scripts/backup-db.mjs`) + `scripts/backup-scheduler.mjs` — Prisma-based
  JSON dumps; replaced with `mysqldump` (+ same 14-retention, restore drill).
- `src/app/api/keep-alive/*` — PG keep-alive route; removed (MySQL pool
  doesn't need the PG-specific ping; app health route remains).
- `.env`: `DATABASE_URL`/`DIRECT_URL` → MySQL `mysql://` URL at cutover;
  PG URL kept only for the one-off migration script.

## 5. Estimate

| Work item | Size |
|---|---|
| Schema conversion + push to MySQL 8.4 | ~0.5 day |
| Raw-SQL repository rewrites (20 files, ~68 call sites) | ~1.5 days |
| Backup/keep-alive/boot script swap | ~0.5 day |
| Data migration script (PG→MySQL, batches, dry-run, idempotent) + verification report | ~1 day |
| Re-run all suites + load test (200 users) + compare vs PG | ~1 day |
| Cutover/rollback plan + docs + CHANGELOG | ~0.5 day |
| **Total** | **~5 focused days** |

## 6. Risks flagged up front (to re-test explicitly, per owner's list)

1. Simultaneous review approvals / double submits — MySQL default isolation
   (REPEATABLE READ) differs from PG (READ COMMITTED). The unique-guard +
   transaction code paths must be re-tested for lost updates and deadlocks.
2. Connection count: pool_limit 40 in .env vs max_connections 200 — load test
   with 200 virtual users must watch for `ER_CON_COUNT_ERROR`.
3. Truncation: strict mode turns overlong inserts into ERRORS (good), but any
   validation gap between app caps and column sizes becomes a 500 — the
   per-column sizing table below (in 02-schema-conversion.md) must be kept in
   sync with validation caps.
4. Case sensitivity: emails now collide case-insensitively at the DB level
   (unique index) — matches the app's email checks; verified in suites.
