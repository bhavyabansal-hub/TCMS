# Lessons — developer-frontend

Append lessons below (format in README.md). Read this file at the start of every run.

## 2026-10-15 seed (from the TCMS worklog)
- What happened: NEXT_PUBLIC_* values are baked at build time; changing .env without a rebuild changed nothing (signup-switch-1).
- Rule from now on: after changing a NEXT_PUBLIC_* value, rebuild and verify the running page.
