# Decision Log

Approved decisions only. Each entry is written by the manager after the owner approves.
Agents read this file before designing or coding; a decision here overrides older docs.

| # | Date | Decision | Reason | Approved by | Related |
|---|---|---|---|---|---|
| D1 | 2026-10-14 | MySQL 8.4 only; PostgreSQL kept read-only as rollback source until 2 weeks after go-live | Company standard database | Owner | mysql-migration-1 |
| D2 | 2026-10-14 | Fresh start in production (no data copy) | No real data exists | Owner | steps-1-3-audit-1 |
| D3 | 2026-10-14 | Self-signup creates `viewer` only, controlled by `TCMS_ALLOW_SIGNUP` (fail-closed) | Prevent privilege escalation | Owner | signup-switch-1 |
| D4 | 2026-10-15 | Schema changes only through versioned Prisma migrations (`migrate deploy`), never `db push` | Repeatable empty-DB builds | Owner | mysql-baseline-1 |
| D5 | 2026-10-15 | Collation `utf8mb4_unicode_ci`; `utf8mb4_bin` for password hash and refresh token | Consistency; exact secret compare | Owner | mysql-baseline-1 |
| D6 | 2026-10-15 | Production guards keyed on `TCMS_DEPLOY_ENV=production`, not `NODE_ENV` | `next start` sets NODE_ENV in sandbox too | Owner | startup-guard-1 |
| D7 | 2026-10-15 | All raw-SQL timestamps use `UTC_TIMESTAMP(3)`; no `INSERT IGNORE` | Time-zone safety; strict mode intact | Owner | mysql-correctness-1 |
| D8 | 2026-10-15 | Run one app instance and one notification service in production | In-memory caches and sockets are per process | Owner | owner review |
| D9 | 2026-10-15 | Never rewrite git history; new commits only | Safe, auditable history | Owner | owner review |
