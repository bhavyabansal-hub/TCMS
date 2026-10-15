# Lessons — sdet

Append lessons below (format in README.md). Read this file at the start of every run.

## 2026-10-15 seed (from the TCMS worklog)
- What happened: a test cleanup killed the wrapper process id while the real server kept the port (ws-reconnect-1).
- Rule from now on: clean up by port or verified pid, then prove the port is free.
- What happened: three suite "failures" were bugs in the test script, not the app (mysql-baseline-1).
- Rule from now on: before filing a bug, confirm the failure is in the product, not the test harness.

## 2026-10-15 REQ-001
- What happened: `verify-wiki.mjs:275` and other suites call `process.exit()` at the end of straight-line code, so a throw skips cleanup; a `finally` would also be skipped by an `exit()` inside the `try` and by Ctrl+C (03-review.md sdet §2).
- Rule from now on: every writing suite sets `process.exitCode` (never `process.exit()` inside `try`), registers a SIGINT handler that runs the same cleanup, prints its stamp first, and offers a `--cleanup-stamp=<n>` mode.
- What happened: fixture rows in `verify-permission-matrix.mjs:105,148,216` carry no stamp, so title-based cleanup misses them.
- Rule from now on: clean up by fixture user ids and collected entity ids, never by title alone; titles get the stamp only as a second key.
- What happened: `audit-standards.mjs:109-110` prints findings to stderr; a plain `>` captures only the summary.
- Rule from now on: capture tool output with `> file 2>&1` in Git Bash and record the exit code; never PowerShell 5.1 `Out-File` (UTF-16, wraps stderr).
- What happened: a full-table permission restore would silently undo a toggle the owner makes on :3000 during a run.
- Rule from now on: restore only the cells the suite touched, and fail with "matrix changed by another actor" if any other cell differs between the start and end snapshots.
