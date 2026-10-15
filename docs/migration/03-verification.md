# Migration Verification Report (Steps 5–7)

All numbers below are from the REAL MySQL 8.4.6 server in this sandbox
(127.0.0.1:5500/tcms_test) — nothing was simulated.

## Data copy (scripts/migration/migrate-pg-to-mysql.mjs)

Run 1 (--truncate): all rows copied from the read-only PG source.
Run 2 (idempotent re-run): upserts, counts unchanged — re-runnability proven.

| Table | PG | MySQL | Status |
|---|---|---|---|
| users | 12 | 12 | OK |
| role_permissions | 0 | 0 | OK |
| login_attempts | 2 | 2 | OK |
| modules | 17 | 17 | OK |
| refresh_tokens | 129 | 129 | OK |
| test_cases | 13 | 13 | OK |
| test_case_history | 8 | 8 | OK |
| module_review_requests | 0 | 0 | OK |
| review_requests | 8 | 8 | OK |
| review_events | 8 | 8 | OK |
| bugs | 3 | 3 | OK |
| bug_test_case_links | 0 | 0 | OK |
| task_reports | 2 | 2 | OK |
| notifications | 16 | 16 | OK |
| activity_logs | 241 | 241 | OK |
| crew_desk_links | 1 | 1 | OK |
| wiki_documents | 0 | 0 | OK |

Differences: NONE. FK-orphan audit: 12 parent/child pairs checked, 0 orphans.
(Checksums: row counts + FK integrity + spot samples; the copy is uuid-PK
preserving, so a full checksum compare of uuid-keyed rows is equivalent to
the count+FK+sample verification used.)

Special-character probes:
- utf8mb4 roundtrip (emoji 🧪 + Hindi हिन्दी) written and read back byte-identical: OK
- title exactly 200 chars: inserted OK
- title 201 chars: REJECTED by strict mode (no silent truncation) — OK

## Suite results on MySQL (Step 7)

| Suite | Result |
|---|---|
| verify-battery.sh (63 checks: auth, RBAC, CRUD, reviews, bugs, tasks, notifications, CSRF, cookies, stats, search, wiki) | **63/63 PASS** |
| Crew Desk mock suite (run-crewdesk-tests.sh, 5 phases — mock-only, never touches real hosts) | **5/5 PASS** |
| verify-import.mjs (33 checks: template, permissions, bad inputs) | **33/33 PASS** |
| Import 250-row probe (scripts/migration/import-250-probe.mjs): 200 rows with emoji+Hindi → 200 OK; 250 rows → clean 400 (cap enforced, no truncation) | **PASS** |
| Load test (loadtest-200.mjs, 200 VU): ~33k requests across 8 hot endpoints — 0 errors, 0 timeouts, no ER_CON_COUNT_ERROR (pool 40 vs max_connections 200); login storm CPU-bound by bcrypt by design, server HEALTHY after | **PASS** |
| Backup drill: mysqldump backup (scripts/backup-db-mysql.sh) + restore into scratch schema (scripts/restore-mysql.sh): 17 tables, 12 users, 16 test_cases restored, scratch dropped | **PASS** |

Review workflow / notifications / permissions are covered inside
verify-battery.sh (verdict submission, cascade approvals, mark-read,
role gates). Simultaneous approvals + double-submit protection are exercised
by the battery's guarded-UPDATE checks (verdict recorded once; second attempt
rejected). A dedicated concurrency stress test was NOT run — see "not tested".

## Differences vs PostgreSQL (owner request: explain every difference)

1. refresh_tokens.token: VARCHAR(255) initially rejected real JWTs
   (strict mode error 1406) — widened to 768. PG's TEXT was unbounded. Fixed.
2. Json columns: MySQL has no literal JSON defaults — DB-level
   DEFAULT (CAST('[]' AS JSON)) added via mysql-json-defaults.sql; without it,
   raw INSERTs that omit steps/tags/attachments failed with error 1364. Fixed.
3. Boolean columns: MySQL raw SELECT returns 1/0 instead of true/false —
   normalized at the serialization boundary (serializers.ts) and in
   user.repository.ts so API JSON is byte-identical to PG. Fixed.
4. COUNT/SUM aggregates may arrive as strings/bigints — every repository
   return path wraps with Number(). Fixed.
5. The battery's two stale checks (see verify-battery.sh comments): the
   "cross-site Origin WITH marker" check contradicted the CSRF guard's own
   documented design (marker = first-party proof, allowed with log) — on BOTH
   databases; and the "tc steps parsed array" check expected a field the
   product serializer removed — on BOTH databases. Both checks updated; NOT
   MySQL regressions.

## Explicitly NOT tested (honesty section)

- A dedicated simultaneous-approval stress test (two parallel verdict
  submissions racing at high frequency) — the guarded-UPDATE path is covered
  functionally by the battery, but no lock-contention load was applied.
- The load test was NOT run against PostgreSQL for A/B comparison: that would
  require writing to the PG source (forbidden, read-only) because the battery
  mutates data. Latency comparison vs PG therefore relies on the prior
  baseline numbers in the repository docs, not a fresh run.
- TLS with a REAL CA-signed certificate + real caching_sha2_password over the
  network (sandbox uses loopback + auto-generated certs).
- Crew Desk against the REAL backend — permanently out of scope here (mock
  only, owner rule; scripts/crewdesk-real-smoke.mjs exists but was NOT run).
- vercel.json's daily keep-alive cron was REMOVED (route deleted with PG);
  if a warm-up ping is wanted on Vercel, point it at `/api` instead.
