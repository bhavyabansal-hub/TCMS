# TCMS Backlog

Ideas and open work that are NOT in an approved requirement yet. The manager keeps this list;
the owner picks what becomes the next REQ. Items below were seeded on 2026-10-15 from
`worklog.md` and the owner's review notes. Each agent must re-verify an item against the
current code before working on it (things may have changed).

| # | Item | Why it matters | Source | Priority |
|---|---|---|---|---|
| B1 | One-time script to create the first VP account in production | Seed is blocked in production and signup creates only viewers, so a fresh production DB has no admin | startup-guard-1, signup-switch-1 | Must before go-live |
| B2 | Concurrency safety: review verdicts, module bulk-approve, task-report upsert (transactions / guarded updates / 409; decide READ-COMMITTED) | Two users acting at once was never stress-tested on MySQL | 03-verification.md "NOT tested" | Must before go-live |
| B3 | Map MySQL/Prisma errors to clear HTTP responses (duplicate, FK, too long, deadlock retry, pool timeout, DB down) | Users otherwise see generic 500s | owner review | High |
| B4 | Verify "Needs revision" flagged fields round-trip (old note said they may always save as empty) | Possible silent data loss in reviews | worklog 9-b | High (verify first) |
| B5 | Security headers (CSP, HSTS, nosniff, frame-ancestors), `/api/ready` readiness check, `TCMS_READ_ONLY` maintenance mode | Standard production protections | owner review | Medium |
| B6 | CSV export formula-injection protection + per-IP login rate limit | Spreadsheet injection; lockout abuse | owner review | Medium |
| B7 | Remove PostgreSQL-era leftover scripts and docs (keep the PG rollback source until 2 weeks after go-live) | Confusing, dead code | mysql-baseline-1 list | Medium |
| B8 | Clean up test accounts created by suites (`self-*@tcms.test`) | Test data pollution | mysql-baseline-1 | Low |
| B9 | Reports page date filters are not wired to the API | Feature looks like it works but does not filter | worklog 2-a | Low |
| B10 | Local setup outside the old cloud sandbox (MySQL 8.4 in Docker, same settings) | Old boot scripts assume /tmp/mysql84, preview URLs, XTransformPort | move to Claude Code | Must (first) |

## Waiting on IT (not agent work)
MySQL host/port, TEST schema + users, TLS certificates, sql_mode/time_zone/utf8mb4 confirmation,
nginx WebSocket proxy + X-Forwarded-Proto, TCMS_DEPLOY_ENV=production, single app instance,
cron jobs for backups, backup storage location. See `download/it-request-mysql.md`.
