# Lessons — sdet

Append lessons below (format in README.md). Read this file at the start of every run.

## 2026-10-15 seed (from the TCMS worklog)
- What happened: a test cleanup killed the wrapper process id while the real server kept the port (ws-reconnect-1).
- Rule from now on: clean up by port or verified pid, then prove the port is free.
- What happened: three suite "failures" were bugs in the test script, not the app (mysql-baseline-1).
- Rule from now on: before filing a bug, confirm the failure is in the product, not the test harness.
