# Lessons — developer-backend

Append lessons below (format in README.md). Read this file at the start of every run.

## 2026-10-15 seed (from the TCMS worklog)
- What happened: a fixed service was on disk but an old process from a deleted folder kept serving traffic (ws-auth-runtime-1).
- Rule from now on: after changing a service, restart it and prove the running process is the new code (pid, cwd, start time) before reporting.
- What happened: a fresh database failed because JSON defaults lived in a manual fix-up script (startup-guard-1).
- Rule from now on: every schema detail lives in a migration file; prove it on an empty schema.
