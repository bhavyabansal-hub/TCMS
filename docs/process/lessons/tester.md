# Lessons — tester

Append lessons below (format in README.md). Read this file at the start of every run.

## 2026-10-15 seed (from the TCMS worklog)
- What happened: a check run on localhost:3000 missed the gateway path real users take (ws-auth-runtime-1).
- Rule from now on: test through the same URL and route users will use, and state which one in the report.

## 2026-10-15 REQ-001
- What happened: during the phase 3 review, the BRD named 6 demo accounts, but `src/app/api/seed/seed.service.ts:56-83` seeds 7 (qa2@tcms.com was missing). A log-based criterion (R3.AC7) assumed 403 lines can be attributed to a role, but `src/lib/api.ts:241` logs no user id.
- Rule from now on: take demo accounts from the seed source, never from a script. Before accepting a log-based criterion, open the log call and confirm that the fields it needs (user, role, time zone) are actually logged.
- What happened: every task-report save notifies all other `view_all_task_reports` holders and tries email/Telegram (`task-reports.service.ts:166-183`, `delivery.ts:146-173`). There is no DELETE endpoint for task reports, so the tester cannot clean up its own test rows.
- Rule from now on: before planning any write test, list its side effects (notifications, external delivery, audit rows) and how each row will be removed. Record the id of every created row in `07-test-report.md`, and ask for it to be added to the cleanup inventory.
- What happened: during the phase 3 re-check, BRD v2 had an exact-string criterion with a locale-dependent placeholder (`{date}` "as shown in the Date field"). It also had "exactly one notice" next to an error alert that can appear at the same time, and "0 rows" evidence from a checker that had never been validated.
- Rule from now on: every placeholder in an exact-string criterion must have a fixed format. Every count word ("one notice") must say what is and is not counted. A zero result counts as evidence only after the same tool has shown a non-zero result on known data.
- What happened: in phase 5, R3.AC6 asked for "a seed test case that has activity", but the seed writes no activity rows (`seed.service.ts:17-18`), so no seed case is guaranteed to have any.
- Rule from now on: when a criterion needs data in a given state, check in the source that the state can exist, and write a fixed read-only selection rule plus a BLOCKED fallback into the test plan, instead of creating data to make it pass.
