# Lessons — developer-backend

Append lessons below (format in README.md). Read this file at the start of every run.

## 2026-10-15 seed (from the TCMS worklog)
- What happened: a fixed service was on disk but an old process from a deleted folder kept serving traffic (ws-auth-runtime-1).
- Rule from now on: after changing a service, restart it and prove the running process is the new code (pid, cwd, start time) before reporting.
- What happened: a fresh database failed because JSON defaults lived in a manual fix-up script (startup-guard-1).
- Rule from now on: every schema detail lives in a migration file; prove it on an empty schema.

## 2026-10-15 REQ-001 phase 3 review
- What happened: the docs disagreed about delete semantics. `docs/CODING-STANDARDS.md` §3 said "soft delete / restricted", CODEBASE-MAP said "hard, cascades". The real FKs (`prisma/migrations/*/migration.sql`) show that a module delete sets test_cases.module_id and bugs.module_id to NULL instead of cascading, so an "API cleanup" that deletes the module first would leave its cases behind.
- Rule from now on: before reviewing or designing any delete or cleanup, read the ON DELETE action of every FK in migration.sql. Do not rely on the prose docs. List the cascade children and the SET NULL orphans in the design.
- What happened: a server-side permission gap (PUT task-reports checks only ownership) was nearly sent to the backlog as "not requested".
- Rule from now on: for every endpoint a BRD touches, compare the permission check of each sibling action (POST vs PUT vs DELETE). A missing check is S2 ("permission wrong", WORKFLOW.md §5), whatever the requested scope says.
