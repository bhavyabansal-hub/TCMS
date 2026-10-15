# Schema Conversion: PostgreSQL → MySQL 8.4 (Step 2 deliverable)

The converted schema lives at `prisma/schema.prisma` (provider `mysql`).
The original PostgreSQL schema is preserved at
`archive/postgres/scripts/migration/schema.prisma.pg-backup`. Conversion was done mechanically
by `scripts/migration/convert-schema-mysql.cjs` (deterministic, re-runnable).

## Per-column sizing table (validation-cap driven)

Rules: ids CHAR(36) (uuid), indexed/unique/searched columns VARCHAR,
long free text TEXT/MEDIUMTEXT, JSON stays JSON, every DateTime DATETIME(3).

| Column(s) | Type | Why |
|---|---|---|
| all `*_id` PK/FK columns | CHAR(36) | uuid strings; DEFAULT (uuid()) replaces gen_random_uuid() |
| users.email, login_attempts.email | VARCHAR(254) | RFC max email length; UNIQUE (case-insensitive via utf8mb4_unicode_ci) |
| users.full_name | VARCHAR(120) | people names |
| users.password_hash | VARCHAR(255) **utf8mb4_bin** | hash output ≤ 100; case-SENSITIVE compare (secret) |
| refresh_tokens.token | VARCHAR(768) **utf8mb4_bin** | JWT refresh tokens measured > 255 — widened after strict mode rejected inserts; case-sensitive |
| role / status / priority / severity / verdict / kind / type | VARCHAR(8–64) | enum-like short strings (all documented in-line in the schema) |
| action (role_permissions, activity_logs) | VARCHAR(64) | permission action names |
| module.name, tc.title, bug.title, notification.title, wiki.title, entity_name | VARCHAR(200) | title cap 200 |
| description / preconditions / expected_result / steps_to_reproduce / expected_behaviour / actual_behaviour / comment / change_summary / body / notes | TEXT | 64 KB, exceeds all caps (5000/4000/2000) |
| wiki_documents.content | MEDIUMTEXT | sanitized rich-text HTML (largest free text) |
| wiki_documents.file_data | LONGBLOB | 10 MB upload cap |
| modules.path | VARCHAR(1000) | materialised id path, prefix-searched |
| crew_desk_links.ticket_id | VARCHAR(64) | searched + unique(module,ticket) |
| crew_desk_links.note | VARCHAR(1200) | 4× the 300-char cap (multi-byte safety) |
| crew_desk_links.last_error | VARCHAR(1000) | error text |
| activity_logs.ip_address / user_agent | VARCHAR(64) / VARCHAR(512) | headers |
| all Json columns | JSON + DEFAULT (CAST('[]' AS JSON)) | expression defaults restore PG behavior for raw INSERTs — carried IN the baseline migration `20261015034822_init_mysql` (the standalone mysql-json-defaults.sql was deleted 2026-10-15) |
| all DateTime | DATETIME(3) | millisecond precision preserved (PG timestamptz(3) equivalent); DB stores UTC, app treats UTC |

## Case-sensitivity decision (owner point 3)

- Default collation **utf8mb4_unicode_ci** (case-insensitive) everywhere:
  emails, names, duplicate checks, search — "Test" = "test" ON PURPOSE.
  (Prisma emits unicode_ci per table; the server default 0900_ai_ci is
  equivalent for our purposes — documented, deliberate.)
- Exceptions **utf8mb4_bin** (byte-exact): `users.password_hash`,
  `refresh_tokens.token` (secrets) — carried directly IN the baseline
  migration `20261015034822_init_mysql` (hand-edited, owner-approved
  2026-10-15). The separate collation-fixups.sql is DELETED: a fresh schema
  built with `prisma migrate deploy` has the correct collations with zero
  manual steps, and no `db push` can strip them anymore.

## Login/auth verification (owner point 5)

- `caching_sha2_password` is the 8.4 default and the app user uses it (verified
  via mysql.user.plugin).
- TLS: server supports TLS; verified `TLS_AES_128_GCM_SHA256` on an app-user
  session with `--ssl-mode=REQUIRED`. For the real deployment, ask IT for
  their cert setup; Prisma connects with `sslmode=REQUIRED` equivalent via
  `?sslAccept=strict` if they present private CAs.

## Things IT still owns (cannot be verified from the sandbox)

- Real host/port/credentials + network reachability + firewall.
- Their server's sql_mode/charset/timezone/max_connections — the first three
  are now ENFORCED at boot by the DB settings guard (task db-settings-guard-1,
  2026-10-15; src/lib/server/db-settings-guard.ts): with
  TCMS_DEPLOY_ENV=production the app reads SESSION @@sql_mode, @@time_zone,
  @@character_set_server on its own connection plus the app schema's default
  charset (information_schema.SCHEMATA) and exits 1 before opening any port
  when sql_mode lacks STRICT_TRANS_TABLES or ONLY_FULL_GROUP_BY, the time
  zone is not '+00:00'/'UTC', or the server OR schema charset is not utf8mb4.
  An unreachable database is retried 5× 3 s apart, then the boot fails with
  "database unreachable (<host>:<port>)" (no credentials printed).
  transaction_isolation is reported on the startup line but does not fail the
  boot (the concurrency task owns it). IT must set sql_mode in my.cnf so it
  survives restarts — the sandbox pins the same full 8.4 default in
  scripts/migration/mysql84-boot.sh.
- Backup ownership + restore drills with their tooling (our
  scripts/backup-db-mysql.sh + scripts/restore-mysql.sh assume mysqldump
  access from the app host).
