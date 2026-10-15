# Lessons — tester

Append lessons below (format in README.md). Read this file at the start of every run.

## 2026-10-15 seed (from the TCMS worklog)
- What happened: a check run on localhost:3000 missed the gateway path real users take (ws-auth-runtime-1).
- Rule from now on: test through the same URL and route users will use, and state which one in the report.
