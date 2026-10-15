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
| D10 | 2026-10-15 | REQ-001 BRD v2 approved with pins P1–P8 and all team recommendations, plus these owner answers: Q1 build in a separate git worktree copy; Q13 test date 2026-10-01; Q17 email and Telegram NOT configured (owner-confirmed); Q19 yes; Q21 yes; Q2 one-time grant to manager (D11); Q3/Q4/Q5/Q6/Q20 recommendations (Q6 = D12); Q8 leave as is; Q16 no; Q22 yes; Q15 R11 IN scope. A2/A3 accepted as procedure only: the R9 delete still needs a separate written owner go on the exact dry-run key list | Owner approval of the BRD (phase 4) | Owner (in chat, recorded by manager; see `03-review.md` Owner decision) | REQ-001 |
| D11 | 2026-10-15 | One-time edit grant (exception to WORKFLOW rule 7): the manager may edit only these lines for REQ-001 R4 / R11 / Q22: `CODEBASE-MAP.md` :78, :114, :120, :126; `agent.md` :208-209 (DoD item 7); `docs/06-page-login-and-dashboard.md` :74-76, :93-94; `docs/04-api-reference.md` :206 (R4.AC9) and :216 (R4.AC8). Line numbers as of BRD v2 (`02-brd.md:224`, `:530`). `docs/README.md` is NOT included (Q8 = leave as is). Any other line in these files needs a new owner approval. Expires at REQ-001 release (`10-release.md` RELEASE) | No other role is allowed to edit these files; R4 was blocked without it | Owner (in chat, recorded by manager) | REQ-001 Q2, M2, M10 |
| D12 | 2026-10-15 | Delete semantics: the code is authoritative (hard delete of test cases and wiki docs; module delete cascades submodules/reviews and sets `module_id` NULL on cases and bugs). `agent.md` §2 (:138-139) is wrong and is fixed later under backlog B18, not in REQ-001 | `agent.md` contradicts the code (`03-review.md` M3) | Owner (in chat, recorded by manager) | REQ-001 Q6, B18 |
| D13 | 2026-10-15 | Owner speed rules for the REQ-001 build: work straight through without re-reviews unless a gate fails; keep reports short; ask the owner only if something is blocked, a file outside the approved scope must change, or before the cleanup deletes data. Phase gates, DoD and the R9 delete gate still apply | Owner request | Owner (in chat, recorded by manager) | REQ-001 |
