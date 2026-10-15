# REQ-001 BRD Review Meeting

Each role writes ONLY its own section. Reply to others under their section, never edit it.

## developer-backend
Verdict: **CHANGES** (R1–R5, R8 and R10 are feasible as written. Before owner approval, R7, R9, Q5, Q6, Q14 and Q15 need the corrections below.)

All citations were opened in this run. No database query was run and nothing on :3000 was touched.

### Feasibility / risks / effort

**R1–R3 (UI gates): feasible. No backend change needed, except Q15.**
- The server gates the BRD relies on exist and read the live matrix. `ensurePermission` calls `can(user.role, action)` (`src/lib/auth.ts:186-188`), and `can` reads the override cache, which has a 3 s TTL (`src/lib/permissions.ts:70`, `:113-122`). So R1.AC7, R2.AC4 and R3.AC6 are enforced on the server as soon as the VP toggles a cell. Only the client snapshot needs a new login.
- A BRD NOT VERIFIED item, answered from the backend side: login, register and `GET /api/auth` (me) re-read the override table on every call (`permissions.ts:129-142`). Whether a page reload calls `GET /api/auth` is a frontend question. Keeping "fresh login" in the criteria is still the safe choice.
- The UI never calls `PUT /api/task-reports`. The client defines it (`src/lib/client/api.ts:447`), but `tasks.tsx` uses only `upsert`/POST (`tasks.tsx:395`). R1 therefore needs only the POST gate (`task-reports.service.ts:193`).

**Q15 (PUT task-report gap): confirmed. I disagree with "backlog".**
- `updateTaskReportFields` (`src/app/api/task-reports/task-reports.service.ts:252-262`) checks only that the report exists (`:258-259`) and that the caller owns it (`:260-262`). It never calls `ensurePermission(…'create_task_report'…)`. POST does (`:193`). Every comparable edit path checks a permission: test cases (`test-cases.service.ts:153`, author plus `edit_own_test_case`) and bugs (`canAny(create_bug, assign_bug)`, `CODEBASE-MAP.md:77`). So the owner rule "not granted → … 403" (`CODEBASE-MAP.md:109`) is broken on the server.
- WORKFLOW.md:97 classes "permission wrong" as **S2 Major (must fix before release)**. That puts it above the S3/S4 items the owner already asked for.
- It also makes the BRD's header claim "The backend gates are already correct" (`02-brd.md:9`, also §5 and §7 "Any API … change") inaccurate.
- The fix is small and safe. Add `ensurePermission(me, 'create_task_report', 'Insufficient role')` as the first line of `updateTaskReportFields`, before the lookup at `:258`. This mirrors `:193` and does not reveal whether a report id exists. There is no schema, migration or cache change. The status set after the fix: 401 no session; 403 no permission (any id); 404 missing (with permission); 403 another user's report; 400 bad body; 200 own report.
- Effort: about 1 h of code plus one sdet check in `verify-permissions.mjs` (viewer `PUT ?id=<any>` → 403, owner with the permission → 200).

**R5, R8: feasible.** They are script-only and outside my area. I have nothing to add.

**R6 (verify-wiki): feasible, with backend notes.**
- Bypassing the permission service: `:231-233` and `:245` write `role_permissions` directly. This skips `invalidatePermissionCache()` and the audit row (`permissions.service.ts:65-83`) and depends on the 3.5 s sleep matching the 3 s TTL. That works, but it is fragile.
- Restore semantics: the API cannot restore every prior state. Toggling a cell to its default value deletes the row (`permissions.service.ts:53-60`, repository `role-permission.repository.ts:60-63`). A toggle through the API also overwrites `updated_by_id` with the fixture VP, who is then deleted. `role_permissions.updated_by_id` has no FK (`prisma/schema.prisma:128`), so the id would dangle. A byte-exact restore of R6.AC3 state (ii) therefore needs the SQL snapshot and restore described below.
- PUT response: the toggle response always says `source: 'override'`, even when it just deleted the row (`permissions.service.ts:85-90`). Hygiene checks in R6 and R7 must read `GET /api/permissions`, never the PUT response. This is a minor server defect. **Backlog, not this REQ.**
- Notifications: wiki creates no notifications (grep for `createNotification` in `src/app/api/wiki/*.ts` finds nothing). So Q14 only affects R6 through the fixture users' own rows.
- Cleanup order: the current cleanup order at `:267-271` is correct and must be kept. Delete wiki docs first, because `wiki_documents.author_id` is ON DELETE RESTRICT (`migration.sql:399`). Delete `activity_logs` **before** the users, because the FK is SET NULL (`migration.sql:396`). If users go first, the fixture's log rows lose `user_id` and can no longer be found.
- Write calls: `:231`, `:245` and `:267-271` use `$queryRaw` for writes. They should use `$executeRaw`, as every repository does (agent.md:47-48). Fixture users are created with an ORM call (`:30`, `db.user.create`), which agent.md:75 forbids in application code. Scripts are not application code, but R6.AC2 should also require raw SQL here, for consistency with D7.

**R7 (verify-permission-matrix): feasible only after AC7 and Q14 are reworded.**
- A second unconditional override reset: `:62-64` resets `viewer/create_bug` and `viewer/create_test_case` to default **unconditionally** at start-up. That is the same defect as `verify-wiki.mjs:245`: it destroys a real VP override. R7.AC4 would catch it, but the BRD should name it so the sdet removes it rather than tests around it.
- R7.AC7 cannot be met as written. `notifyReportHolders` notifies **every active holder of `view_all_task_reports`** (`task-reports.service.ts:158-183`, `:166`), which includes the demo admin, teamlead and product accounts. Self-provisioned fixture users do not avoid this. Each create-task-report probe (`:164-168`) therefore writes `notifications` rows that belong to demo users. Module/case review submission without an explicit `reviewerId` also auto-picks the first active VP/Manager (`modules.service.ts:247-248`) and notifies them (`:300-309`).
- Notifications that cannot be undone: `createNotification` also fans out to email and Telegram (and WS) when those are configured (agent.md:159-166). A row can be deleted afterwards. **An email or Telegram message cannot.** Whether SMTP or Telegram is configured on the owner's machine is UNKNOWN, because no agent may read `.env`.
- R7.AC5: a closed signup returns **403** "Self-signup is disabled…" before any DB write (`src/app/api/auth/auth.service.ts:168-173`). This resolves a BRD NOT VERIFIED item.
- R7.AC5: R7.AC5 is directly testable as written.
- Q14 versus R7.AC7: they contradict each other. Q14 keeps the "activity_logs written by the VP setup account", while R7.AC7 allows only the admin's login rows. The suite also authors its fixtures as the demo admin (`:66-75` `adminCreateCase` with `adminJar`).
- Hard-deleting fixture users: there is no hard-delete API for users. `DELETE /api/users` is soft (`users.repository.ts:102-107`). Removing fixture users therefore needs SQL, in FK order:
  1. Content the users authored. These FKs are RESTRICT: modules owner/creator, test_cases author, review_requests reviewer/requester, module_review_requests, review_events reviewer, bugs reported_by and wiki author (`migration.sql:321-324, 333, 351-363, 372, 375, 399`).
  2. Their `activity_logs`.
  3. The users. `task_reports`, `notifications` and `refresh_tokens` cascade (`:315, :390, :393`).
- Concurrency: "before/after row counts per table are equal" (R7.AC6, R9.AC4) breaks if the owner uses :3000 during the run, because each login adds refresh_tokens and activity_logs rows. The DoD suites (verify-import, verify-permissions) also add rows on every run.

**R9 cleanup: feasible only as Q5 option (2), the SQL script. Options (1) and (3) cannot meet the criteria.**
- Option 1, API only, is **incomplete** and has an ordering trap:
  - (a) There is no DELETE endpoint for task_reports, reviews or module-reviews. The only DELETE handlers are in bugs, modules, notifications, test-cases, users and wiki `route.ts`. Groups B and D and the review rows in group A cannot be removed.
  - (b) Users are soft-delete only (`users.repository.ts:102-107`).
  - (c) Notifications can be deleted only by their recipient (self-scoped, `CODEBASE-MAP.md:79`).
  - (d) There is no endpoint that sets a test-case status back, so the R9.AC6 rollback is impossible.
  - (e) **Trap: deleting the QACHECK module does NOT delete its cases.** `test_cases.module_id` and `bugs.module_id` are ON DELETE SET NULL (`migration.sql:330`, `:381`; `modules.repository.ts:138-142`). If the module goes first, the 4 QACHECK cases survive with no module. They vanish from the tree but still show in /test-cases and Ctrl+K search, so R9.AC5 fails. Delete the cases first.
  - On the other hand, the API writes DELETE audit rows (`test-cases.service.ts:327-335`, `modules.service.ts:332-340`).
- Option 3, soft only, **fails R9.AC5**:
  - Search does not filter `deprecated` (`src/app/api/search/search.repository.ts:51` filters on title LIKE only; grep finds no `deprecated` in the file).
  - Modules, bugs, wiki docs and reviews have no soft-delete state at all.
- Option 2, the SQL script, is my recommendation, with these backend requirements for the sdet script (I will review its SQL in the phase 5 design):
  1. **Connection guard first.** `SELECT @@port, DATABASE()` must return `5500` and `tcms_test`, or the script aborts before any other statement. This proves the target without reading `.env`. It is the only safe guard against 3306 when the URL comes from `DATABASE_URL`.
  2. **Dry run by default.** The dry run prints primary keys. The delete run takes the **approved list of primary keys** as input, not the LIKE patterns, and inside one transaction re-counts the matches. If any count differs from the approved list, it rolls back and aborts. A LIKE re-evaluated at delete time could catch rows created after approval.
  3. **Child rows.** The dry run must list the cascade children too, so the owner approves what the cascades remove: test_case_history, review_requests, review_events, bug_test_case_links (`migration.sql:342, 357, 366, 369, 384, 387`), and module descendants through the materialised `path` (`schema.prisma:100`, cascade at `migration.sql:318`).
  4. **Rows with no FK.** Delete `crew_desk_links` by module_id explicitly, because it has no FK (`modules.repository.ts:144-148`). Notifications that point at deleted entities (`entity_type`/`entity_id`, `schema.prisma:334-335`; for example the two review_assigned rows sent to the product user) must be listed too. Otherwise they survive as dead links.
  5. **Delete order.** Test cases before the module. activity_logs (if the owner ever chooses to delete them) before users.
  6. **Caches.** The only server cache is the stats cache, 5 s TTL (`stats.service.ts:37`). SQL deletes are therefore visible in the UI within 5 s, and no restart is needed (R10 holds).
  7. **Status rollback (R9.AC6, group D).** Deleting the verify-permissions module review cascades its case reviews (`migration.sql:366`). Any seed case it moved to `in_review` (`modules.service.ts:285-288`) would then be stuck in `in_review` with no open review, a state the review state machine cannot leave.
     - The prior status is **not stored anywhere**. `updateTestCaseStatus` writes no history (`test-cases.repository.ts:174-181`), and the REVIEW_SUBMITTED log keeps only `caseCount` (`modules.service.ts:290-299`).
     - The only evidence is the seed definitions (`src/app/api/seed/seed.service.ts:158-202`) and earlier review_events verdicts. The dry run must print both per case.
     - Restoring the status is a raw `UPDATE … status, updated_at = UTC_TIMESTAMP(3)` with no version bump. That matches how the app itself flips status at submit, but the owner should approve it explicitly. agent.md:140-141 says every update bumps the version.
     - Alternative: leave group D's module review in place (it is "real" review history) and delete only the "Perm-verify case" rows. This avoids any rollback.
- Backup on Windows: the owner takes it, as the BRD recommends. Concrete requirements for Q5:
  - **Command shape:** `mysqldump --protocol=TCP --host=127.0.0.1 --port=5500 --user=<user> -p --single-transaction --hex-blob --routines --triggers --no-tablespaces --set-gtid-purged=OFF --default-character-set=utf8mb4 --databases tcms_test --result-file=<path>`.
  - **Why `--protocol=TCP` and explicit `--host`/`--port`:** without them, the Windows client can fall back to the default port 3306 or to a named pipe.
  - **Why `-p` with no value:** it prompts for the password, so the password never appears in the shell history.
  - **Why `--result-file` instead of PowerShell `>`:** Windows PowerShell 5.1 redirection writes UTF-16, which corrupts the dump.
  - **Why `--hex-blob`:** `wiki_documents.file_data` is binary (`schema.prisma:405`).
  - **Evidence:** file size, the trailing `-- Dump completed` line, and exact `COUNT(*)` per table at backup time (InnoDB `table_rows` is an estimate). These counts are the "before" counts for R9.AC4.
  - UNKNOWN: whether `mysqldump.exe` is on the owner's PATH, and whether the available DB user has SELECT/SHOW VIEW/TRIGGER on every table. The migrate user is DDL-only (agent.md:72-73).
  - A restore drill into a scratch schema on 5500 would be a write to the shared server. It runs only if the owner explicitly asks for it.
- Group E: I agree with leaving the `notif-verify-*` user soft-deleted. A hard delete would hit the RESTRICT FKs on whatever it authored.

**Q6 (delete-semantics contradiction): confirmed. agent.md is wrong in more places than the BRD lists.**
- agent.md:138-139 says test cases are soft-deleted (`deprecated`), module and case deletes are "restricted by relations", and "only bugs hard-delete (admin only)". The code says otherwise:
  - Test cases are hard-deleted, single (`test-cases.repository.ts:186-193`) and in bulk (`test-cases.service.ts:347`). Their children are **cascaded**, not restricted (`migration.sql:342, 357, 387`).
  - A module delete cascades to submodules and module reviews and **sets** `module_id` to NULL on its cases and bugs (`modules.repository.ts:138-148`).
  - Wiki docs are also hard-deleted (`wiki.repository.ts:123`).
  - `delete_bug` is held by the manager too, not only the admin (`permissions.ts:42`).
- CODEBASE-MAP.md:73 "hard, cascades" is closer, but incomplete: cases and bugs are orphaned, not cascaded.
- I agree with the BRD recommendation: the code is authoritative for this cleanup. The backlog item should list all of the points above, so that whoever fixes agent.md §2 (or restores soft delete, if that was intended) has the full picture. I see no code change needed in REQ-001.

**Effort for my role:** about 0.5 day for the phase 5 design (confirming that no API change is needed beyond Q15, and the SQL review of the cleanup script and of the R6/R7 fixture SQL). About 1–2 h to build Q15 if it is accepted. Nothing else in my area is built.

### Requested changes (with reasons)
1. **Q15:** reclassify the gap as S2 (WORKFLOW.md:97 "permission wrong") and add it to REQ-001 as R11. Acceptance criteria: a user without `create_task_report` who sends `PUT /api/task-reports?id=<own or any id>` gets 403 "Insufficient role"; the owner with the permission gets 200 (unchanged); 404 and 401 are unchanged; a check is added to a DoD suite. Correct `02-brd.md:9`, §5 and §7 ("no API change") to match. If the owner keeps it in the backlog, the BRD must say that the owner accepts a known S2 permission gap for this release. *Reason:* the BRD's own principle and the workflow severity table both require it, and the fix is one line.
2. **R7.AC7:** reword it to "after cleanup no row remains that the run created, including notifications addressed to demo users (deleted by `entity_type`/`entity_id`)". Add: "the setup uses only stamped fixture users created by SQL, never a demo login", and "every review submission passes an explicit fixture `reviewerId`". Add a NOT VERIFIED or precondition line: email and Telegram delivery for those notifications cannot be undone, so the owner confirms that SMTP and Telegram are unset or accepts the messages. *Reason:* as written, AC7 is infeasible (`task-reports.service.ts:166`; `modules.service.ts:247-248`).
3. **Q14 and R7.AC7:** make them consistent. If the demo admin is no longer used (change 2), the "VP setup account activity_logs are kept" clause in Q14 is dropped. *Reason:* the two currently contradict each other.
4. **R7:** add an explicit criterion that the start-up reset at `verify-permission-matrix.mjs:62-64` is replaced by snapshot-and-restore. *Reason:* it unconditionally overwrites VP overrides, the same defect as R6 `:245`.
5. **R6.AC3 and R7.AC4:**
   - Specify the restore mechanism: snapshot the full `role_permissions` rows (role, action, enabled, updated_by_id, updated_at) by SQL before the run, and restore them exactly by SQL in `finally`.
   - Let R6.AC2 allow writing back a **captured** `updated_at` value (D7 applies to new timestamps).
   - Verify with `GET /api/permissions` only, never the PUT response.

   *Reason:* the API cannot recreate a prior `updated_by_id` or a default-valued row (`permissions.service.ts:53-60`, `:85-90`).
6. **R6.AC2:** add "the suite uses no ORM model calls and uses `$executeRaw` for writes". *Reason:* `:30` uses an ORM call and `:231/:245/:267-271` use `$queryRaw` for writes; agent.md:47-48 and :75.
7. **R6.AC7, R7 and R9:** add "every DB-touching script first asserts `SELECT @@port, DATABASE()` = `5500`, `tcms_test` and aborts otherwise". *Reason:* this is the only way to prove agent.md §6 without reading `.env`.
8. **R6.AC6, R7.AC6 and R9.AC4 (row-count evidence):** scope the counts to rows that match the run's stamp or IDs (expected 0 after the run). Global table counts are supplementary and valid only when the tester records that nobody used :3000 and no other suite ran during the window. *Reason:* concurrent logins and DoD suites change global counts.
9. **Q5 and R9:**
   - Remove option (3) and option (1) as standalone choices. They cannot meet R9.AC5/AC6 (no DELETE for task_reports or reviews, no status endpoint, search shows `deprecated`, a module delete orphans its cases).
   - Fix the method to option (2) with the delete-by-approved-primary-keys plus re-count-in-transaction rule.
   - Add the concrete Windows backup command shape and evidence listed above.
   - State "test cases before module" in the criteria.

   *Reason:* this prevents a partial cleanup and orphaned QACHECK cases.
10. **Q3 and R9.AC6 (group D):** offer the owner the alternative of keeping the verify-permissions module review (and leaving the seed case statuses unchanged), and deleting only the "Perm-verify case …" rows. If rollback is chosen, the dry run must print each affected case's current status and its evidence for the prior status (`seed.service.ts:158-202`, earlier review_events). The owner must also approve the status-only UPDATE with no version bump. *Reason:* the prior status is not stored anywhere, and deleting the review without a rollback strands cases in `in_review`.
11. **Q13 and R1.AC5:** add to the inventory the `daily_report_submitted` notifications that each test save sends to vp, manager and product (`task-reports.service.ts:166-183`). *Reason:* these are test data, and they are created on every save.
12. **Backlog (no REQ-001 change):**
    - The toggle response returns `source: 'override'` after deleting the row (`permissions.service.ts:85-90`).
    - Add the full list of agent.md:138-139 errors from Q6 above to the new backlog item.

### Re-check (BRD v2)
Verdict: **APPROVE** for the backend part. The open items below are owner decisions, not BRD defects. I re-opened `02-brd.md` v2, the product-owner answers, and `src/app/api/task-reports/route.ts:54-63` and `task-reports.service.ts:77-83`. No code was changed, no DB query was run, and nothing was sent to :3000.

| # | Status | Where v2 resolves it |
|---|---|---|
| 1 Q15 / R11 | RESOLVED (draft), OWNER DECISION Q15 | R11.AC1–AC6. The header `:9`, §5 `:484` and §7 `:508-509` are corrected. R11.AC1 (non-existent id → 403) puts the check before the lookup, as I asked. |
| 2 R7.AC7 infeasible | RESOLVED, OWNER DECISION Q17/Q19 | R7.AC7 is reworded. R7.AC10 (no demo login, fixtures created by SQL), R7.AC11 (explicit `reviewerId`), R7.AC12. |
| 3 Q14 vs R7.AC7 | RESOLVED | Q14 `:542`. No demo audit rows remain. |
| 4 `:62-64` reset | RESOLVED | R7.AC0 (precondition, exit 2). |
| 5 Restore mechanism | RESOLVED | R6.AC3 (SQL snapshot, captured `updated_at`, GET compare), R7.AC4, C1, R6.AC10. |
| 6 Raw SQL, no ORM | RESOLVED | R6.AC2, R7.AC2b, R9.AC2d. |
| 7 DB guard | RESOLVED, OWNER DECISION Q18 | R10.AC11. Reading `DATABASE_URL` in-process and printing only a boolean is acceptable, because no agent reads `.env`. |
| 8 Scoped counts | RESOLVED | R6.AC4, R7.AC6, R9.AC4, R10.AC10, R10.AC13. |
| 9 Q5 / R9 method | RESOLVED (draft), OWNER DECISION Q5 | R9 "Why the method matters", R9.AC2–AC2d, R9.AC12, and the backup command in Q5 / R9.AC1. Options 1 and 3 are still offered to the owner, but the BRD now says why they fail. That is acceptable. |
| 10 Group D | OWNER DECISION Q20 | R9.AC6 follows Q20. Recommended (a). |
| 11 Notifications in Q13 | RESOLVED | Q13 and group I (`entity_type='task_report'`). |
| 12 Backlog | RESOLVED (handed to the manager) | §7 items 1–2. |

**New points from v2 (non-blocking, to be handled in the phase 5 design):**
- **R11 status order.** The controller checks the query and body before the service runs: a missing `id` gives 400 at `route.ts:58`, and an invalid body gives 400 at `:60`. So a viewer who sends a bad request gets **400, not 403**. R11.AC1 already says "valid body", so it is still correct. The tester should still know this, so that a 400 for a bad body is not filed as a bug. The gate stays in the service, at the start of `updateTaskReportFields`, the same pattern as POST (`:193`). R11.AC2 can be checked with `GET ?id=` (`route.ts:38` → `getTaskReport`, the owner can always read it).
- **Fixture recipients and Q17.** Because of R7.AC10, the fixture vp, manager and product users are themselves `view_all_task_reports` holders. They receive `daily_report_submitted`. `notify_email` and `notify_telegram` default to true (`prisma/schema.prisma:49-50`). So email is also attempted to the stamped `@tcms.test` addresses. Proposal for the design: the fixture `INSERT` sets `notify_email = 0, notify_telegram = 0`. This does not change any asserted status. Q17 still covers the demo recipients.
- **Cosmetic.** The answers table (item 9) cites "R9.AC2a–AC2e", but the BRD defines only AC2a–AC2d. The `crew_desk_links` deletion appears only in the R9.AC2 dry-run list. The design will add it explicitly to the delete step.

## developer-frontend
Verdict: **CHANGES** (R1–R3 can all be built on the frontend without any API change. Before owner approval, R1 needs one missing role combination and an empty-state fix, R2.AC6 needs a testable wording, the "fresh login" convention can be relaxed, and R10.AC4 does not protect the owner's window as worded. Details below.)

All citations were opened in this run. No code was written, nothing was started or stopped on :3000, and no request was sent to the app.

### Feasibility / risks / effort

**Gate mechanism (applies to R1–R3).**
- `can`/`canAny` read the `permissions` array in the Zustand store (`src/store/index.ts:40-42`). The array is filled at login (`:95-100`) and on every full page load: `initialize()` calls `authApi.me()` → `GET /api/auth` (`src/store/index.ts:60-61`, `src/lib/client/api.ts:270`). `AuthGate` renders a spinner and no view until that call has returned (`src/components/providers.tsx:136`, `:140-146`). So **a browser reload (F5) refreshes the permission snapshot**. Client-side navigation does not. developer-backend has confirmed that `GET /api/auth` re-reads the overrides (`permissions.ts:129-142`, section above). Runtime check: NOT VERIFIED. I will confirm it in the tester's pass.
- Because no view mounts before `permissions` is filled, `enabled: can(...)` never fires a request against an empty permission list. That also means no "read-only flash" on /tasks for roles that hold the permission.
- The existing pattern to reuse is `enabled: !!user && can('<key>')` (`reports.tsx:53`, `settings-users.tsx:102`, `settings-permissions.tsx:29`). The page-level gate is `PermissionDenied` after all hooks (`reports.tsx:56-57`, `integrations.tsx:216-225`, `activity-log.tsx:97-98`). For in-component booleans I will use a boolean selector, `useAuthStore((s) => s.can('x'))`, as `dashboard-v2.tsx:136` does. A selector that returns the stable `can` function (`dashboard-v2.tsx:128`) does not re-render when `permissions` changes. That is harmless today (the whole tree remounts on login) but fragile.
- The global retry policy never retries a 403 (`providers.tsx:43-50`), so each gated query that is still sent costs exactly one 403. Gating with `enabled` removes it completely.

**R1 (/tasks): feasible, about 1.5 h.**
- The change is local: `isReadOnly` (`tasks.tsx:182`) becomes `!canCreateReport || (canViewAllReports && effectiveUserId !== user?.userId)`. Every edit control already follows `isReadOnly`: Add task (`:543`, `:562`), Save (`:615`), remove (`:718`), all row inputs (`:711`, `:744`, `:757`, `:783`, `:819`, `:882`), Notes (`:596`). `handleSave` also returns early (`:422`). The UI never calls `PUT` (`api.ts:447` defined, only `upsert` used at `:395`), so R1.AC3 holds with no extra work.
- **Gap 1, a missing role combination.** The R1 table covers only "both permissions" and "neither". When the VP turns `create_task_report` off for a role that keeps `view_all_task_reports` (for example manager), that user picks another user and sees "Switch back to yourself to make edits" (`tasks.tsx:309-315`). That is false, because their own log is read-only too. The BRD must say which notice wins. My proposal: when the user lacks `create_task_report`, show only the Q11 notice (own log) and, for another user's log, the first sentence only ("You are viewing another user's report."). Never show two notices.
- **Gap 2, the empty state is unreachable in read-only mode.** With no saved report, the form starts with one blank row (`tasks.tsx:378-380`). So a viewer sees a disabled empty task card, "Entries 1", and an **enabled** "Export CSV" (`:539` checks `tasks.length === 0`) that downloads a blank row. This contradicts R1.AC4 ("enabled only when the log has entries"). It is also how managers see another user's empty day today. The empty-state text "Add your first entry for {date}" (`:559`) is also wrong for a read-only user. Fix: in read-only mode start from `[]` and show "No tasks logged for {date}." without the "Add your first entry" line. Export CSV stays disabled. This is the same file and the same change.
- Viewer data calls on /tasks are all allowed for any user: `?action=my`, modules tree, test-case and bug lists (`tasks.tsx:112-152`; list endpoint self-scopes, `task-reports.service.ts:93-95`). So R1 adds no 403.

**R2 (dashboard): feasible, about 1.5 h including Q10.**
- Header (`dashboard-v2.tsx:280-292`) and Quick Actions (`:682-687`) are plain JSX. Each gate is a `&&` around the element. The gate map keys match the target pages (`test-cases.tsx:70`, `bugs.tsx:54`, `reviews.tsx:84`, `reports.tsx:56`) and the sidebar (`sidebar.tsx:49`, `:53`).
- Layout: Quick Actions is `grid-cols-2` (`:681`). Viewer gets 2 tiles (one row), developer 3, qa_engineer 4. Nothing collapses. The viewer's header button group (`:279`) becomes empty. In the narrow `flex-col gap-4` layout (`:257`) that adds a blank gap, so I will render the group only when it has at least one button. R2.AC3 is testable as written.
- **Q10: I support "yes".** Same defect class, same file, about 30 minutes. Notes per item:
  - R2.AC6 (KPI card `:357-371`): `KpiCard` always renders a `<button>` with hover lift and chevron (`:917-930`), even though `onClick` is optional (`:904`). I will add a non-interactive variant (a `div` with no hover lift and no chevron) when `onClick` is absent. **"No pointer cursor" is not a valid check.** `KpiCard` never sets `cursor-pointer`, and `globals.css` has no cursor rule (grep: no match). So a Tailwind v4 button already shows the default cursor and the check passes today without any fix.
  - R2.AC7 (`:661-669`): the overflow list mixes reviews and bugs (`:208-238`). For a user without `perform_review` the review query is disabled (`:136-141`), so every overflow item is a bug and the link "view reviews" is wrong anyway. Hiding it is correct. Pointing it to /bugs instead would be a behavior change, so I propose that for the backlog, not REQ-001.
  - R2.AC8 (`:699`): a plain `&&` gate on `view_activity_logs`. The activity list itself is unchanged.
- **New finding (same defect class, outside this BRD; for the backlog, not REQ-001):** other ungated links to /reviews. These are "Back to Reviews" (`review-detail.tsx:106`, `module-review-detail.tsx:133`), the post-verdict navigation (`review-detail.tsx:268`), and the notification/activity mapping `review → navigate('reviews')` (`src/lib/navigation.ts:24-25`). A qa_engineer (submit_review only) who opens a review from a notification and clicks Back lands on PermissionDenied.

**R3 (needless 403s): feasible, about 1 h.**
- /test-cases/[id]: add `&& canViewActivity` to `enabled` (`test-case-detail.tsx:72`) and wrap the Activity card (`:320-346`) in the same condition. The other detail calls (case, history, reviews, modules tree, user options, `:45-88`) are any-user (`test-cases.service.ts:62-72` has no permission check). They stay, so R3.AC1 "no 403 on the page" is reachable.
- /integrations: add `enabled: !!user && can('manage_integrations')` to `:68`, `:69-72` and `:73-77`. `:67` stays. The existing gate at `:216` already sits after all hooks.
- /activity-log: add the same `enabled` to `:88-92` with `view_activity_logs`. `:69-73` stays.
- I grepped every caller of `activityLogsApi.*` and `crewdeskApi.config|list|emailCheck`. These three files are the only ones, so the R3 table is complete.
- **Q12: I support "hide the card"** (not granted → hidden). Small extra for the backlog (not REQ-001): for users who **do** hold the permission, a failed activity load also shows "No activity yet", because `isError` is ignored (`test-case-detail.tsx:69`, `:328`). That is the same false-information problem.

**Q11 (viewer notice text): acceptable, with one wording change.** Render it with the same non-destructive `Alert` as `tasks.tsx:310-314`. Do not use `PermissionDenied`, which is a red "Access restricted" block (`permission-denied.tsx:20-23`), because the page itself is allowed. Proposed text: "Your role can view work logs but cannot log work. A VP can enable "Create task reports" for your role under Permissions." Reason: it names the toggle by its label in the matrix screen (`src/types/index.ts:59`), so the VP knows which cell to change. It still matches the style of `integrations.tsx:223`.

**Hot reload into the owner's running :3000.** This is the main delivery risk, and R10.AC4 does not cover it as written.
- `next dev` recompiles on every **save**, before any `tsc` run. A file that is saved half-edited reaches the owner's browser at once. A syntax or runtime error shows the error overlay. A type error alone does not (SWC strips types). So "tsc passes before the next file is saved" protects the next file, not the current one.
- Fast Refresh **remounts a component and drops its local state when its hook list changes**. R1 adds a hook (`can('create_task_report')`) to `TasksView`. If the owner has unsaved typing in the /tasks work log when `tasks.tsx` is saved, that typing is lost. This is real data loss from the owner's point of view, even though nothing on the server changes.
- My mitigations, to put into R10.AC4:
  1. Each file goes in **one** edit whose saved state is complete and valid. No multi-step partial edits to one file.
  2. Run `npx tsc --noEmit` and `npx eslint <file>` right after each file. Fix forward at once if either fails.
  3. Edit only view files under `src/components/views/`. **Do not touch `src/store/index.ts` or `providers.tsx`**: a store change forces a full reload of every open tab. R1–R3 do not need it.
  4. Before saving `tasks.tsx`, the facilitator tells the owner to save or leave any open /tasks work log.
  5. Route checks are read-only `GET http://localhost:3000/<route>` (expect 200) plus `GET /api` (R10.AC2). The server is never started, stopped or killed.
- `npm run build` (DoD item 3) is Q1. I agree with the BRD recommendation and will report item 3 NOT VERIFIED until Q1 is answered.

**Effort for my role:** about 0.5 day for the phase 5 design (per-page gates, states, AC mapping), about 4 h to build R1–R3 including Q10, and about 1 h for the DoD run and `06-dev-report.md` evidence. No API, store or client-API change is needed (Q15, if accepted, is backend-only).

### Requested changes (with reasons)
1. **R1 table and R1.AC1/AC6:** add the row "holds `view_all_task_reports`, lacks `create_task_report`" (reachable only via an override). Its own log is read-only with the Q11 notice. Another user's log shows "You are viewing another user's report." without "Switch back to yourself to make edits". Only one notice is ever shown. *Reason:* without this row the UI shows false advice (`tasks.tsx:309-315`), and R1.AC7 cannot say what that user should see.
2. **R1.AC1 and R1.AC4:** add "with no saved report for the date, a read-only user sees the empty state 'No tasks logged for {date}.' (no blank task card, no 'Add your first entry' line), and Export CSV is disabled". *Reason:* today the read-only form shows a blank disabled row and an enabled export of an empty row (`tasks.tsx:378-380`, `:539`, `:559`). As written, AC1's "no Add task in the empty state" can never be observed.
3. **R2.AC6:** replace "no pointer cursor" with "the card is not a button: it cannot be reached with Tab, has no hover lift or chevron, and clicking it leaves the URL at /dashboard". *Reason:* buttons already have the default cursor in this app (`KpiCard` sets no cursor, `globals.css` has no cursor rule), so the current check passes without the fix.
4. **Q11:** use the wording above (it names the toggle "Create task reports"), shown as a plain `Alert` and not as `PermissionDenied`. *Reason:* the page is allowed and only the edit is restricted. Naming the toggle tells the VP which matrix cell to change.
5. **Conventions, "After a fresh login":** change it to "after a full browser reload (F5) **or** a fresh login". Keep fresh login as the fallback if the tester's reload check fails. *Reason:* the code reloads permissions from `GET /api/auth` on every full load before any view renders (`src/store/index.ts:44-62`, `providers.tsx:136-146`). This removes the BRD NOT VERIFIED item and saves the tester about 20 logouts. Client-side navigation does **not** refresh, so the criteria must not say "navigate away and back".
6. **R10.AC4:** replace it with the five mitigations above: one complete edit per file, tsc + eslint after each file, views only (no store/providers edits), warn the owner before `tasks.tsx` is saved, read-only route checks. *Reason:* hot reload applies on save, before tsc. Fast Refresh drops unsaved /tasks state when the hook list changes.
7. **Q10:** answer "yes" (R2.AC6–AC8 in scope), with the reworded AC6 from change 3. *Reason:* same defect, same file, about 30 minutes, and AC8 removes a click into PermissionDenied for 3 of 6 roles.
8. **Q12:** answer "hide". *Reason:* matches `CODEBASE-MAP.md:109`, and removes both the 403 and the false "No activity yet".
9. **Backlog (no REQ-001 change), for the manager:**
   - Ungated "Back to Reviews" and notification links to /reviews (`review-detail.tsx:106`, `:268`; `module-review-detail.tsx:133`; `src/lib/navigation.ts:24-25`).
   - The Focus Queue overflow link says "view reviews" even when the overflow is all bugs (`dashboard-v2.tsx:661-669`).
   - The test-case Activity card shows "No activity yet" on a failed load for permitted users (`test-case-detail.tsx:69`, `:328`).
   - `sidebar.tsx:68-71` memoises on the stable `can`/`canAny` references, so it would not react to an in-session permission change (no impact today).

### Re-check (BRD v2)
Verdict: **APPROVE** for the frontend part. Two wording points below are non-blocking: I will pin them in `04-design.md` unless the product-owner changes the BRD first. I re-opened `02-brd.md` v2, the product-owner answers, `tasks.tsx`, `dashboard-v2.tsx:255-295`, `sidebar.tsx:72-88` and `global-search.tsx:145`. No code was changed and nothing was sent to :3000.

| # | Status | Where v2 resolves it |
|---|---|---|
| 1 Holder without create | RESOLVED | R1 table row 4, N3, R1.AC8, "never more than one notice" |
| 2 Read-only empty state, Export CSV | RESOLVED | R1.AC1(b), R1.AC4, R1.AC6, §2 (visible change for vp/manager/product) |
| 3 R2.AC6 testable | RESOLVED | R2.AC6 (a)–(d) plus the positive case |
| 4 Q11 wording, plain Alert | RESOLVED, OWNER DECISION Q11 | N1 in R1, "plain `Alert`, not `PermissionDenied`" |
| 5 Reload or login | RESOLVED | C4 |
| 6 R10.AC4 hot reload | RESOLVED, OWNER DECISION Q21 (owner warning) | R10.AC4 (a)–(e) |
| 7 Q10 | OWNER DECISION Q10 | R2.AC6–AC8 conditional |
| 8 Q12 | OWNER DECISION Q12 | R3.AC3 |
| 9 Backlog items | RESOLVED (handed to the manager) | §7 items 3–6 |

**Consistency with the code (checked):**
- **N1/N2/N3 can be built.** N2 matches the current text exactly (`tasks.tsx:312`; `&apos;` renders U+0027). In JSX, N1's straight quotes must be escaped as `&quot;` because of the `react/no-unescaped-entities` lint rule. That still renders U+0022, so the tester's string compare holds. N3 is the first sentence of N2.
- **The four-row table matches the code.** Rows 1–3 match today's behaviour (`tasks.tsx:182`, `:309-315`). Row 4 needs a separate reason for read-only (no create permission vs another user's log) so that the right notice is picked. This is local to `tasks.tsx`.
- **R2.AC6 DOM checks:**
  - (a) and (b) can be met with a non-button `div` variant of `KpiCard` (`dashboard-v2.tsx:917-930`), which lives in a view file, so R10.AC4(c) holds.
  - (c) holds, because the review queries are disabled without `perform_review` on the dashboard (`:136-141`) and in the sidebar (`sidebar.tsx:76-88`).
- **The R2.AC3 header group** (`:279-293`) contains only the three buttons. For the viewer it is empty, so omitting it is correct.
- **R3.AC1 "no 403 on the page" can be reached.** The layout's only queries are gated (`sidebar.tsx:76-88`). Search and /modules/[id] both open `test-case-detail` (`global-search.tsx:145`, `module-detail.tsx:150`).

**New points from v2 (non-blocking):**
1. **The `{date}` format in R1.AC1(b) is ambiguous.** "Date as shown in the Date field": the native date input shows the browser's locale format, but the code holds `reportDate` as ISO `YYYY-MM-DD` (`tasks.tsx:104`, already used at `:559`). Because the tester compares strings exactly, I will render the ISO value (for example `No tasks logged for 2026-01-01.`) and state that in the design.
2. **"Exactly one notice" vs the load-error alert.** If the log fails to load, the viewer would see N1 and "Could not load the work log" (`tasks.tsx:317-323`) at the same time. In my design, "notice" means N1/N2/N3 only, and the error alert can appear alongside one of them.
3. **A small mismatch.** R1.AC5 lists vp, manager and developer for "no save". The answers table (tester #5) says "vp, manager, qa1 (and developer)". The BRD wins; the tester should use R1.AC5.

## tester
Verdict: **CHANGES**. Most of R1–R3 can be observed per role, but before owner approval six criteria need rewording (R1.AC2, R1.AC4, R2.AC6, R2.AC7, R3.AC7, R10.AC2), the BRD has to list the 7th demo account, two criteria need a tester method (R7.AC5 closed branch and R8.AC5 baseline), and the safety rules for testing on the shared :3000 have to be written into the BRD. Most important: every write the tester makes (task-report saves, permission toggles) lands in `tcms_test` and the tester **cannot remove it through the API**, so R9 has to own it.

All citations were opened in this run. No request was sent to :3000, nothing was started or stopped, no DB query was run. One read-only look at `logs/app-2026-10-15.log` (grep counts only).

### 1. Demo accounts (verified from the seed, not guessed)
`src/app/api/seed/seed.service.ts:56-83` creates **7** accounts. Passwords are in that file and are not repeated here.

| Role | Account | Seed line |
|---|---|---|
| vp | admin@tcms.com (Alice Admin) | `:57` |
| manager | teamlead@tcms.com (Leo Lead) | `:61` |
| product | product@tcms.com (Paula Product) | `:65` |
| developer | developer@tcms.com (Devon Developer) | `:69` |
| qa_engineer | qa1@tcms.com (Quinn Tester) | `:73` |
| qa_engineer | **qa2@tcms.com (Quincy Quality)** | `:77` |
| viewer | viewer@tcms.com (Vera Viewer) | `:81` |

- The BRD convention (`02-brd.md:57`) lists only 6 accounts and takes them from `verify-review-matrix.mjs`. But R7.AC1, R7.AC7 and R9.AC9 say "7 demo users". **Add qa2.** It is the safer qa_engineer account for test writes, because qa1 already holds the QA check's group B report for 2026-10-15.
- The seed is idempotent and runs only when no user exists (`seed.service.ts:47-51`). So the DB rows may have drifted from the seed source. The QA check logged in successfully with the 6 BRD accounts on 2026-10-15 (QA doc line 121). **qa2's login and current password are NOT VERIFIED.**
- Nobody knows whether other active users hold `view_all_task_reports` (for example `self-*@tcms.test`, B8). That matters for who receives the notifications from test saves (§3 below).

### 2. Is each acceptance criterion observable per role? (R1–R10)

**R1 (/tasks):** observable for all 6 roles. Gaps:
- **R1.AC1:** for a viewer with no saved report, today's UI shows one blank disabled row (`tasks.tsx:378-380`). After the frontend's Gap-2 fix it shows an empty state. The AC must state **both** states: no report, and existing report. The Q11 notice must be fixed **character for character**, because I compare exact strings. The frontend proposal nests double quotes around "Create task reports", so the punctuation has to be decided.
- **R1.AC2 cannot be observed under the default matrix as written.** The viewer can never own a report, so "still shows that day's data" can never show data. Fix: chain it after R1.AC7. The viewer (granted) saves on the approved test date. The VP revokes. The viewer reloads and opens that date: the entries are shown, everything is disabled, and there is no Save.
- **R1.AC4:** the button labels are wrong in the AC. The monthly export button is labelled **"Export"** under the label "Monthly report" (`tasks.tsx:279`, `:301`). The day export is "Export CSV" (`:541`). Also, "enabled only when the log has entries" is false today for a read-only empty day (`:539` checks `tasks.length === 0`, and the form starts with one blank row). So I support frontend change 2. Downloads go to a scratchpad folder and are deleted after the check.
- **R1.AC5:** observable. But each save is an upsert that overwrites (`task-reports.service.ts:199-201`). Each save also sends `daily_report_submitted` to **every other active `view_all_task_reports` holder** (`:166-183`) and attempts email and Telegram delivery (`src/lib/server/delivery.ts:146-173`; `notify_email` defaults to true, `prisma/schema.prisma:49`). **Proposed reduction:** an actual save for only 2 roles, one per client code path: product (holder path, `tasks.tsx:127-137`) and developer or qa2 (own-reports path, `:112-116`). For vp, manager and qa_engineer, check that the editor is enabled and Save is visible, with no save. That makes 2 test reports instead of 5 and cuts the notification fan-out by more than half. I put emoji and Hindi text into the single description of those saves to cover encoding without extra rows.
- **R1.AC7:** observable. See the toggle rules in §4.
- **Missing case (supports frontend change 1):** a role that holds `view_all_task_reports` but lacks `create_task_report`. Add it as **R1.AC8**. Method: the VP turns `manager/create_task_report` off, and the manager reloads. Expected:
  - Own log: read-only with the Q11 notice. The user picker is still shown.
  - Another user's log (picked in the picker): "You are viewing another user's report." **without** "Switch back to yourself to make edits."
  - **Never two notices at once.**
  - No `POST /api/task-reports` is sent.
  - The VP restores the cell. All 126 cells are default again.
- **Error case:** "Could not load the work log" (`tasks.tsx:317-323`) can be tested safely. I block `/api/task-reports*` **in the tester's own browser** (DevTools request blocking, or CDP `Network.setBlockedURLs`) and never touch the server. The same method covers the dashboard error state (`dashboard-v2.tsx:156-168`).
- **Double submit:** Save is disabled while the save is pending (`tasks.tsx:616`). A double click must create no second row (the upsert design) and at most one extra notification batch. I will record the count.

**R2 (dashboard):** R2.AC1–AC5 can be observed per role, from the DOM (button present or absent) plus a click. I checked every `navigate(` call in `dashboard-v2.tsx`. The gated targets are only `reviews` (`:370`, `:665`, `:684`), `review-detail` (`:219`, already behind `perform_review` via `:136-140`), `reports` (`:296`, `:687`) and `activity-log` (`:699`). Every other target is any-user (test-cases, bugs, tasks, modules). Activity rows are not clickable (`:957-994`). **The BRD gate list is complete.** Gaps:
- **R2.AC3:** it covers the Quick Actions card only. Add the **header** button group: for the viewer it becomes empty (`:279`), and the frontend plans to omit it. Expected for the viewer: no empty gap at desktop width and at about 400 px.
- **R2.AC4:** "lead to /bugs with a create button". The tester checks that the button is **present** and does **not** submit a bug. Otherwise it creates bug rows that need cleanup. Say so in the AC.
- **R2.AC6:** see §3.
- **R2.AC7 cannot be observed with the current data.** The overflow link renders only when there are more than 8 Focus items (`dashboard-v2.tsx:239`, `:661`). For roles without `perform_review`, the Focus items are only that user's open or in-progress assigned bugs (`:145-152`, `:223-236`). The seed has 3 bugs. To observe it, the tester would have to create 9 or more bugs assigned to the developer. That is more fixture data and more cleanup. **Proposal:**
  - AC7 is verified by code review in the dev report, plus a read-only runtime check only if some role already has more than 8 items.
  - Otherwise it is recorded as NOT VERIFIED at runtime.
  - The owner may approve fixture bugs instead (then they go into the R9 inventory).
- **R2.AC8:** observable for all 6 roles.

**R3 (needless 403s):** R3.AC1–AC6 can be observed per role. The other calls on /test-cases/[id] are any-user: history and reviews take no `me` (`test-cases.service.ts:68-72`). So "no 403 on the page" is reachable. Gaps:
- **Missing paths to the page:** besides "by URL" and "click in /test-cases", R3.AC1 should also cover **reload on the page, browser back/forward, and opening a case from /modules/[id] or Ctrl+K search**.
- **R3.AC6:** needs a case that **has** activity. The test plan names it before the run (a seed case, or a QACHECK case **before** R9).
- **Expired access token:** a 401 followed by a refresh and a retry is normal after 15 minutes (`agent.md:127-129`). R3.AC1 counts only 403s, which is correct. The plan notes this so that a 401 is not filed as a bug.
- **R3.AC7 is not attributable as written.** The WARN line is `"<METHOD> <path> -> 403: <message>"` with **no user id** (`src/lib/api.ts:241`; sample at `logs/app-2026-10-15.log`: `WARN GET /api/users -> 403: Admin only`). The log cannot tell which role caused a 403. The sdet DoD suites deliberately produce 403s on these endpoints, and so would the owner's own browsing. **Reword:** "In a recorded UTC window during which no suite ran and the owner did not use those pages, the log contains 0 lines matching `/api/activity-logs` or `/api/integrations/crewdesk` with `-> 403`." The timestamps are UTC (`Z`), so the window must be recorded in UTC.
- **R3.AC2:** the email-check 502 in R3.AC2 is environment-dependent (QA doc line 63). Keep "200 or the existing 502"; any other status fails the check.

**R4 (docs):** observable by Glob and Grep (R4.AC1, AC2, AC5, AC7) and by reading the files (AC3, AC4). AC6 is a process rule, and I check it with `git log -p` on those files. No gaps.

**R5:** observable from the suite output and by reading the code (AC3). No gaps.

**R6, R7 (sdet suites):** these are not manual tests. Gaps:
- **R7.AC5 closed-signup branch:** it cannot be exercised on this machine without changing `TCMS_ALLOW_SIGNUP`, which is forbidden (`02-brd.md:391`). The open branch is observable. The closed branch can only be verified by reading the code (`src/app/api/auth/auth.service.ts:168-173` returns 403 before any DB write) or by a unit-level check. **The AC should say which evidence is accepted.** Otherwise I must report it NOT VERIFIED.
- **Row counts (R6.AC4, R7.AC6, R9.AC4):** the tester has no DB access (agent file: Bash for app checks and curl only). Name the **sdet script's printed counts** as the evidence. I reconcile them; I do not produce them. I agree with developer-backend change 8 (stamp-scoped counts; global counts only when the window is recorded as exclusive).

**R8:**
- **R8.AC5 cannot be tested after the fact** unless the **pre-fix output is captured first**. Add: "the sdet saves the full pre-fix `node scripts/audit-standards.mjs` output in `05-test-plan.md` (or a file it names) before editing line 89."
- The comparison method: drop the `[naming]` lines from both outputs, sort the rest, diff them, and compare the count in the summary line (`audit-standards.mjs:109`).

**R9:** R9.AC5, AC8 and AC9 can be observed through the UI and API. R9.AC1 (backup) is owner evidence, and R9.AC4 is sdet evidence (see above). Note for R9.AC9: logging in as each demo account **after** the cleanup creates new refresh-token and LOGIN activity rows. Declare these as accepted.

**R10:**
- **R10.AC2:** `GET /api` returns `{ status: 'ok', service: 'tcms-api' }` (`src/app/api/route.ts:8`), not `{ "status": "ok" }` exactly. Reword to "200 and `status` = `ok`". Also, `/api` does not touch the DB. It proves Next is alive, not MySQL.
- **R10.AC1:** checked by reviewing the commands each agent reports.

### 3. The frontend reviewer's requests
- **Reload vs login wording: agree, with an evidence condition.**
  - The code supports it: a full load calls `initialize()` → `authApi.me()` → `GET /api/auth` (`src/store/index.ts:44-62`). Login also sets `permissions` (`:95-100`).
  - Reword the convention to "after a full page load (F5 or entering the URL) **or** a fresh login". **Client-side navigation does not count.**
  - Testability condition: for every toggle test I record which method I used and capture `GET /api/auth` in the network log with the toggled key present or absent.
  - The **first** toggle test (R1.AC7) runs both methods as a cross-check. If they differ, that is a bug, and the remaining ACs fall back to a fresh login.
- **Role combination `view_all_task_reports` without `create_task_report`: agree.** This is the missing role case in R1. My test form is R1.AC8 in §2. Without it, R1.AC7 has no defined expectation for a holder, and the false "Switch back to yourself to make edits" advice would ship untested.
- **R2.AC6 rewording: agree that "no pointer cursor" is not a valid check.** `KpiCard` never sets a cursor (`dashboard-v2.tsx:917-930`), so the check passes today. Two parts of the proposal are still not objective:
  - "No hover lift" is visual.
  - "No chevron" is invisible until hover anyway (the chevron has `opacity-0 … group-hover:opacity-100`, `:930`).

  Proposed checkable wording for users without `perform_review`:
  - (a) The card element is not a `<button>` and has no `role="button"` or `tabindex` (DOM check). Pressing Tab through the KPI row never focuses it.
  - (b) No chevron icon element is rendered inside the card (DOM check).
  - (c) Clicking the card leaves the URL at `/dashboard` and sends no new request to `/api/reviews*`.
  - (d) The number equals the hero chip "pending reviews" (both come from `data.myPendingReviews`, `:274`, `:362`).
  - Positive case for vp, manager and product: the card is still a focusable button and opens `/reviews`.

### 4. Testing safely against the owner's running app on :3000
These are my proposed test conditions. Please add them to the BRD as R10.AC5 to R10.AC8 or as a "Test conditions" section, so that they are approved together with the scope.

1. **Same URL, isolated browser.**
   - I test through `http://localhost:3000`, the URL the owner uses (my lesson file, ws-auth-runtime-1).
   - I use a **separate browser profile** (headless Chrome with its own `--user-data-dir` in the scratchpad, driven over CDP as the QA check did, QA doc line 26) and never the owner's profile. Session cookies are set by the server per host (`src/store/index.ts:94`), so a login in the owner's profile would replace the owner's session.
   - The BRD's "Network panel" definition (`02-brd.md:58`) should also accept "a CDP Network capture from the tester's browser" as equivalent evidence. Whether Chrome is installed now is NOT VERIFIED (it was on 2026-10-15).
2. **No start, stop or kill.** In `next dev`, the first visit to a route compiles it. A slow first load is not a failure, and the plan uses generous timeouts.
3. **No testing during a developer save.** I test only after `06-dev-report.md` says the files are complete. If Fast Refresh reloads a page during a check, that check's evidence is void and the check is repeated.
4. **Login hygiene.**
   - Exact seed credentials only. Five wrong passwords lock that email for 60 s (`agent.md:131-132`). That lock would also hit the owner if the owner uses the same account.
   - Never change a demo user's password or profile. A password change revokes **all** of that user's sessions (`auth.service.ts:256`), including the owner's.
   - Logout revokes only the tester's own token (`auth.service.ts:232-233`), so it is safe.
5. **Read-only first.** R1.AC1–AC4, AC6, R2.AC1–AC3, AC5–AC8 and R3.AC1–AC5 need only logins and GETs. The writes are only:
   - Task-report saves: R1.AC5 (2 saves, as proposed in §2) and R1.AC7 (1 viewer save, reused for R1.AC2 and R1.AC4).
   - Permission toggles: R1.AC7, R1.AC8, R2.AC4, R3.AC6.
6. **Toggle window.**
   - The toggles change the **live** matrix for every account of that role, on the server immediately (`permissions.service.ts:65-66`). That includes qa2 when qa_engineer is toggled, and the owner if the owner is signed in with that role.
   - Rules: (a) all toggles run in one announced, short window; (b) a `GET /api/permissions` snapshot is taken before and after, and all 126 cells must be `source: "default"` at the end; (c) each cell is restored immediately after its check, also when the check fails; (d) toggles are made only through Settings → Permissions as the VP, never by SQL; (e) hygiene is read from `GET /api/permissions`, never from the toggle response (developer-backend: the PUT always says `override`, `permissions.service.ts:85-90`).
   - Each toggle writes an activity_logs audit row (`permissions.service.ts:74-83`). Q5 recommends keeping activity_logs, which is fine.
7. **Notification side effects (needs the owner before any tester write).**
   - Each save notifies every other active holder of `view_all_task_reports` (in-app). It also tries email and Telegram. An email to a real-looking address (`@tcms.com`) cannot be recalled.
   - The log line `Notification delivery attempted … channels: email:<status> telegram:<status>` (`delivery.ts:171-172`) gives indirect evidence without reading `.env`. Today's log shows `email:sent` 0, `email:skipped` 8, `telegram:sent` 0. But `skipped` does not say whether SMTP is unset or the user preference is off.
   - **Owner confirms that SMTP and Telegram are unset (or accepts the messages) before phase 7.** I re-check that `email:sent` stays 0 after every write window and stop if it does not.
8. **No suite during my R1–R3 pass**, because of R3.AC7 (no user id in the 403 lines). The facilitator schedules the sdet DoD runs before or after my window, never during it.
9. **Test date.** I use only the owner-approved date (Q13). The date input has no min or max (`tasks.tsx:253-259`), and the server only checks that the date parses (`task-reports.validation.ts:35-37`), so a past date works. Before the first save I check, as the VP, that no report exists on that date for the accounts I will use (read-only `GET /api/task-reports?userId=…&dateFrom=…&dateTo=…`, `task-reports.service.ts:93-95`). **Never today's date:** that would overwrite qa1's group B row and any real report.

### 5. Tester test data and the R9 cleanup ordering
- **I cannot remove my own rows.** There is no DELETE for task_reports (developer-backend R9 analysis). Notifications can be deleted only by their recipient, and deleting them would be a delete of data under rule 9. So my agent-file promise to "clean up test records you create" cannot be kept for this REQ.
- **Proposal:**
  - (a) Every row the tester creates is recorded by id in `07-test-report.md`: the `taskReportId` from each 200 response, and the date and user. The notifications are found by `entity_type='task_report'` and `entity_id=<taskReportId>` (`task-reports.service.ts:179-180`), so they are identifiable without guessing.
  - (b) Q3/Q13 explicitly add a group **"I. REQ-001 tester rows"**, identified by those ids, to the R9 inventory.
  - (c) The permission toggles leave no `role_permissions` row (default-valued toggles delete the row, `permissions.service.ts:58-60`). Only audit rows remain, and they are kept per Q5.
- **Ordering:**
  - R9.AC10 should read "once, last, after the final DoD run **and after the last tester or sdet write, including phase 9 re-tests**".
  - After R9, any re-test is **read-only** (logins and GETs only).
  - If a post-R9 fix needs a write re-test, a second dry run and owner approval are required. Otherwise new residue stays behind.
  - The R9 verification (R9.AC5, AC9) is itself read-only, and its login rows are accepted (§2, R9).
- **My R9 role** (kickoff assignment): before the delete, I reconcile the dry-run list line by line against QA doc lines 101-114 and my group I ids. Anything in the dry run that is in neither source is flagged to the owner, not silently approved.

### 6. Comments on the other reviews
- I agree with developer-backend changes 2, 7, 8 and 11 because they make R7, R9 and R1.AC5 measurable.
- On change 1 (Q15, R11): if it is accepted, it is testable by curl. With a viewer session, `PUT /api/task-reports?id=<any>` with header `X-Requested-With: tcms` (`src/lib/api.ts:175-176`) must return 403. The 403 must come back **before** the existence lookup, so a non-existent id also returns 403. With the permission, the owner of the report gets 200 (one more write, recorded in group I).
- I agree with frontend changes 1, 2, 5, 6 and 7. For change 3 I propose the stricter wording in §3.

### Requested changes (summary)
1. List the 7th demo account, qa2@tcms.com (qa_engineer, `seed.service.ts:77`), in the convention at `02-brd.md:57`, and use it for qa_engineer writes.
2. R1.AC1: state both states (no report and existing report). Fix the Q11 text character for character.
3. R1.AC2: chain it after the R1.AC7 viewer save (otherwise it cannot be observed).
4. R1.AC4: correct the button labels ("Export" for the monthly report, "Export CSV" for the day).
5. R1.AC5: reduce to 2 real saves (one holder, one non-holder) plus an editable-state check for the other 3 roles.
6. Add R1.AC8 (holds `view_all_task_reports`, lacks `create_task_report`).
7. R2.AC3: also cover the empty header group.
8. R2.AC4: check that the create button is present, without submitting a bug.
9. R2.AC6: DOM-checkable wording as in §3.
10. R2.AC7: code review, plus runtime only if data allows; otherwise NOT VERIFIED or owner-approved fixtures.
11. R3.AC1: add the other paths to the page (reload, back/forward, /modules/[id], search). Name the case for R3.AC6.
12. R3.AC7: an exclusive UTC window, because the 403 log lines carry no user id.
13. R7.AC5: name the accepted evidence for the closed branch.
14. R6, R7 and R9 counts: sdet script output is the evidence.
15. R8.AC5: capture the pre-fix baseline first.
16. R10.AC2: wording `status` = `ok`.
17. Add the test conditions in §4 as approved R10 criteria.
18. Q3/Q13: add group I (tester rows by id). R9.AC10: run after the last write of any agent. Post-R9 re-tests are read-only.
19. The owner confirms SMTP and Telegram are unset (or accepts the messages) before phase 7.

### Re-check (BRD v2)
Verdict: **APPROVE** for the tester part. Every one of my 19 items is resolved in v2 or is now an owner question. The six new points below are wording points. None of them blocks the owner's decision. I will pin each one in `05-test-plan.md`, and the frontend will pin T1 and T2 in `04-design.md`, unless the product-owner changes the BRD first. I re-opened `02-brd.md` v2, the product-owner answers and the backend and frontend re-checks. No request was sent to :3000, and no DB query or test was run.

| # | Status | Where v2 resolves it |
|---|---|---|
| 1 qa2 | RESOLVED | C2 (qa2 is used for every qa_engineer write and toggle). qa2 login is still NOT VERIFIED. I check it first in phase 7. |
| 2 R1.AC1 both states, exact notice | RESOLVED, OWNER DECISION Q11 | R1.AC1(a)/(b), N1–N3 with code points. See T1 and T2. |
| 3 R1.AC2 chained | RESOLVED | R1.AC2 |
| 4 R1.AC4 labels | RESOLVED | R1.AC4 |
| 5 R1.AC5 two saves | RESOLVED | R1.AC5. The BRD list wins over the answers table (vp, manager, developer: no save). |
| 6 R1.AC8 | RESOLVED | R1 table row 4, N3, R1.AC8 |
| 7 R2.AC3 header group | RESOLVED | R2.AC3 (DOM: group not rendered, plus a screenshot at about 400 px) |
| 8 R2.AC4 no bug submitted | RESOLVED | R2.AC4 |
| 9 R2.AC6 DOM wording | RESOLVED, OWNER DECISION Q10 | R2.AC6 (a)–(d) plus the positive case |
| 10 R2.AC7 | RESOLVED, OWNER DECISION Q10 | R2.AC7 evidence rule |
| 11 R3.AC1 paths, R3.AC6 case | RESOLVED | R3.AC1 1–4, R3.AC6 (I name the seed case in `05-test-plan.md`) |
| 12 R3.AC7 window | RESOLVED, OWNER DECISION Q21(2) | R3.AC7, R10.AC10. See T5. |
| 13 R7.AC5 closed branch | RESOLVED | R7.AC5 (code reading accepted) |
| 14 Count evidence | RESOLVED | R10.AC13. See T6. |
| 15 R8.AC5 baseline | RESOLVED | R8.AC5–AC6 |
| 16 R10.AC2 wording | RESOLVED | R10.AC2 |
| 17 Test conditions | RESOLVED, OWNER DECISION Q21 | R10.AC5–AC13 |
| 18 Group I, R9 timing | RESOLVED, OWNER DECISION Q13 (test date) | R9 group I, R9.AC10–AC11, C5 |
| 19 SMTP/Telegram | OWNER DECISION Q17 | Q17, R10.AC12 |

**New testability points from v2 (non-blocking):**
- **T1 R1.AC1(b) `{date}`.** "As shown in the Date field" depends on the browser's locale, so an exact string compare cannot be made. I accept the frontend's choice: ISO `YYYY-MM-DD`, for example `No tasks logged for 2026-01-01.`. The test compares textContent exactly.
- **T2 "Exactly one notice" (R1.AC1, R1.AC8, R1 table).** For testing, "notice" means only N1, N2 or N3. The load-error alert (R1 error cases), toasts and the empty-state text are not counted. So a viewer with `/api/task-reports*` blocked must show N1 **and** "Could not load the work log", and this is a PASS. This matches the frontend re-check, point 2.
- **T3 R1.AC1(a) cannot be observed for the viewer under the default matrix.** The viewer has no saved report until R1.AC7. So (a) is verified through R1.AC2 (viewer) and through R1.AC6 (vp, manager or product viewing another user's saved day). It is not a separate default-matrix check.
- **T4 Write budget (R10.AC8).** The double-click check (R1 error cases) is run **on** qa2's R1.AC5 save, not as a 4th save. The failed write attempts in R11.AC1–AC3 (403, 404, 400, 401) change no row and are not counted as writes. R10.AC12 counts delivery lines up to 60 s after the last write in the window, because delivery is asynchronous.
- **T5 Exclusive window (R3.AC7, R10.AC10).** The owner's "did not use :3000" confirmation must be written after the window ends, in `07-test-report.md` or `03-review.md`. Without it, R3.AC7 is reported **NOT VERIFIED**, not PASS and not FAIL. If the UTC window crosses midnight, both `logs/app-<date>.log` files are searched.
- **T6 Unvalidated zero (R10.AC11, R10.AC13).**
  - A "0 rows" from `check-suite-residue.mjs` proves nothing until the checker has shown a non-zero result on known data. The positive control is the checker on `--pattern` for group A (QACHECK), which must list the known rows **before** R9, and on a stamp while a run is still in progress.
  - The DB guard's abort branch cannot be exercised without a wrong target. The accepted evidence is a code reading plus the guard line printed as the first output line of every run, the same evidence type as R7.AC5.
  - The sdet and I fix both in `05-test-plan.md`.

## sdet
Verdict: **CHANGES**. R5 and R8 can be automated as written, once two additions are made: an exact expected count, and a baseline captured before the fix. R6 and R7 are feasible, but four criteria are wrong or self-contradictory and need fixing first: R6.AC3 state (ii), R6.AC5 / R7.AC8 (how cleanup survives a kill), and R7.AC4 (restore during concurrent use). The suites also have to run strictly one at a time, and the BRD does not say so. Q7 has a realistic answer with no new dependency. R9 is missing one leftover source and has an unsafe existing script next to it.

All citations were opened in this run. I ran no test script, no DB query and no request to :3000. The only commands were `node --version` (v24.22.0) and a file-existence check for the browser binaries (Chrome and Edge are installed). I agree with the tester's §2 R1–R4 observations and do not repeat them.

### 1. R5 `verify-review-matrix.mjs`: feasible, read-only, Windows-safe
- **Expected count = exactly 36.** Each role gets 6 checks: session role `:56`, `action=all` `:60`, two queues `:67-70`, `/reviews` `:76`, `/permissions` `:85`. 6 × 6 = 36. I ask that R5.AC1 say "exactly 36 unless `05-test-plan.md` lists the added checks". Without that, a dropped check can hide behind "above 36 is fine".
- The fix is `:52` and `:74` → `hasPerform` only. The stale comment `:72-73` is updated too. `hasSubmit` stays in the log line (`:53`) for diagnosis. Nothing else changes, so R5.AC4 (no weakening) holds.
- **Windows:** global `fetch` and `getSetCookie` (`:24-35`) work on Node 24. There is no fs, shell or `/tmp` use.
- **Concurrency:** the expectation comes from the login snapshot (`:49-50`). If a matrix-toggling actor runs at the same time, the probe can see a different matrix than the login did, and the check flakes. For example, `verify-permissions.mjs:144`/`:156` toggles `developer/perform_review` for about 3.5 s. Rule: this suite never runs concurrently with any suite or tester window that toggles the matrix (see §6).

### 2. R6 `verify-wiki.mjs`: feasible, with changes to AC3 and AC5
- **Expected count today = 48 `ok()` calls** (grep count). The fixed suite must print `PASS=n FAIL=n`, because today it prints only a verdict (`:274`). R6.AC1 should pin "48 existing checks + the new restore/residue checks listed in `05-test-plan.md`, 0 failed".
- **Structural changes for a guaranteed cleanup** (today everything is top-level `await`, `:29-52`, and cleanup is straight-line code at `:251-271`):
  1. Move everything after the stamp into `main()`. Fixture creation (`:29-31`), every login (`:47-52`) and every section go inside one `try`. `finally` runs the restore and cleanup. `process.exit` is called **only after** `finally`, by setting `process.exitCode`. A `process.exit()` inside the `try` would skip `finally`, and the current scripts end that way (`:275`).
  2. In `finally`, each cleanup step gets its own try/catch and reports per step, so a failed doc delete does not skip the user delete. Order: (a) restore the permission cells, (b) wiki docs by `author_id` of fixture users (RESTRICT FK), (c) activity_logs by fixture `user_id`, before users (SET NULL FK, backend `migration.sql:396`, `:399`), (d) users (refresh_tokens and notifications cascade). Any cleanup error forces a non-zero exit.
  3. **Cleanup by fixture user id, not by title.** Some docs carry no stamp: "no content" `:180`, "bad ext" `:192`, "revoked" `:247` if a check fails. The `:255` search-by-stamp misses them. The `:267` delete-by-author catches them and must stay the authoritative sweep.
  4. **A `finally` does not run on Ctrl+C or a closed console window.** Add a `SIGINT` handler that runs the same cleanup. Print the stamp as the first output line. Add a `--cleanup-stamp=<n>` mode that runs only the cleanup for an earlier killed run. Without this, R6.AC4 cannot hold after a killed run.
  5. Writes use `$executeRaw`. Fixture users are created with a raw `INSERT` (`crypto.randomUUID()`, `UTC_TIMESTAMP(3)`), not `db.user.create` (`:30`). This agrees with backend change 6.
- **The permission grant in §8 should go through the API, not SQL.** The comment at `:229-230` claims the SQL insert is "the same path the settings/permissions UI uses". It is not: SQL skips `invalidatePermissionCache()` and the audit row (`permissions.service.ts:65-83`). Granting with `PUT /api/permissions` as the fixture VP tests the real path, and it is a strengthening, not a weakening. The audit rows it writes belong to the fixture VP, so step (c) removes them.
- **Restore mechanism: SQL snapshot, verify through the API.** I agree with backend change 5. The API cannot recreate a stored row whose value equals the default. Toggling to the default deletes the row (`permissions.service.ts:58-60`), but a stored row shows `source:'override'` even when its value matches the default (`src/lib/permissions.ts:160`). The API also overwrites `updated_by_id`. So:
  - before any write, `SELECT role, action, enabled, updated_by_id, updated_at FROM role_permissions` (full table);
  - in `finally`, restore **only the cells the suite touched** (`developer/create_wiki_doc`, `developer/delete_wiki_doc`) to their snapshot rows (`DELETE`, or `INSERT … ON DUPLICATE KEY UPDATE` with the captured `updated_at`, the MySQL form; R6.AC2 must allow a captured timestamp);
  - sleep at least 3.5 s, because a SQL write does not invalidate the 3 s cache (`permissions.ts:70`, `:113-121`);
  - compare the full `GET /api/permissions` result (126 cells) with a GET snapshot taken before the run. GET force-reloads (`permissions.service.ts:33`), so it is authoritative. **Never read the PUT response**: it always says `source:'override'` (`permissions.service.ts:85-90`, backend point, agreed). No current suite asserts on it (`verify-permission-matrix.mjs:280,285,294,298` and `verify-permissions.mjs:145,157` check only the status), so the backlog fix will break nothing.
  - **Concurrency guard:** if a cell the suite did **not** touch differs between the start and end snapshots, someone else changed the matrix during the run. The suite must then **not** restore that cell, and must report FAIL "matrix changed by another actor". A blind full-table restore would silently undo an owner toggle made through :3000 during the run.
- **R6.AC3 state (ii) contradicts R6.AC1 and R6.AC6.** The only non-default value for `developer/create_wiki_doc` is `enabled=true`, because developer lacks it by default (`permissions.ts:56`). With that override in place, the existing checks "developer create -> 403" (`:70`) and "developer upload -> 403" (`:166`) **must** fail, so "ALL GREEN" cannot happen. Proposed rewording:
  - (i) default state: the run is green and the cells are default afterwards.
  - (ii) non-default state: the suite detects the precondition at start ("these cells are non-default"), creates nothing, exits 2 with `PRECONDITION`, and leaves the cell byte-identical.
  - The restore-after-the-suite's-own-change case is proven by R6.AC5 instead. A forced failure **after** the grant step shows that the two cells return to their pre-run state.
- **R6.AC5 forced-failure method (goes in `05-test-plan.md`):** an environment hook read only by the script, `VERIFY_FAIL_AT=<step>` (`after-fixtures`, `after-grant`, `mid-cleanup-docs`), which throws at that point. No app edit is needed. Evidence comes from a separate read-only residue checker (below) that prints counts scoped to the stamp.

### 3. R7 `verify-permission-matrix.mjs`: feasible as a port. AC4 needs the same restore design, AC9 needs an exact count
- **Expected count today = 165 executed checks:** 2 signup (`:41-42`), 1 fixtures (`:91`), 25 probes × 6 roles = 150 (`:255-266`), 10 in the round-trip (`:276-300`), 2 hygiene (`:308-309`). After the R7.AC3 rework the exact number is fixed in `05-test-plan.md`. I ask that R7.AC9 say "the exact count in the test plan", not "at least 150".
- **`:62-64` unconditional reset: agree with backend change 4. Remove it, do not test around it.** It is replaced by a **precondition**: at start, all 126 cells must be `source:"default"` (GET), because every expectation in `:98-252` assumes the default matrix (R7.AC2). If not, exit 2 `PRECONDITION` before any write. Then R7.AC4 holds by construction on that path. The snapshot/restore in §2 (SQL rows, restore only the touched cells `viewer/create_bug`, `viewer/create_test_case` and `developer/perform_review`, verify with GET, concurrency guard) covers the run itself.
- **The vp "toggle permission" probe (`:199-205`)** restores only if the first PUT returned 2xx, and it never checks the restore's status. A failed restore leaves `viewer/create_bug` on for the rest of the run. Viewer probes then return 200 instead of 403 and fail, and the cell is left behind. The `finally` restore covers the leftover. The probe should also `check()` its restore status. That adds a check; it removes none.
- **Cleanup must be keyed on fixture user ids and collected ids, not on titles.** Probes create rows with **no stamp**: `matrix probe ${role}` (`:105`), `matrix bug ${role}` (`:148`), `matrix wiki ${role}` (`:216`). FK order follows backend's list: cases before the module (`test_cases.module_id` SET NULL), review rows and links, bugs, wiki, task_reports (cascade from users), activity_logs before users, users last. The fixture module is created by the fixture VP and replaces "QA Marathon Alpha" (`:68-70`), so the `edit module` probe (`:141-145`) never touches seed data (R7.AC7). `devOpt` by fullName (`:273`) becomes the fixture developer's id.
- **Notifications to demo users (backend change 2, agreed):**
  - The create-task-report probe (`:164-168`) notifies every active `view_all_task_reports` holder, demo users included.
  - `submit review` with `{}` (`:115`) auto-picks a VP/manager reviewer, possibly the demo admin.
  - Cleanup must delete notifications by `entity_type`/`entity_id` of the run's created entities. The submit probe should pass an explicit fixture `reviewerId`. This changes the target, not the asserted status, so it is not a weakening.
  - **Email and Telegram delivery cannot be undone.** The owner must confirm before the first run.
- **R7.AC5:** the closed-signup branch cannot be exercised here without changing `.env`. Accept code evidence (`auth.service.ts:168-173`, backend confirmed 403 before any write) plus the open branch at runtime. When signup is open, the registered viewer is cleaned up by id like the other fixtures.
- **Runtime:** about 150 probes, plus fixtures created per role for each destructive probe (`:122-162`), plus several 3.5 s sleeps, against `next dev` with first-compile delays. Expect minutes, not seconds. This is one reason it stays out of the DoD (Q16).

### 4. R8 `audit-standards.mjs`: feasible. The baseline must be captured first, on the same tree
- **Fix:** `:89` → `path.basename(file)` (it handles `\` and `/` on Windows). `:91` reports `base`, so R8.AC2 follows.
- **The baseline must be captured before the B12 edit and before any `src/` edit.** Findings carry `:line` (`:37-38`). Once the frontend changes `tasks.tsx`, `dashboard-v2.tsx` and the other views, line numbers shift, and a before/after diff of other rules shows false changes. Protocol for `05-test-plan.md`:
  1. Record `git rev-parse HEAD`, and `git status --porcelain src scripts/audit-standards.mjs` must be empty for src.
  2. Run the unmodified audit and save **stdout and stderr together** plus the exit code. The findings go to **stderr** (`:109-110`), so a plain `>` captures only the summary. Use Git Bash `node scripts/audit-standards.mjs > <file> 2>&1; echo "exit=$?"`. Do **not** use PowerShell 5.1 `2>&1 | Out-File`: it wraps stderr as error records and writes UTF-16 (same trap backend noted for mysqldump).
  3. Apply the one-line fix and run again at once on the same tree.
  4. Compare as the tester proposes: drop `[naming]`, sort, diff (expect empty), and compare the file count in the summary line (R8.AC5).
  5. Save both raw files under `docs/requirements/REQ-001-qa-check-fixes/evidence/`.
- **Self-check on the baseline:** on Windows every path fails `:90-91`, so the baseline `[naming]` count must **equal** the "across N TS files" count. If it does not, the B12 diagnosis is incomplete, and I stop and report it.
- **R8.AC3 method:** move the predicate into one function and add a `--self-test` flag. The flag runs that **same** function on fixed sample names (`BadName.ts`, `bad_name.service.ts` must fail; `test-cases.service.ts`, `page.tsx` must pass) and exits with `PASS=n FAIL=n`. A copy of the regex in a separate test would not prove the script. No file is added under `src/`.
- **New finding, for the backlog, not this REQ:** `VERB` is a `/g` regex (`:56`) used with `.test()` (`:78`). `lastIndex` carries over between route files, so a route file can be scanned from the middle and an unwrapped handler is missed (false negative only). Fixing it would change non-naming results and break R8.AC5, so it waits.

### 5. Q7: automated coverage for UI bugs 1–3
**Realistic: yes, with no new npm dependency and no app restart.** Node 24 has global `WebSocket` and `fetch`, Chrome is installed (`C:\Program Files\Google\Chrome\Application\chrome.exe`), and `package.json` has no puppeteer or playwright. Proposal: `scripts/verify-ui-gates.mjs`, which drives headless Chrome over CDP the way the QA check did (QA doc line 26).
- **Scope (read-only, default matrix only):** R1.AC1/AC3 (DOM: no Add task or Save, inputs disabled, notice text exact; no `POST`/`PUT /api/task-reports` in `Network.requestWillBeSent`), the R2.AC1 button table for 6 roles (present/absent by text, R2.AC6 DOM form), and the R3.AC1 tables (listed URLs never requested, 0 responses with status 403 per page). About 30 page loads.
- **Out of the script:** toggle ACs (R1.AC7, R1.AC8, R2.AC4, R3.AC6) and every write (R1.AC5). They stay in the tester's one toggle window, so only one actor changes the live matrix.
- **Safety rules:**
  - Its own `--user-data-dir` under `os.tmpdir()`, so the owner's profile is never touched.
  - A random `--remote-debugging-port`.
  - In `finally`, kill **only the spawned pid tree** (`taskkill /PID <pid> /T /F`). **Never kill by image name**: that would close the owner's Chrome. Then prove no process with that user-data-dir remains, and delete the dir (lesson ws-reconnect-1).
  - Log in through `POST /api/auth?path=login` with exact credentials, then `Network.setCookie`. The only side effect is login rows, the same as `verify-review-matrix`.
  - Generous first-compile timeouts. A Fast Refresh during a run voids that run; it is re-run, not filed as a bug (lesson mysql-baseline-1).
- **Limits (for NOT VERIFIED):** button text selectors are brittle, layout (R2.AC3) is not asserted, and production mode is not covered. It complements the tester's pass and does not replace it. If the owner rejects a spawned Chrome, fallback: a decision in `decisions.md` that R1–R3 are covered by the tester only, plus a backlog item for a UI test framework.
- It does not join the DoD in REQ-001 (needs Chrome, slow). It is listed in `07-test-report.md` with how to run it.

### 6. Concurrency rules the BRD must state (new, applies to R5–R7, R9 and the tester)
1. **One matrix-touching actor at a time.** These overlap on the same cells and must never run concurrently with each other or with the tester's toggle window:
   - `verify-permissions` (`developer/perform_review`, `:144`, `:156`)
   - fixed `verify-permission-matrix` (the same cell, plus two viewer cells)
   - fixed `verify-wiki` (two developer cells)
   - `verify-review-matrix` (reads)
   - the fixed R6/R7 restore runs.

   The facilitator runs suites serially and announces each window.
2. Global row counts are valid only in a window recorded as exclusive. Evidence is stamp/id-scoped counts (backend change 8, agreed).
3. Suites run only when `06-dev-report.md` says the edits are complete (Fast Refresh, frontend note).
4. Every DB-touching script first asserts `DATABASE() = 'tcms_test'` and the port (backend change 7). **Caveat:** `@@port` is the server's own port. If MySQL runs behind a port mapping (whether it does is UNKNOWN; `docs/LOCAL-SETUP-WINDOWS.md:9` says only "127.0.0.1:5500"), it reports the inner port and the guard aborts. That fails safe, but the owner should say whether the script may also compare host:port parsed from `DATABASE_URL` in-process, printing only a boolean.

### 7. Q13, Q14, Q16
- **Q13:** agree with the tester. One owner-approved past date, 2 real saves, and the ids recorded as group I. The DoD suites never write task_reports (I checked `verify-import`, `verify-permissions` and `verify-notifications`), so group I is tester-only. Fixed R7 writes task reports only for fixture users (cascade on user delete). Their report-holder notifications are deleted by `entity_id`.
- **Q14:** agree with the recommended answer plus backend change 3. With no demo login in R6/R7, every activity_logs row the run caused belongs to a fixture user and is deleted before the users. Notifications are deleted by fixture `user_id` **and** by `entity_type`/`entity_id` of the run's entities (this covers demo recipients). The residue checker proves 0 for both.
- **Q16:** agree, not in REQ-001. Promotion criteria for the retro: two owner-approved runs of each (one green, one forced-failure with residue 0 and matrix identical), the serial-run rule written into `agent.md` §3, and owner sign-off on the notification side effect. `verify-review-matrix` is already item 7. After R5, its wording should pin "36 passed, 0 failed" (part of R4.AC3).

### 8. R9 cleanup: ordering and what the suites keep adding
- **Missing from the inventory:** every `verify-notifications` run creates a **bug** "Verify notification <stamp>" in the first module of the tree, assigned to the temp user, plus its notification (`verify-notifications.mjs:171-189`). Group E lists only the user. That bug's `assigned_to`/`reported_by` FKs also block any later hard delete of the user. Add group **E2**.
- **Unsafe existing script:** `scripts/cleanup-import-demo.mjs:5-14` deletes **every** `Imported: %` case and their `activity_logs`. It has no dry run, no port/DB guard and no approved-id list, so it contradicts Q5 ("keep activity_logs") and rule 9. It must not be run or reused for R9. Also, `scripts/check-overrides.mjs:4` selects a `source` column that `role_permissions` does not have (`prisma/schema.prisma:124-133`). It would error and must not be used as matrix evidence. Both go to the backlog.
- **Every DoD run re-creates groups C, D and E/E2** (`verify-import.mjs:83`, `verify-permissions.mjs:55-64`, `verify-notifications.mjs:74`, `:185`). After R9 deletes the QACHECK bugs, `verify-permissions` changes the status and assignee of whichever bug is now first (`:107-122`), likely a **seed** bug. So:
  - R9.AC10 must say R9 runs after the last DoD run of phase 9 **and** of the phase 10 release review.
  - Any DoD run after R9 needs a second dry run, or the owner explicitly accepts the new rows. This extends tester change 18.
- `verify-permissions` raises a new module review on the same first submodule every run (`:54`, `:63`). Whether a second submit while one is open still returns 200 is UNKNOWN. If not, a DoD run fails for a harness reason (not filed as a product bug), and R9 deleting that review changes the outcome of the next run.
- Killed R6/R7 runs leave stamped residue. The R9 dry run should also list `wiki-%-%@tcms.test` and the R7 fixture email pattern as group **J (killed suite runs)**, flagged separately.
- **The residue checker is shared evidence:** one read-only `scripts/check-suite-residue.mjs --stamp=<n>|--pattern=<group>` prints per-table counts and PKs. R6.AC4, R7.AC6 and the R9 dry run all use it, so the tester reconciles against one tool (tester change 14).
- R9 script requirements: as backend change 9, plus `PASS`/`FAIL` per table re-count and a non-zero exit on any mismatch.

### Requested changes (summary)
1. R5.AC1: exactly 36, unless added checks are listed in the test plan.
2. R6.AC1: print raw `PASS=n FAIL=n` (48 existing checks + new ones).
3. R6.AC3 (ii): replace with "precondition detected → no writes, exit 2, cell unchanged". The restore of the suite's own change is proven via R6.AC5 `after-grant`.
4. R6.AC5 / R7.AC8: cleanup survives a thrown error **and** Ctrl+C (SIGINT handler, stamp printed first, `--cleanup-stamp` mode). Forced failure uses the `VERIFY_FAIL_AT` env hook.
5. R6 §8 grant through `PUT /api/permissions`, not SQL. The restore is a SQL snapshot of only the touched cells, then a ≥3.5 s wait, then a 126-cell GET comparison, with a concurrency guard. Never assert on the PUT response.
6. R7: a precondition "all 126 default" replaces `:62-64`. R7.AC9 uses the exact count. The toggle-probe restore is checked. Cleanup is by fixture ids. The submit probe gets an explicit fixture reviewer.
7. R8: baseline protocol (same tree, both streams, exit code, naming count = file count), saved under `evidence/` before any src or audit edit. `--self-test` for R8.AC3.
8. A new "Test execution rules" block: serial runs, one matrix actor, no suite during the tester window, DB guard with the `@@port` caveat.
9. Q7: approve `scripts/verify-ui-gates.mjs` (CDP, no new dependency, read-only, own profile, pid-tree kill only).
10. R9: add groups E2 and J, extend R9.AC10 to after the phase 10 runs, forbid `cleanup-import-demo.mjs`, and use one shared residue checker.
11. Backlog: audit `VERB` `/g` `lastIndex` false negatives; `check-overrides.mjs` non-existent `source` column; `cleanup-import-demo.mjs` lacks dry-run and guard; the weak wiki check `:211` (tautological, `bySearch.data && byContent.data !== undefined`) to be strengthened later. None of these block REQ-001.

### Re-check (BRD v2)
Verdict: **APPROVE** for the sdet part. All 11 items are resolved or now owner questions. The new points S1–S7 below are wording or design points that v2 introduced. I will pin each one in `05-test-plan.md` unless the product-owner rewords the BRD first. None needs an owner decision. I re-opened `02-brd.md` v2 and the four re-checks, and grepped `verify-wiki.mjs`. No script, DB query or :3000 request was run.

| # | Status | Where v2 resolves it |
|---|---|---|
| 1 R5 exactly 36 | RESOLVED | R5.AC1, R5.AC4, R4.AC3 |
| 2 R6 `PASS=n FAIL=n` | RESOLVED | R6.AC1. **Correction accepted:** there are 47 `ok(` call sites (`:18` is the definition), and none is inside a loop (the only loops are at `:29` and `:257`). So the executed count today is 47 when all sections run. |
| 3 R6.AC3 (ii) | RESOLVED | R6.AC3 (ii), exit 2. The suite's own restore is proven by R6.AC5 `after-grant` |
| 4 Throw, Ctrl+C, recovery | RESOLVED | R6.AC5, R6.AC9, R7.AC8. See S2–S4 |
| 5 Grant via API, SQL restore, GET compare, guard | RESOLVED | R6.AC8, R6.AC3, R6.AC10, C1 |
| 6 R7 precondition, count, restore check, ids, reviewer | RESOLVED | R7.AC0, AC9, AC13, AC6, AC11. See S1 |
| 7 R8 baseline, `--self-test` | RESOLVED | R8.AC3, AC5, AC6. See S5 |
| 8 Test execution rules | RESOLVED, OWNER DECISION Q18 | R10.AC10, R10.AC11. See S6 |
| 9 `verify-ui-gates.mjs` | OWNER DECISION Q7 | Q7, R10.AC1 (Chrome pid-tree exception) |
| 10 R9 E2, J, timing, forbidden scripts, residue checker | RESOLVED | R9 inventory, R9.AC10, R9.AC12, R10.AC13. See S7 |
| 11 Backlog | RESOLVED (handed to the manager) | §7 items 7–11 |

**New automation and cleanup points from v2 (non-blocking):**
- **S1 Exit-2 precondition (R6.AC3 (ii), R7.AC0).**
  - R7.AC0 says "read `GET /api/permissions`" **and** "make no write". But R7.AC10 forbids demo logins, so a GET first needs a fixture VP, and creating one is a write.
  - Pin: the precondition is read **by SQL before any fixture exists**. For R7 that is `SELECT COUNT(*) FROM role_permissions` = 0. This is equivalent to C1, because any stored row reads `source:'override'` (`permissions.ts:160`). For R6 it is the two developer rows. The 126-cell GET snapshot is taken after the fixtures exist and before the first permission write.
  - An exit-2 run prints `PRECONDITION: …` and **no** `PASS=` line. Reports record it as NOT RUN, never as PASS or FAIL.
- **S2 SQL snapshot restore.**
  - Under the precondition, the restore for each touched cell is "no row" (DELETE). The `INSERT … ON DUPLICATE KEY UPDATE` path with captured values is needed only if a later REQ relaxes the precondition.
  - Before the restore, the suite also checks each touched cell's row against the state the suite itself last wrote (`updated_by_id` = fixture VP). If another actor changed that cell, the suite does not restore it and reports `matrix changed by another actor`. The guard in R6.AC10 covers only the untouched cells.
  - The ≥3.5 s wait comes after the SQL restore. It is for the app's in-process `can()` cache, not for GET, because GET force-reloads.
- **S3 `--cleanup-stamp`.**
  - Recovery has no in-memory snapshot. It selects fixture users by the exact email `<prefix>-<role>-<stamp>@tcms.test`, with no broader LIKE.
  - It deletes a `role_permissions` row only if `updated_by_id` is one of that stamp's fixture ids. Any other row is reported and left alone.
  - It passes the DB guard, refuses to run while another run holds the lock (S6), and does not run the in-run checks `:261`/`:263`.
- **S4 `VERIFY_FAIL_AT` and Ctrl+C.**
  - An unknown hook value exits 2, so a typo cannot produce a green run.
  - `mid-cleanup-docs` contradicts "R6.AC4 still holds". If the doc delete fails, the user delete hits the RESTRICT FK (`migration.sql:399`), so residue is non-zero by design. Pin: for that step, the expected result is a non-zero exit with the residue listed, then `--cleanup-stamp` brings the residue to 0.
  - `:261` asserts that more than 0 docs remain, so it fails on `after-fixtures`. That is expected under a forced failure.
  - Ctrl+C evidence is taken from a PowerShell or cmd console. Under Git Bash/mintty, node may be hard-killed without SIGINT, and that case is covered by S3.
- **S5 R8 `--self-test`.** The R8.AC3 samples are bare names, so they also pass with the **unfixed** `split('/')`. The self-test must also feed full paths with both separators, for example `src\components\views\BadName.tsx` (fail) and `src\app\api\test-cases\test-cases.service.ts` (pass). Otherwise it does not prove B12. Adding samples does not weaken anything: the R8.AC3 list is the minimum.
- **S6 Serial rule (R10.AC10).**
  - The rule is procedural only. The R9 dry run and delete and `check-suite-residue.mjs` are missing from the list. A dry run during a live suite would list in-flight fixtures as group J.
  - Proposal for the design: every listed script takes a MySQL `GET_LOCK('tcms_verify', 0)` session lock after the DB guard and exits 2 if the lock is held. The lock writes no row and is released when the process is killed. The tester's browser window cannot take the lock, so for that window the rule stays procedural.
- **S7 R9 after phase 10 (R9.AC10).**
  - Phase 8 UAT marks every AC PASS (WORKFLOW.md:58), but R9 cannot run until after the phase 10 DoD. Pin: R9 runs inside phase 10, after the final DoD run and **before** the owner says "RELEASE".
  - UAT records R9 as "deferred to phase 10". The release review evidence includes the R9 dry run, the approval, the residue output and the read-only R9.AC5/AC9 checks.
  - R11.AC4 adds 2 checks to `verify-permissions.mjs`. DoD item 5 (`agent.md:206`) says only "0 failed", so no pinned count changes.

## product-owner (answers)

Run date 2026-10-15. Before answering, I reopened the source behind every load-bearing claim. Claims confirmed in this run:

| Claim | Source opened | Result |
|---|---|---|
| PUT task-report has no permission check; POST has one | `task-reports.service.ts:193`, `:252-262` | confirmed. PUT also sends **no** notification (`:258-288`) |
| Report-holder fan-out to every active `view_all_task_reports` holder | `task-reports.service.ts:158-183` | confirmed |
| 7th demo account qa2 | `seed.service.ts:76-79` | confirmed (login NOT VERIFIED) |
| A full page load refreshes permissions via `GET /api/auth` | `src/store/index.ts:44-62` | confirmed (code only; runtime cross-check in R1.AC7) |
| `GET /api` body | `src/app/api/route.ts:8` `{ status: 'ok', service: 'tcms-api' }` | confirmed |
| Closed signup → 403 before any DB write | `auth.service.ts:167-173` | confirmed |
| tasks.tsx labels, blank first row, Export CSV gate, notice text | `tasks.tsx:279`, `:301`, `:309-315`, `:378-380`, `:539-541`, `:559` | confirmed |
| KpiCard is always a `<button>`; chevron hidden until hover | `dashboard-v2.tsx:917-930` | confirmed |
| Focus overflow only above 8 items | `dashboard-v2.tsx:239`, `:667` | confirmed |
| Toggle response always says `source: 'override'`; toggling to the default deletes the row | `permissions.service.ts:53-60`, `:85-90` | confirmed |
| `role_permissions` has no `source` column; `updated_by_id` has no FK | `prisma/schema.prisma:124-133` | confirmed |
| Users are soft-delete only | `users.repository.ts:102-107` | confirmed |
| Search does not filter `deprecated` | `search.repository.ts:40-71` (LIKE only) | confirmed |
| `test_cases.module_id` / `bugs.module_id` SET NULL; activity_logs.user_id SET NULL | `migration.sql:330`, `:381`, `:396` | confirmed |
| DELETE handlers exist only in bugs, modules, notifications, test-cases, users, wiki | grep `export … DELETE` in `src/app/api` | confirmed (6 files) |
| 403 WARN line has no user id | `src/lib/api.ts:241` | confirmed |
| Email/Telegram attempted per recipient preference | `src/lib/server/delivery.ts:146-173` | confirmed |
| verify-review-matrix = 6 checks × 6 accounts | `verify-review-matrix.mjs:46-90` | confirmed, 36 |
| verify-permission-matrix executed checks | `verify-permission-matrix.mjs:41-42, 91, 255-266, 276-300, 308-309` | confirmed, 2+1+150+10+2 = **165** |
| verify-permission-matrix start-up reset | `verify-permission-matrix.mjs:61-66` | confirmed (unconditional PUT to default) |
| verify-notifications creates a bug each run | `verify-notifications.mjs:171-189` | confirmed |
| `cleanup-import-demo.mjs` deletes all `Imported: %` + their activity_logs, no dry run, no guard | `scripts/cleanup-import-demo.mjs:5-14` | confirmed |
| `check-overrides.mjs` selects a non-existent `source` column | `scripts/check-overrides.mjs:4` vs `schema.prisma:124-133` | confirmed |
| WORKFLOW severity "permission wrong" = S2 | `docs/process/WORKFLOW.md:97` | confirmed |
| verify-wiki "48 ok() calls" | grep: 48 lines contain `ok(`, **one is the definition** (`verify-wiki.mjs:18`) | **partly**: 47 call sites. The sdet fixes the executed count in `05-test-plan.md` (R6.AC1 updated) |
| **New (mine):** `docs/04-api-reference.md:216` says the entity activity feed is "any authenticated"; the server requires `view_activity_logs` (`activity-logs.service.ts:31`) | both opened | doc drift → Q22 |

### Answers to developer-backend
| # | Request | Answer | What changed in `02-brd.md` v2 |
|---|---|---|---|
| 1 | Q15 → S2, add R11, correct "no API change" | **ACCEPTED (draft) + OWNER DECISION Q15.** The facts are right, and WORKFLOW.md:97 makes it S2. Adding a server change is a scope change, so the owner decides. My recommendation is now **include**. | New **R11** (AC1–AC6), marked "in scope only if Q15 = yes". Header, §5 and §7 corrected: the backend gates are correct for R1–R3, and one gap (R11) exists. If the owner says backlog, §7 records that the owner accepts a known S2 gap for this release. |
| 2 | R7.AC7 reword; fixture users by SQL; explicit reviewerId; email/Telegram precondition | **ACCEPTED** | R7.AC7 rewritten. New R7.AC10 (no demo login; fixture users created by SQL) and R7.AC11 (explicit fixture `reviewerId`). New precondition R7.AC12 → **Q17** (SMTP/Telegram) and **Q19** (transient in-app notifications to demo holders). |
| 3 | Q14 vs R7.AC7 consistency | **ACCEPTED** | Q14 recommendation no longer keeps "VP setup account activity_logs" (no demo login is used any more). All activity_logs authored by fixture users are deleted before the users. |
| 4 | Remove the `:62-64` unconditional reset | **ACCEPTED** (merged with sdet #6) | New R7.AC0: precondition "all 126 cells default", otherwise exit 2 `PRECONDITION` with no writes. The unconditional reset is removed. |
| 5 | Restore by SQL snapshot; captured `updated_at` allowed; verify via GET only | **ACCEPTED** | R6.AC3 and R7.AC4: the touched cells are restored to their exact pre-run row (`enabled`, `updated_by_id`, `updated_at`, or no row). Verified by a 126-cell `GET /api/permissions` comparison, never the PUT response. R6.AC2 allows writing back a captured timestamp. |
| 6 | No ORM model calls; `$executeRaw` for writes | **ACCEPTED** | R6.AC2, also applied to R7.AC2b and R9. |
| 7 | DB guard `SELECT @@port, DATABASE()` | **ACCEPTED**, with the sdet's port-mapping caveat | New R10.AC11 (applies to every DB-touching script). New **Q18** (whether a boolean-only in-process check of the `DATABASE_URL` host:port may be added). |
| 8 | Stamp/ID-scoped counts; global counts only in an exclusive window | **ACCEPTED** | R6.AC4, R7.AC6, R9.AC4 reworded. Evidence = the shared residue checker's output (R10.AC13). |
| 9 | Q5/R9: options 1 and 3 cannot meet the criteria; fix to option 2 with PK list + re-count; backup command; cases before module | **ACCEPTED as the recommendation.** The method stays an owner decision (Q5), but the BRD now states, with citations, that options 1 and 3 cannot meet R9.AC5/AC6. | R9.AC2a–AC2e (guard, PK list input, re-count in one transaction with rollback on mismatch, cases before module, `crew_desk_links` by module id, notifications by entity). Q5 rewritten with the Windows `mysqldump` command shape and evidence. |
| 10 | Group D alternative: keep the module review | **ACCEPTED** → **OWNER DECISION Q20** | Q20 offers (a) keep the verify-permissions module review(s) and seed case statuses and delete only "Perm-verify case …" rows (**recommended**), or (b) roll back, with the dry run printing evidence and the owner approving a status-only UPDATE with no version bump. R9.AC6 follows Q20. |
| 11 | Q13: add the `daily_report_submitted` notifications | **ACCEPTED** | Q13 and group I include them (found by `entity_type='task_report'`, `entity_id`). |
| 12 | Backlog: toggle response `source`; full agent.md:138-139 error list | **ACCEPTED for the backlog.** My agent file does not allow me to edit `backlog.md`, so they are listed for the manager below. | §7 out-of-scope list. |

### Answers to developer-frontend
| # | Request | Answer | What changed |
|---|---|---|---|
| 1 | Role row "holds `view_all_task_reports`, lacks `create_task_report`" | **ACCEPTED** | R1 table row added. New **R1.AC8**. Only one notice is ever shown. |
| 2 | Read-only empty state, Export CSV disabled | **ACCEPTED** | R1.AC1(b) and R1.AC4. Applies to every read-only view, so a manager viewing another user's empty day also sees "No tasks logged for {date}." (a visible change for vp/manager/product, stated in §2). |
| 3 | R2.AC6 testable wording | **ACCEPTED in the tester's stricter DOM form** (tester §3) | R2.AC6 (a)–(d) plus the positive case. |
| 4 | Q11 wording, plain Alert | **ACCEPTED as the recommended answer**; the owner confirms in **Q11** | Exact string fixed in R1.AC1, with straight ASCII double quotes (U+0022). |
| 5 | "Full reload or fresh login" | **ACCEPTED**, with the tester's evidence condition | Convention C4 rewritten. Client-side navigation does not count. R1.AC7 runs both methods once as a cross-check. |
| 6 | R10.AC4 five mitigations | **ACCEPTED** | R10.AC4 replaced (a)–(e). The owner is warned before `tasks.tsx` is saved (Q21). |
| 7 | Q10 = yes | **OWNER DECISION Q10** (recommendation unchanged: yes) | R2.AC6 reworded. |
| 8 | Q12 = hide | **OWNER DECISION Q12** (recommendation unchanged: hide) | — |
| 9 | Backlog items (Back-to-Reviews links, overflow label, Activity card on error, sidebar memo) | **ACCEPTED for the backlog**, listed for the manager | §7. |

### Answers to tester
| # | Request | Answer | What changed |
|---|---|---|---|
| 1 | Add qa2, use it for qa_engineer writes | **ACCEPTED** (`seed.service.ts:77`) | Convention C2 lists 7 accounts. qa2 is used for R1.AC5 and R1.AC7. qa2 login NOT VERIFIED. |
| 2 | R1.AC1 both states; exact notice | **ACCEPTED** | R1.AC1 (a) existing report, (b) no report. Exact strings given. |
| 3 | R1.AC2 chained after the R1.AC7 viewer save | **ACCEPTED** | R1.AC2 rewritten. |
| 4 | R1.AC4 labels | **ACCEPTED** (`tasks.tsx:279`, `:301`, `:541`) | "Export" (under "Monthly report") and "Export CSV". |
| 5 | R1.AC5: 2 real saves + editable-state check for 3 roles | **ACCEPTED** | Saves: product (holder path) and qa2 (own-reports path). vp, manager, qa1 (and developer): editor enabled and Save visible, no save. |
| 6 | R1.AC8 | **ACCEPTED** | As frontend #1. |
| 7 | R2.AC3 header group | **ACCEPTED** | R2.AC3. |
| 8 | R2.AC4 no bug submitted | **ACCEPTED** | R2.AC4. |
| 9 | R2.AC6 DOM wording | **ACCEPTED** | R2.AC6. |
| 10 | R2.AC7 code review; runtime only if data allows | **ACCEPTED.** No extra fixture bugs; I do not want more test data | R2.AC7 evidence rule. |
| 11 | R3.AC1 more paths; name the R3.AC6 case | **ACCEPTED** | R3.AC1 lists 5 paths. R3.AC6: a **seed** case with activity, named in `05-test-plan.md`. |
| 12 | R3.AC7 exclusive UTC window | **ACCEPTED** (`api.ts:241`) | R3.AC7 rewritten. |
| 13 | R7.AC5 closed-branch evidence | **ACCEPTED** | Code reading of `auth.service.ts:167-173` is the accepted evidence. The open branch is checked at runtime. |
| 14 | Suite/script printed counts are the evidence | **ACCEPTED** | R10.AC13. |
| 15 | R8.AC5 pre-fix baseline | **ACCEPTED** (merged with sdet #7) | R8.AC5–AC6. |
| 16 | R10.AC2 wording | **ACCEPTED** | "200 and `status` = `ok`". It proves Next is alive, not MySQL. |
| 17 | Test conditions as approved criteria | **ACCEPTED** | R10.AC5–AC13. |
| 18 | Group I; R9 after the last write; post-R9 re-tests read-only | **ACCEPTED** (extended by sdet #10) | Group I in the R9 inventory. R9.AC10–AC11. |
| 19 | Owner confirms SMTP/Telegram before phase 7 | **OWNER DECISION Q17** | Q17 added; R10.AC12 stop rule. |
| — | (§2) R9.AC9 login rows accepted | **ACCEPTED** | R9.AC9. |

### Answers to sdet
| # | Request | Answer | What changed |
|---|---|---|---|
| 1 | R5 exactly 36 | **ACCEPTED** (verified 6 × 6) | R5.AC1, R5.AC4. R4.AC3 pins "36 passed, 0 failed". |
| 2 | R6 print `PASS=n FAIL=n` | **ACCEPTED.** Correction: 48 lines contain `ok(`, one is the definition (`:18`) | R6.AC1: the exact executed count is fixed in `05-test-plan.md` by code reading before the edit, and printed by the suite. |
| 3 | R6.AC3 (ii) → precondition, exit 2 | **ACCEPTED.** Developer lacks `create_wiki_doc` by default, so a non-default state makes `:70`/`:166` fail by design | R6.AC3 rewritten. The restore of the suite's own change is proven by R6.AC5 `after-grant`. |
| 4 | Cleanup survives throw and Ctrl+C; `--cleanup-stamp`; `VERIFY_FAIL_AT` | **ACCEPTED** | R6.AC5, R7.AC8, and new R6.AC9 (stamp printed first, recovery mode). A closed console or hard kill is covered by recovery mode and R9 group J. |
| 5 | R6 grant through `PUT /api/permissions`; SQL snapshot restore; ≥3.5 s; GET compare; concurrency guard | **ACCEPTED** | R6.AC8 (grant via API, a strengthening), R6.AC3, R6.AC10 (concurrency guard: FAIL "matrix changed by another actor", untouched cells never restored). |
| 6 | R7: precondition; exact count; toggle-probe restore checked; cleanup by ids; explicit reviewer | **ACCEPTED** | R7.AC0, AC9 (exact count, today 165), AC13 (restore checked), AC6 (by ids), AC11. |
| 7 | R8 baseline protocol; `--self-test` | **ACCEPTED** | R8.AC3, AC5, AC6. |
| 8 | Test execution rules block | **ACCEPTED** | R10.AC10 (serial, one matrix actor), R10.AC11 (DB guard), plus Q18 for the `@@port` caveat. |
| 9 | Approve `scripts/verify-ui-gates.mjs` | **OWNER DECISION Q7 (updated)**. Recommended: approve, with the safety rules | Q7 rewritten. R10.AC1 now allows killing only the pid tree of a Chrome the script itself spawned. |
| 10 | R9: groups E2, J; after phase 10; forbid `cleanup-import-demo.mjs`; one residue checker | **ACCEPTED** | Inventory E2, I, J. R9.AC10. R9.AC12 (forbidden scripts). R10.AC13 (shared residue checker). |
| 11 | Backlog items | **ACCEPTED for the backlog**, listed for the manager | §7. |

### Items for the manager to add to `docs/process/backlog.md` (I am not allowed to edit it)
1. Toggle response `PUT /api/permissions` always returns `source: 'override'`, even after deleting the row (`permissions.service.ts:85-90`).
2. agent.md §2 delete-semantics errors, full list (backend Q6 analysis): cases are hard-deleted with cascading children, module delete orphans cases/bugs (SET NULL), wiki docs are hard-deleted, `delete_bug` is held by manager too.
3. Ungated links to /reviews: `review-detail.tsx:106`, `:268`; `module-review-detail.tsx:133`; `src/lib/navigation.ts:24-25`.
4. Focus Queue overflow says "view reviews" when the overflow is all bugs (`dashboard-v2.tsx:661-669`).
5. Test-case Activity card shows "No activity yet" on a failed load (`test-case-detail.tsx:69`, `:328`).
6. `sidebar.tsx:68-71` memoises on stable `can`/`canAny` references.
7. `audit-standards.mjs:56`/`:78` global regex `lastIndex` false negatives.
8. `scripts/check-overrides.mjs:4` selects a non-existent `source` column.
9. `scripts/cleanup-import-demo.mjs` has no dry run, no DB guard and deletes activity_logs.
10. `verify-wiki.mjs:211` tautological check, to be strengthened.
11. Add to B16: `verify-permissions.mjs:107-122` changes status and assignee of the first existing bug; it raises a new module review on the first submodule every run (`:54`, `:63`); `verify-notifications.mjs:171-189` creates a bug every run.
12. If the owner answers Q15 "backlog": the S2 PUT task-report gap, with the owner's acceptance recorded.
13. If the owner answers Q22 "no": `docs/04-api-reference.md:216` drift.

### Still open for the owner
Q1–Q22 in `02-brd.md` §8 (Q17–Q22 are new from this review). R9 stays **BLOCKED** until Q3, Q4, Q5, Q6 and Q20 are answered and the dry-run list is approved. R4 stays blocked for editing until Q2.

## manager — decisions

Run 2026-10-15. Re-read in this run: `01-kickoff.md`, `02-brd.md` v2 (all of it, including the changelog), this file (all four reviews, the product-owner answers, all four re-checks), `docs/process/WORKFLOW.md`, `docs/process/decisions.md`, `docs/process/backlog.md`, `docs/process/lessons/manager.md`, `agent.md:120-263`, `CODEBASE-MAP.md:60-134`, and the last 3 `worklog.md` entries. I did not open any app code, run any DB query or send anything to :3000. Code citations below are the reviewers' citations, as confirmed by the product-owner (`03-review.md:588-617`). I did not re-open the code for them.

Verdicts: developer-backend, developer-frontend, tester and sdet all voted **CHANGES** in round 1 and **APPROVE** on BRD v2. product-owner wrote the BRD and answered every item. Every CHANGES item below is now resolved in BRD v2, assigned to a named phase 5 owner, put to the owner as a question, or moved to the backlog.

Decision keys: **ACCEPTED-v2** = fixed in `02-brd.md` v2 (where). **CARRIED-P5 (role, file)** = a design or test-plan detail that the named role pins in phase 5. **OWNER Qn / An** = the owner decides (see the list below). **BACKLOG Bn** = added to `docs/process/backlog.md` in this run.

### developer-backend (round 1: 12 items, re-check: 4 notes)
| # | Raised by | Request | Decision | Reason |
|---|---|---|---|---|
| BE1 | developer-backend | Q15: reclassify the PUT task-report gap as S2, add R11, correct "no API change" | ACCEPTED-v2 (R11.AC1–AC6, header `02-brd.md:9`, §5, §7) + **OWNER Q15** | The product-owner confirmed the facts (`task-reports.service.ts:193` vs `:252-262`). "Permission wrong" is S2 and must be fixed before release (`WORKFLOW.md:97`). Adding a server change is a scope change, so the owner decides. If the answer is "backlog", the owner's acceptance of a known S2 gap goes into `decisions.md` (BRD §7). |
| BE2 | developer-backend | Reword R7.AC7; fixture users by SQL; explicit `reviewerId`; email/Telegram precondition | ACCEPTED-v2 (R7.AC7, AC10, AC11, AC12) + **OWNER Q17, Q19** | v1 AC7 could not be met, because every active `view_all_task_reports` holder is notified. An email or Telegram message cannot be recalled, so only the owner can accept that side effect. |
| BE3 | developer-backend | Make Q14 and R7.AC7 consistent | ACCEPTED-v2 (Q14) | No demo login is used any more, so no demo audit row is created. Backend re-check: RESOLVED. |
| BE4 | developer-backend | Remove the unconditional reset at `verify-permission-matrix.mjs:62-64` | ACCEPTED-v2 (R7.AC0) | Merged with SD6. See conflict M6 and pin P6 (how the precondition is read). |
| BE5 | developer-backend | Restore by SQL snapshot; allow a captured `updated_at`; verify through GET only | ACCEPTED-v2 (R6.AC3, R7.AC4, C1, R6.AC10) | The API cannot recreate a default-valued row or a prior `updated_by_id`. |
| BE6 | developer-backend | No ORM model calls; `$executeRaw` for writes | ACCEPTED-v2 (R6.AC2, R7.AC2b, R9.AC2d) | `agent.md` raw-SQL rule and D7. |
| BE7 | developer-backend | DB guard `SELECT @@port, DATABASE()` | ACCEPTED-v2 (R10.AC11) + **OWNER Q18** | The guard proves `agent.md` §6 (`agent.md:257-258`) without reading `.env`. The port-mapping caveat is an owner question. |
| BE8 | developer-backend | Scope counts to the stamp or IDs; global counts only in an exclusive window | ACCEPTED-v2 (R6.AC4, R7.AC6, R9.AC4, R10.AC10, R10.AC13) | Concurrent logins and DoD runs change global counts. |
| BE9 | developer-backend | Q5/R9: only option 2 meets the criteria; delete by approved primary keys with a re-count; backup command; cases before module | ACCEPTED-v2 as the recommendation (R9 "Why the method matters", R9.AC1–AC2d, Q5) + **OWNER Q5** | The BRD now explains with citations why options 1 and 3 fail R9.AC5/AC6. The method and the backup are the owner's call (`WORKFLOW.md:82` rule 9). |
| BE10 | developer-backend | Group D: offer the alternative of keeping the module review | **OWNER Q20** (recommended: a) | The prior case status is not stored anywhere, so a rollback would be guesswork. |
| BE11 | developer-backend | Q13: add the `daily_report_submitted` notifications to the inventory | ACCEPTED-v2 (Q13, group I) | They are test data, created on every save. |
| BE12 | developer-backend | Backlog: the PUT toggle returns `source:'override'`; the full list of `agent.md:138-139` errors | **BACKLOG B17, B18** | Both are outside REQ-001. B18 is linked to Q6. |
| BE-R1 | developer-backend (re-check) | R11: a bad request gets 400 before the 403 (`route.ts:58`, `:60`) | CARRIED-P5 (developer-backend `04-design.md`; tester `05-test-plan.md`) | R11.AC1 already says "valid body", so the AC holds. The tester must not file a 400 for a bad body as a bug. The gate stays the first line of `updateTaskReportFields`. |
| BE-R2 | developer-backend (re-check) | Fixture user INSERT sets `notify_email=0`, `notify_telegram=0` | CARRIED-P5 (sdet `05-test-plan.md`; developer-backend SQL review in `04-design.md`) | No asserted status changes, and it removes email attempts to stamped addresses. Q17 still covers the demo recipients. |
| BE-R3 | developer-backend (re-check) | Delete `crew_desk_links` explicitly in the R9 delete step, not only in the dry-run list | CARRIED-P5 (sdet cleanup-script design; developer-backend SQL review) | The table has no FK. R9.AC4 already requires removed rows to equal the approved list, so this is consistent. |
| BE-R4 | developer-backend (re-check) | The answers table cites "R9.AC2a–AC2e" | Record conflict **M4**. The BRD wins. No BRD change. | The BRD defines only AC2a–AC2d (`02-brd.md:374-377`). The slip is in the product-owner answers row (`03-review.md:630`). |

### developer-frontend (round 1: 9 items, re-check: 3 notes)
| # | Raised by | Request | Decision | Reason |
|---|---|---|---|---|
| FE1 | developer-frontend | Add the row "holds `view_all_task_reports`, lacks `create_task_report`" | ACCEPTED-v2 (R1 table row 4, N3, R1.AC8) | Without it, the UI shows false "Switch back" advice. |
| FE2 | developer-frontend | Read-only empty state; Export CSV disabled | ACCEPTED-v2 (R1.AC1(b), R1.AC4, R1.AC6, §2) | This is a small visible change for vp, manager and product. It is stated in §2, so the owner sees it when approving. |
| FE3 | developer-frontend | Make R2.AC6 testable (not "no pointer cursor") | ACCEPTED-v2 in the tester's DOM form (R2.AC6 a–d) + **OWNER Q10** | The v1 check already passes without the fix. |
| FE4 | developer-frontend | Q11 wording; render a plain `Alert`, not `PermissionDenied` | ACCEPTED-v2 as the recommendation (N1) + **OWNER Q11** | The page itself is allowed, and the text names the matrix label. |
| FE5 | developer-frontend | "Full reload or fresh login" | ACCEPTED-v2 (C4, with the tester's cross-check) | A full load calls `GET /api/auth`. Client-side navigation does not count. |
| FE6 | developer-frontend | Replace R10.AC4 with the five hot-reload mitigations | ACCEPTED-v2 (R10.AC4 a–e) + **OWNER Q21(3)** | Next dev applies a file on save, and Fast Refresh drops unsaved /tasks input. |
| FE7 | developer-frontend | Q10 = yes | **OWNER Q10** (recommended: yes) | Scope decision. |
| FE8 | developer-frontend | Q12 = hide | **OWNER Q12** (recommended: hide) | Scope or UX decision. |
| FE9 | developer-frontend | Backlog: ungated /reviews links; overflow label; Activity card on error; sidebar memo | **BACKLOG B19, B20, B21, B22** | Same defect class, but outside this BRD. |
| FE-R1 | developer-frontend (re-check) | `{date}` in R1.AC1(b) depends on the locale | CARRIED-P5 (developer-frontend `04-design.md`, tester T1) → pin **P1** | The text "as shown in the Date field" cannot be compared exactly. Record conflict **M9**. |
| FE-R2 | developer-frontend (re-check) | "Exactly one notice" excludes the load-error alert | CARRIED-P5 (developer-frontend `04-design.md`, tester T2) → pin **P2** | N1, N2 and N3 are notices. The error alert is not one. |
| FE-R3 | developer-frontend (re-check) | R1.AC5 role list differs from the answers table | Record conflict **M5**. The BRD wins. No change. | `02-brd.md:98` (vp, manager, developer: no save) vs `03-review.md:655` ("vp, manager, qa1 (and developer)"). The tester confirmed that the BRD wins (`03-review.md:403`). |

### tester (round 1: 19 items, re-check: T1–T6)
| # | Raised by | Request | Decision | Reason |
|---|---|---|---|---|
| TE1 | tester | Add qa2 and use it for qa_engineer writes | ACCEPTED-v2 (C2) | qa1 holds group B data. qa2 login is NOT VERIFIED; the tester checks it first in phase 7. |
| TE2 | tester | R1.AC1: both states; exact notice text | ACCEPTED-v2 (R1.AC1 a/b, N1–N3) + **OWNER Q11** | Exact string compare. |
| TE3 | tester | R1.AC2 chained after the R1.AC7 viewer save | ACCEPTED-v2 (R1.AC2) | It cannot be observed otherwise. |
| TE4 | tester | R1.AC4 button labels | ACCEPTED-v2 (R1.AC4) | "Export" vs "Export CSV". |
| TE5 | tester | R1.AC5: 2 real saves plus an enabled-state check | ACCEPTED-v2 (R1.AC5) | Fewer writes and fewer notifications. |
| TE6 | tester | Add R1.AC8 | ACCEPTED-v2 (R1.AC8) | Same as FE1. |
| TE7 | tester | R2.AC3 also covers the empty header group | ACCEPTED-v2 (R2.AC3) | — |
| TE8 | tester | R2.AC4: no bug is submitted | ACCEPTED-v2 (R2.AC4) | Avoids cleanup rows. |
| TE9 | tester | R2.AC6 DOM wording | ACCEPTED-v2 (R2.AC6) + **OWNER Q10** | — |
| TE10 | tester | R2.AC7 by code review; runtime only if the data allows | ACCEPTED-v2 (R2.AC7 evidence rule) + **OWNER Q10** | No fixture bugs are created. The runtime part can end NOT VERIFIED; that is an S4 path. |
| TE11 | tester | R3.AC1 extra entry paths; name the R3.AC6 case | ACCEPTED-v2 (R3.AC1 1–4, R3.AC6) + CARRIED-P5 (tester names the seed case in `05-test-plan.md`) | — |
| TE12 | tester | R3.AC7 exclusive UTC window | ACCEPTED-v2 (R3.AC7, R10.AC10) + **OWNER Q21(2)** | 403 log lines carry no user id. |
| TE13 | tester | R7.AC5: name the accepted evidence for the closed branch | ACCEPTED-v2 (R7.AC5, code reading accepted) | `.env` must not change. |
| TE14 | tester | Script output is the count evidence | ACCEPTED-v2 (R10.AC13) | The tester has no DB access. |
| TE15 | tester | R8.AC5: capture the pre-fix baseline first | ACCEPTED-v2 (R8.AC5–AC6) | — |
| TE16 | tester | R10.AC2 wording | ACCEPTED-v2 (R10.AC2) | — |
| TE17 | tester | Test conditions become approved criteria | ACCEPTED-v2 (R10.AC5–AC13) + **OWNER Q21** | — |
| TE18 | tester | Group I; R9 after the last write; read-only after R9 | ACCEPTED-v2 (group I, R9.AC10–AC11, C5) + **OWNER Q13** | — |
| TE19 | tester | Owner confirms SMTP/Telegram before phase 7 | **OWNER Q17** | Only the owner can see `.env`. |
| T1 | tester (re-check) | `{date}` = ISO `YYYY-MM-DD` | CARRIED-P5 → pin **P1** | Same as FE-R1. |
| T2 | tester (re-check) | "Notice" = N1, N2, N3 only | CARRIED-P5 → pin **P2** | Same as FE-R2. |
| T3 | tester (re-check) | R1.AC1(a) for the viewer is verified through R1.AC2 and R1.AC6 | CARRIED-P5 (tester `05-test-plan.md`) → pin **P3** | Under the default matrix the viewer has no saved report. |
| T4 | tester (re-check) | Write budget: double-click on qa2's save; failed R11 attempts not counted; 60 s delivery window | CARRIED-P5 (tester `05-test-plan.md`) → pin **P4** | Consistent with R10.AC8 (`02-brd.md:410`). |
| T5 | tester (re-check) | The owner writes the "did not use :3000" confirmation after the window; otherwise R3.AC7 is NOT VERIFIED | CARRIED-P5 (tester) + **OWNER Q21(2)** | The confirmation is owner evidence. R3.AC7 is an S4 path, so NOT VERIFIED there does not block the release by rule, but it is reported. |
| T6 | tester (re-check) | Positive control for the residue checker; DB guard abort branch proven by code reading | CARRIED-P5 (sdet + tester `05-test-plan.md`) → pin **P5** | A zero that was never shown to detect anything proves nothing. |

### sdet (round 1: 11 items, re-check: S1–S7)
| # | Raised by | Request | Decision | Reason |
|---|---|---|---|---|
| SD1 | sdet | R5: exactly 36 | ACCEPTED-v2 (R5.AC1, R5.AC4, R4.AC3) | 6 × 6, verified by the product-owner. |
| SD2 | sdet | R6: print `PASS=n FAIL=n` | ACCEPTED-v2 (R6.AC1) + CARRIED-P5 (sdet fixes the exact count in `05-test-plan.md`) | 47 `ok(` call sites, not 48 (the 48th line is the definition, `:18`). |
| SD3 | sdet | R6.AC3 (ii) → precondition, exit 2 | ACCEPTED-v2 (R6.AC3) | v1 contradicted R6.AC1/AC6. |
| SD4 | sdet | Cleanup survives a throw and Ctrl+C; `--cleanup-stamp`; `VERIFY_FAIL_AT` | ACCEPTED-v2 (R6.AC5, R6.AC9, R7.AC8) | See S4 / pin P7. |
| SD5 | sdet | Grant through the API; SQL restore; ≥3.5 s wait; GET compare; concurrency guard | ACCEPTED-v2 (R6.AC8, R6.AC3, R6.AC10, C1) | — |
| SD6 | sdet | R7: precondition, exact count, restore checked, cleanup by ids, explicit reviewer | ACCEPTED-v2 (R7.AC0, AC9, AC13, AC6, AC11) | See S1 / pin P6. |
| SD7 | sdet | R8 baseline protocol; `--self-test` | ACCEPTED-v2 (R8.AC3, AC5, AC6) | See S5. |
| SD8 | sdet | Test execution rules block | ACCEPTED-v2 (R10.AC10, R10.AC11) + **OWNER Q18** | — |
| SD9 | sdet | Approve `scripts/verify-ui-gates.mjs` | **OWNER Q7** (recommended: approve) | Without it, "new behavior covered by an automated test" (`agent.md:220`) needs an owner-approved deviation in `decisions.md`. |
| SD10 | sdet | R9: groups E2 and J; timing after phase 10; forbidden scripts; one residue checker | ACCEPTED-v2 (R9 inventory, R9.AC10, R9.AC12, R10.AC13) | Timing creates a process deviation; see S7 / **A3**. |
| SD11 | sdet | Backlog: VERB `/g`; `check-overrides.mjs`; `cleanup-import-demo.mjs`; `verify-wiki.mjs:211`; additions to B16 | **BACKLOG B23, B24, B25, B26**; **B16 extended** | None of these blocks REQ-001. |
| S1 | sdet (re-check) | Read the R7 precondition by SQL before any fixture exists; an exit-2 run = NOT RUN | CARRIED-P5 (sdet `05-test-plan.md`) → pin **P6** | Record conflict **M6**: R7.AC0 says "read `GET /api/permissions`" and "make no write", but R7.AC10 forbids a demo login, and a fixture VP is a write. |
| S2 | sdet (re-check) | Restore = DELETE under the precondition; check the suite's own last write before restoring | CARRIED-P5 (sdet) | A stricter version of R6.AC3 and R6.AC10. |
| S3 | sdet (re-check) | `--cleanup-stamp`: exact emails; delete permission rows only if `updated_by_id` is a fixture id | CARRIED-P5 (sdet) | Recovery has no in-memory snapshot. |
| S4 | sdet (re-check) | Unknown hook value → exit 2; `mid-cleanup-docs` leaves residue by design and `--cleanup-stamp` brings it to 0 | CARRIED-P5 (sdet) → pin **P7** | Record conflict **M7**: R6.AC5 says R6.AC4 "still holds" for every hook, but `mid-cleanup-docs` must leave residue (RESTRICT FK). |
| S5 | sdet (re-check) | `--self-test` also feeds full paths with both separators | CARRIED-P5 (sdet) | The bare names in R8.AC3 also pass with the unfixed code. This strengthens the test; the AC list is the minimum. |
| S6 | sdet (re-check) | `GET_LOCK('tcms_verify', 0)`; add the R9 script and the residue checker to the serial rule | CARRIED-P5 (sdet; developer-backend review) → pin **P8** | The R10.AC10 list misses them. A dry run during a live suite would list in-flight fixtures. |
| S7 | sdet (re-check) | R9 runs inside phase 10, before "RELEASE"; UAT marks R9 "deferred to phase 10" | **OWNER A3** (process deviation) | Record conflict **M8**: the phase 8 gate requires every AC PASS (`WORKFLOW.md:58`). R9 cannot run before the phase 10 DoD (R9.AC10). |

### Record conflicts found (WORKFLOW rule 4: reported, not picked silently)
| # | Documents that disagree | Handling |
|---|---|---|
| M1 | `01-kickoff.md:69-70` and the backend assignment at `:142` ("no API change expected"; "confirm no backend change needed") vs BRD v2 R11 (a server change if Q15 = yes). | BRD v2 supersedes the kickoff. The kickoff stays unchanged as the historical record. If Q15 = yes, developer-backend designs and builds R11. |
| M2 | `CODEBASE-MAP.md:78` lists `create_task_report` as the task-reports gate next to "PUT `?id` (owner only)". The code does not gate PUT (R11, `task-reports.service.ts:252-262` per backend). | If Q15 = yes, the map becomes true. If Q15 = backlog, the map overstates the protection, and the line belongs in the conditional backlog item. R4 does not list `CODEBASE-MAP.md:78`; I flag it for the Q2 edit list. |
| M3 | `agent.md:138-139` (soft delete for cases, "only bugs hard-delete") vs `CODEBASE-MAP.md:73-74` ("hard, cascades" / "hard") vs the code (hard delete; module delete orphans cases and bugs). | **OWNER Q6** (already open). Backlog B18 has the full list. |
| M4 | `03-review.md:630` "R9.AC2a–AC2e" vs `02-brd.md:374-377` (AC2a–AC2d only). | The BRD wins. A cosmetic fix to the answers row is optional for the product-owner. |
| M5 | `03-review.md:655` (no-save roles "vp, manager, qa1 (and developer)") vs `02-brd.md:98` (vp, manager, developer). | The BRD wins (tester agrees). |
| M6 | R7.AC0 (read `GET /api/permissions`, no write) vs R7.AC10 (no demo login, so a GET needs a fixture VP, which is a write). | Pin P6. The owner approves it with the BRD (A1), or asks for v3. |
| M7 | R6.AC5 ("R6.AC4 still holds" for every `VERIFY_FAIL_AT` step) vs the RESTRICT FK on `wiki_documents.author_id` for `mid-cleanup-docs`. | Pin P7. Same handling as M6. |
| M8 | R9.AC10 (R9 runs after the phase 10 DoD) vs `WORKFLOW.md:58` (phase 8 gate: every AC PASS). | **OWNER A3**. |
| M9 | R1.AC1(b) "date as shown in the Date field" (locale-dependent) vs the exact string compare (C-convention, tester). | Pin P1. |
| M10 | Q2 recommends a one-time edit grant to the **manager**, but the manager agent file allows editing only `docs/requirements/**`, `backlog.md`, `decisions.md` and `lessons/manager.md`. | If the owner chooses this, the grant must be written into `decisions.md` with the exact lines (exception to rule 7) before any edit. I will not edit those files without that entry. |

### Pinned interpretations (become binding when the owner approves BRD v2 under A1)
- **P1** R1.AC1(b): `{date}` is the ISO value `YYYY-MM-DD` (for example `No tasks logged for 2026-01-01.`).
- **P2** "Exactly one notice" counts only N1, N2 and N3. The load-error alert, toasts and the empty-state text are not notices.
- **P3** R1.AC1(a) for the viewer is verified through R1.AC2. For other roles it is verified through R1.AC6. It is not a separate default-matrix check.
- **P4** Write budget: the double-click check runs on qa2's R1.AC5 save. The failed R11 attempts (403, 404, 400, 401) are not writes. R10.AC12 counts delivery lines up to 60 s after the last write.
- **P5** A "0" from `check-suite-residue.mjs` counts only after a positive control (group A pattern before R9). The DB guard's abort branch is proven by code reading plus the printed guard line.
- **P6** R6/R7 preconditions are read by SQL before any fixture exists (R7: `SELECT COUNT(*) FROM role_permissions` = 0). The 126-cell GET snapshot is taken after the fixtures exist and before the first permission write. An exit-2 run is reported NOT RUN.
- **P7** For `VERIFY_FAIL_AT=mid-cleanup-docs`, the expected result is a non-zero exit with the residue listed, and then `--cleanup-stamp` brings the residue to 0. An unknown hook value exits 2.
- **P8** The R10.AC10 serial rule also covers the R9 dry run and delete and `check-suite-residue.mjs`. Scripts take `GET_LOCK('tcms_verify', 0)` after the DB guard.

### Backlog handling (this run)
- Added **B17–B29** to `docs/process/backlog.md`: BRD §7 items 1–11, the R8 real-violation follow-up, the Q16 promotion item, and one backend observation (B29).
- **B16 extended** (BRD §7 item 11). B13, B14, B15 and B16 already existed from the kickoff and were not duplicated. B8 and B11 already existed.
- **Conditional, not added yet** (added only after the owner's answer): the S2 PUT task-report gap and `CODEBASE-MAP.md:78` (if Q15 = backlog), the `docs/04-api-reference.md:216` drift (if Q22 = no), and a UI test framework (if Q7 = no).

Items needing owner approval:

**Group 1: blocking for APPROVED (needed before phase 5 design starts)**
- [x] **A1 Approve BRD v2** (`02-brd.md`, version 2) together with pins P1–P8 above. If you want the pins written into the BRD text instead, ask the product-owner for v3. → **Owner 2026-10-15: APPROVED** (BRD v2 + P1–P8 binding; no v3).
- [x] **Q15 R11 (PUT task-report gap, S2).** Recommended: **include R11**. It is a one-line server check plus a suite check, about 1–2 h. "Backlog" means you accept a known S2 gap for this release, and that acceptance is recorded. → **Owner: R11 IN scope** ("R11 included in this REQ"). R4.AC9 applies.
- [x] **Q10 Extra dashboard gates (R2.AC6–AC8).** Recommended: **yes**. Same file, about 30 minutes. → **Owner: yes** (recommendation accepted). R2.AC6–AC8 and the Q10 part of R4.AC4 are in scope.
- [x] **Q11 N1 text.** Recommended: `Your role can view work logs but cannot log work. A VP can enable "Create task reports" for your role under Permissions.` → **Owner: recommended text accepted.**
- [x] **Q12 Activity card without `view_activity_logs`.** Recommended: **hide it**. → **Owner: hide** (recommendation accepted).
- [x] **Q9 Bug 7 target.** Recommended: **port** `verify-permission-matrix.mjs` to the default matrix with stamped fixture users created by SQL. No demo login, nothing left behind. → **Owner: port** (recommendation accepted).
- [x] **Q14 "No residue" for R6/R7.** Recommended: **remove every row the run caused**, including notifications to demo users (found by entity) and fixture activity_logs. → **Owner: remove every row the run caused** (recommendation accepted).
- [x] **Q7 Automated UI coverage.** Recommended: **approve** `scripts/verify-ui-gates.mjs` (headless Chrome over CDP, no new dependency, read-only, own profile, kills only its own pid tree). If you say no, record a DoD deviation in `decisions.md` and add a UI test framework to the backlog. → **Owner: approved** (recommendation accepted). No DoD deviation entry needed.
- [x] **Q18 DB guard.** Recommended: require `DATABASE()` = `tcms_test` **and** an in-process `DATABASE_URL` host/port check that prints only true/false. Abort if `@@port` ≠ 5500, unless you state that MySQL runs behind a port mapping. → **Owner: recommendation accepted.** No port mapping was stated, so scripts abort if `@@port` ≠ 5500.
- [x] **Q2 Who edits `agent.md`, `CODEBASE-MAP.md`, `docs/README.md`, `docs/04`, `docs/06`.** Recommended: a **one-time grant to the manager** for exactly the R4 lines, plus `CODEBASE-MAP.md:78` (M2), recorded in `decisions.md`. Without an answer, R4 stays BLOCKED. → **Owner: one-time grant to the manager, recorded in `decisions.md` (D11).** Scope = the lines listed in `02-brd.md:530` plus `CODEBASE-MAP.md:78`. `docs/README.md` gets no edit, because Q8 = leave as is. R4 is unblocked for editing once D11 exists.
- [x] **Q1 `npm run build` while `next dev` runs.** Recommended: **build in a separate git worktree**. If that needs `.env`, report DoD item 3 as NOT VERIFIED and you run the build yourself. In that case you must accept it explicitly at the release review. → **Owner: "separate copy is fine"** = a separate git worktree copy for the build. The `.env` fallback rule still applies (no agent copies `.env`).

**Group 2: blocking before phase 7 testing and the first R6/R7 suite run (can be answered now)**
- [x] **Q13 Test date.** Recommended: **one past date you choose** (for example 2026-01-01). 3 saves (product, qa2, viewer while granted), all recorded as group I. → **Owner: 2026-10-01.**
- [x] **Q17 Email/Telegram.** Recommended: **confirm that SMTP and Telegram are NOT configured** on this machine, or accept the messages. The tester stops on any `sent`. → **Owner confirmed: email and Telegram are NOT configured.** The tester's stop-on-`sent` rule stays as a tripwire.
- [x] **Q19 Transient in-app notifications to demo holders during R7 runs.** Recommended: **accept** (they are deleted at cleanup). → **Owner: yes** (accepted).
- [x] **Q21 Your use of :3000.** Recommended: **agree** to (1) an announced toggle window, (2) an announced UTC R3 window, after which you write the "did not use :3000" confirmation (T5), and (3) a warning before `tasks.tsx` is saved. → **Owner: yes** (agrees to all three).

**Group 3: blocking for R9 only (needed before the R9 dry run in phase 10)**
- [x] **A2 R9 cleanup gate.** Approve the procedure: you take the backup (R9.AC1), the script runs a dry run by default, you approve the exact primary-key list in writing (R9.AC3), and only those keys are deleted, re-counted in one transaction (R9.AC2b). Nothing is deleted before your second, list-level approval. → **Owner: accepted as PROCEDURE ONLY.** This is not a go for any delete. A separate written owner go on the exact dry-run primary-key list is still required before the delete step (R9.AC3, and the owner's own speed rule "ask before the cleanup deletes data").
- [x] **A3 Process deviation.** R9's ACs are marked "deferred to phase 10" in UAT (`WORKFLOW.md:58`), and R9 runs after the final phase 10 DoD and before "RELEASE" (S7, M8). Recommended: **approve**. → **Owner: approved** (procedure only; same delete gate as A2).
- [x] **Q3 Cleanup scope.** Recommended: A; B only if the dry run shows QA-check text; C (all "Imported:"); D per Q20; E left soft-deleted; E2; F cascades and entity notifications only (activity_logs kept); G verify only; H out; I; J if any. → **Owner: recommendation accepted.**
- [x] **Q4 B8 `self-*@tcms.test`.** Recommended: **out** (stays B8). → **Owner: out** (recommendation accepted).
- [x] **Q5 Method and backup.** Recommended: **option 2 only** (reviewed raw-SQL script, dry run by default, approved primary keys). Hard delete with listed cascades. Keep activity_logs. You take the backup with the `mysqldump --protocol=TCP --host=127.0.0.1 --port=5500 … --result-file=` command in Q5. Also confirm that `mysqldump.exe` is on your PATH and that the DB user has SELECT, SHOW VIEW and TRIGGER. → **Owner: option 2 only; owner takes the backup** (recommendation accepted). **Still UNKNOWN:** `mysqldump.exe` on PATH and the DB user's SELECT/SHOW VIEW/TRIGGER rights were not confirmed. Needed before the R9 backup (phase 10), not before.
- [x] **Q6 Delete-semantics contradiction.** Recommended: **the code is authoritative**. Fix `agent.md` §2 later (B18). No change in REQ-001. → **Owner: code is authoritative** (recorded as D12). `agent.md` §2 is fixed later under B18, not in REQ-001.
- [x] **Q20 Group D.** Recommended: **(a)** keep the verify-permissions module review(s) and the seed statuses; delete only the "Perm-verify case …" rows. → **Owner: (a)** (recommendation accepted). No status rollback.

**Group 4: non-blocking (defaults apply if unanswered)**
- [x] **Q8 `docs/README.md:75` "63/63".** Recommended: **leave unchanged**. → **Owner: leave as is.**
- [x] **Q16 DoD list.** Recommended: **no new suite joins `agent.md` §3** in REQ-001. Promotion criteria are recorded in B28. → **Owner: no** (no new suite joins the DoD list in REQ-001).
- [x] **Q22 `docs/04-api-reference.md:216` drift.** Recommended: **yes**, fix it under R4.AC8 with the Q2 grant (one line). → **Owner: yes.** R4.AC8 is in scope, edited under D11.

**Conditional backlog items (from "Backlog handling" above):** none is triggered. Q15 = yes, Q22 = yes and Q7 = approve, so the S2 PUT gap, the `docs/04:216` drift and a UI test framework are NOT added to the backlog.

## Owner decision
<!-- Only the human owner writes here. -->
Decision: APPROVED
Date: 2026-10-15
Notes:

> Accept all team recommendations, with these answers:
> Q1 separate copy is fine. Q13 use 2026-10-01. Q17 confirmed: email and Telegram are
> NOT configured. Q19 yes. Q21 yes. Q2 one-time grant to the manager, record it in
> decisions.md. Q3/Q4/Q5/Q6/Q20 accept recommendations. Q8 leave as is. Q16 no. Q22 yes.
> R11 included in this REQ.
>
> APPROVED.
>
> Speed rules for the build: work straight through without re-reviews unless a gate
> fails. Keep reports short. Do not ask me again unless something is blocked, a file
> outside the approved scope must change, or before the cleanup deletes data.

Recorded by manager on the owner's instruction (the owner wrote APPROVED in chat).
Provenance: the text above was relayed verbatim to the manager by the orchestrating session; the manager did not see the chat itself. `WORKFLOW.md:54` says the owner writes APPROVED in this file, so this is a recorded-on-behalf entry. The owner can confirm it by reviewing this section and `decisions.md` D10–D13.
Resolved answers per item: see the ticked list under "Items needing owner approval" above. Decisions logged: `docs/process/decisions.md` D10–D13.
Still gated: the R9 delete step needs a separate written owner go on the exact dry-run key list (A2, R9.AC3). Q5 tooling (mysqldump on PATH, DB user rights) is still UNKNOWN and needed before the R9 backup.
