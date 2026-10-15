# REQ-001 Developer Report

Sections: Backend (developer-backend), R8 evidence, Frontend (developer-frontend, to be added).

## 1. Backend — R11 `PUT /api/task-reports?id=` requires `create_task_report`

Author: developer-backend · Design: `04-design.md` §2.1 · Date: 2026-10-15

### 1.1 What changed

| File:line | Change |
|---|---|
| `src/app/api/task-reports/task-reports.service.ts:252` | JSDoc of `updateTaskReportFields` gains: "Requires create_task_report (same gate as POST), checked before the lookup so a missing id does not reveal existence." |
| `src/app/api/task-reports/task-reports.service.ts:259` | New first statement of `updateTaskReportFields`: `ensurePermission(me, 'create_task_report', 'Insufficient role')` (same call and message as POST at `:193`; import already present at `:10`) |

Nothing else changed: controller (`route.ts`), validator, repository, schema, migrations, cache, client and UI are untouched.

```
$ git diff --stat
 src/app/api/task-reports/task-reports.service.ts | 4 +++-
 1 file changed, 3 insertions(+), 1 deletion(-)
$ git diff -U0
@@ -251 +251,2 @@ export async function upsertTaskReport(
- *  totalMinutes is always recalculated from the resulting task list. */
+ *  totalMinutes is always recalculated from the resulting task list.
+ *  Requires create_task_report (same gate as POST), checked before the lookup so a missing id does not reveal existence. */
@@ -257,0 +259 @@ export async function updateTaskReportFields(
+  ensurePermission(me, 'create_task_report', 'Insufficient role')
```

### 1.2 Mapping to R11 acceptance criteria

| AC | How it is met | Verified here? |
|---|---|---|
| R11.AC1 | The permission check is the first statement of the service, before `findTaskReportById`, so a viewer gets 403 "Insufficient role" for any id (existing or random) and no row is read or written. Requests with a bad body still get 400 first (controller validation, design 2.1 status order step 4). | Code only. Live check needs a viewer session: phase 7 (MT-R11-01a/b) |
| R11.AC2 | `can()` reads the override cache (3 s TTL), refreshed on each `requireUser()`, so a revoked grant gives 403 on the own report. | Phase 7 (MT-R11-02) |
| R11.AC3 | Holders pass the gate; the 404 / own-only 403 / 200 / 400 / 401 paths are unchanged. 401 with no session confirmed live (1.4). | 401 only; rest phase 7 (MT-R11-03) |
| R11.AC4 | sdet adds 2 checks to `verify-permissions.mjs` (test plan A4). | Run in phase 7 by sdet |
| R11.AC5 | Diff above: one service file only; no schema, migration, cache or client change. | Yes (diff) |
| R11.AC6 | Docs wording supplied in `04-design.md` §2.1 "Docs"; the manager edits `docs/04-api-reference.md` under D11. | Not by me |

### 1.3 Definition of Done (items runnable now)

```
$ npx tsc --noEmit
tsc_exit=0

$ npx eslint .
C:\dev\tcms\src\components\shared\rich-text-editor.tsx
  46:5  warning  Unused eslint-disable directive (no problems were reported from 'react-hooks/exhaustive-deps')

✖ 1 problem (0 errors, 1 warning)
  0 errors and 1 warning potentially fixable with the `--fix` option.
eslint_exit=0
```

Raw counts: tsc 0 errors; eslint 0 errors, 1 warning (pre-existing, file not touched by REQ-001).

- `npm run build`: run in phase 7 by sdet (separate worktree, Q1).
- DoD suites (`verify-*`): run in phase 7 by sdet (they write to `tcms_test`).

### 1.4 Read-only live check (no login, no writes; app on :3000 not started or stopped)

```
GET /api:
{"status":"ok","service":"tcms-api"} http=200
PUT no CSRF:
{"error":"Missing CSRF verification header"} http=403
PUT CSRF, no session:
{"error":"Unauthorized"} http=401
```

(PUT `?id=x` with body `{}`; matches the status order steps 1 and 2 in design 2.1.)

### 1.5 NOT VERIFIED (backend)

- The 403 "Insufficient role" path on the running app (needs a viewer session; phase 7).
- That the running `next dev` process serves the new code: hot reload is expected, but no authenticated probe could prove it here (the no-session probes return the same codes before and after the change).
- The R11.AC4 **control run before the fix** (test plan A4: expect `32 passed, 1 failed`): this commit puts the gate on the live tree, so the sdet must run the control against a pre-fix checkout (the commit before this one) or record it as NOT VERIFIED.
- `npm run build` and DoD suites 4–7: phase 7 by sdet.

### SQL review (phase 6)

Read-only review of the sdet scripts against design 2.2 (R9) and 2.3 (R6/R7). Nothing run, nothing edited. Evidence I used: `evidence/r9-dryrun-1.txt`.

**Verdict: PASS. No blocking defects.** Per check:
- Parameterized only: PASS. All values go through tagged `$queryRaw`/`$executeRaw` or `Prisma.join`. `Prisma.raw` is only used for constant column names (`sqlIn`, `db-guard.mjs:127-130`) and the constant SELECT heads in `ROOT_LOCK_SQL` (`cleanup-req001-testdata.mjs:135-141`). LIKE patterns are literals or bound parameters.
- DB guard: PASS. The URL is checked in-process before any `PrismaClient` exists (`db-guard.mjs:61-66`). Then `@@port`/`DATABASE()` is the first statement (`:85`), then `GET_LOCK` (`:100`), with `connection_limit=1`. All three scripts call `openGuardedDb()` before any SQL.
- ID-scoped deletes: PASS. R9 deletes only by PKs from the approved file. Suites delete only by fixture ids or collected entity ids. No LIKE in any DELETE.
- FK order: PASS. R9 goes notifications → crew_desk_links → bugs → test_cases → wiki → task_reports → modules (`cleanup-req001-testdata.mjs:162-168`). Matrix suite goes notifications → bugs → cases → participant reviews → wiki → modules (with a SET NULL dependents guard) → cells → activity_logs → login_attempts → users. Wiki suite goes docs → cells → activity_logs → users. In both suites activity_logs are deleted before users.
- R9 transaction: PASS. It locks the roots with `FOR UPDATE`, rebuilds the children and orphans from the approved parent ids, and compares the PK sets. If they differ it rolls back. After the deletes it checks the affected-row counts and that residue is 0, and rolls back if not. `innodb_lock_wait_timeout=5`.
- No UPDATE and no activity_logs/users/role_permissions/refresh_tokens in R9: PASS (only `FOR UPDATE`).
- `--delete` without `--approved` exits 2, and `--approved` without `--delete` exits 2 (`:257-264`).
- Permission restore: PASS. The precondition is checked by SQL (matrix suite: 0 rows; wiki suite: its 2 cells). The restore deletes a touched cell's row only if `updated_by_id` is a fixture (`suite-data.mjs:175-189`). It never writes other cells, and it compares against the pre-run snapshot.

**Findings (not blocking; fix or accept before phase 10):**
1. MEDIUM, owner action, data. Group B also selects `task_reports` `c74e9549-8445-4b92-a82e-fdcd84d99d7c` ("Wrote test cases for login flow", notes about Safari). That is seed/demo content, not QA-check text. It matches only because `DATE(report_date) = 2026-10-15` (`r9-candidates.mjs:37`), and the template puts it in `tables.task_reports` by default (`cleanup-req001-testdata.mjs:111`). The owner must strike it from the approved file. Optional sdet fix: mark B rows whose `tasks`/`notes` contain no `QACHECK` as `B-NO-QACHECK` in the dry-run output.
2. LOW, fail-safe. If one approved module root is nested inside another, the subtree rows are pushed once per root, and `submodules` is not de-duplicated (`r9-candidates.mjs:86-90`). The delete run would then fail `sameSet` or the affected-row count and roll back (a false block, no data risk). Not triggered by the current data (1 root, 0 submodules). Fix: `uniq` the subtree by pk before filtering.
3. LOW, fail-safe. `sameSet` (`cleanup-req001-testdata.mjs:131`) can return true when the second list has duplicates. Today only `submodules` can carry duplicates (see 2). Fix: compare `new Set(b).size` as well.
4. INFO. The PKs in the approved file are not checked for UUID shape (`readApproved`, `:123-129`). There is no injection risk because the values are bound parameters. A shape check would catch a hand-edit typo before the transaction starts.
5. INFO, owner decision (design 2.2 Group D). The dry run flags `D-EMPTY` for module review `11ceea3a-…`: groups C and D together remove all 4 of its case reviews.
6. INFO. If the owner strikes a root (for example `fc2f0e2f` in group B), its listed children (3 `task_report` notifications) must be struck too. Otherwise the re-check fails and rolls back, which is intended.

## 2. R8 — audit evidence (R8.AC4)

Raw contents of `evidence/r8-audit-after.txt` (captured with the R8 fix, commit 848bcc1, before any `src/` edit):

```
STANDARDS AUDIT: 0 violations across 193 TS files
```

Run metadata (`evidence/r8-audit-after.meta.txt`): head `6a8e75f`, `git status --porcelain src` empty, command `node scripts/audit-standards.mjs`, exit 0.

## 3. Frontend — R1, R2, R3 UI gates

Author: developer-frontend · Design: `04-design.md` §3 · Date: 2026-10-15 · **Files complete** (R10.AC6: testing may start).

### 3.1 What changed (5 view files only, edit order per design 3.4)

One save per file (single `Edit` for files 1–2; one `fs.writeFileSync` from a scratchpad Node script for files 3–5, every replacement matched exactly once). No new hook, component, query key or API function. `api.ts`, store, providers, sidebar, routes, shared components untouched. `npx tsc --noEmit` + `npx eslint <file>` passed (exit 0) after each file before the next.

| # | File:line | Change | AC |
|---|---|---|---|
| 1 | `src/components/views/activity-log.tsx:92` | `activityLogsApi.list` query: `enabled: !!user && can('view_activity_logs')`; page gate `:98` unchanged | R3.AC1, AC4 |
| 2 | `src/components/views/integrations.tsx:70-86` | `canManageIntegrations = !!user && can('manage_integrations')` (plain call) → `enabled` on `crewdesk` config / links / email-check; `['modules','flat']` and PermissionDenied unchanged | R3.AC1, AC2, AC5 |
| 3 | `src/components/views/test-case-detail.tsx:72` | activity query `enabled: !!id && can('view_activity_logs')` | R3.AC1, AC2 |
| 3 | `src/components/views/test-case-detail.tsx:320-349` | Activity card rendered only with `view_activity_logs` (Q12) | R3.AC3 |
| 4 | `src/components/views/dashboard-v2.tsx:279-307` | header wrapper only if any of the 3 keys; "New Test Case" `create_test_case`, "Report Bug" `create_bug`, "Reports" unchanged | R2.AC1, AC3, AC7 |
| 4 | `dashboard-v2.tsx:376` | KPI "My Pending Reviews" `onClick` only with `canReview` (Q10) | R2.AC6 |
| 4 | `dashboard-v2.tsx:667` | Focus Queue "+ N more · view reviews" only with `canReview` (Q10) | R2.AC1 |
| 4 | `dashboard-v2.tsx:688-701` | Quick Actions: New Test Case / Report Bug / Reviews / Reports gated (`create_test_case`, `create_bug`, `perform_review`, `view_all_task_reports`); Tasks, Modules always; grid stays `grid-cols-2` | R2.AC1, AC2, AC3 |
| 4 | `dashboard-v2.tsx:713-717` | Latest Activity "View all" only with `view_activity_logs` (Q10) | R2.AC8 |
| 4 | `dashboard-v2.tsx:931-969` (`KpiCard`) | no `onClick` → static `div` (no `group`/hover lift, no chevron, no role/tabIndex/aria-label); with `onClick` the `button` markup is unchanged | R2.AC6 (a)(b)(c)(d) |
| 5 | `src/components/views/tasks.tsx:59-63` | module constants N1/N2/N3 (`NOTICE_CANNOT_LOG`, `NOTICE_OTHER_USER_CAN_LOG`, `NOTICE_OTHER_USER`) | R1.AC1, AC6–AC8 |
| 5 | `tasks.tsx:188-199` | `canCreateReport`, `viewingOther`, `isReadOnly = !canCreateReport \|\| viewingOther`, `notice` per the 4-row table | R1.AC1, AC2, AC5–AC8 |
| 5 | `tasks.tsx:326-330` | one notice `Alert` (or none); load-error alert independent (P2) | R1.AC1, P2 |
| 5 | `tasks.tsx:394` | read-only start rows `[]` (no blank disabled row) | R1.AC1(b) |
| 5 | `tasks.tsx:570-586` | read-only empty state `No tasks logged for {reportDate}.` (ISO date, P1), no title/"Add your first entry"/Add button; editable branch unchanged. Export CSV keeps `disabled={tasks.length === 0}` | R1.AC1(b), AC4 |

R1.AC3: `taskReportsApi.upsert` is only reachable through Save / `handleSave`, both already behind `!isReadOnly`; no UI caller of PUT. R11 server gate is in 49054b0.

N1/N2/N3 byte check against `02-brd.md:82-84` (backtick text, `grep -cF` in `tasks.tsx`): `1`, `1`, `2` (N3 also matches as a prefix of N2).

R3 call-site grep (`src/**/*.tsx`): every `activityLogsApi.*` and `crewdeskApi.config|list|emailCheck` call is at `activity-log.tsx:90`, `integrations.tsx:73/78/83`, `test-case-detail.tsx:71`, each with the matching `enabled` gate above.

### 3.2 Gates (raw, after all five files)

```
$ npx tsc --noEmit
tsc_exit=0

$ npx eslint .
C:\dev\tcms\src\components\shared\rich-text-editor.tsx
  46:5  warning  Unused eslint-disable directive (no problems were reported from 'react-hooks/exhaustive-deps')

✖ 1 problem (0 errors, 1 warning)
  0 errors and 1 warning potentially fixable with the `--fix` option.

eslint_exit=0
```

Raw counts: tsc 0 errors; eslint 0 errors, 1 warning (pre-existing, untouched file). Per-file runs after each save: all `tsc_exit=0`, `eslint_exit=0`.

### 3.3 Read-only route checks (no login, no writes; :3000 not started or stopped)

```
before edits:  {"status":"ok","service":"tcms-api"} http=200
after edits:
GET /api http=200   {"status":"ok","service":"tcms-api"}
GET /dashboard     307 -> /login?next=%2Fdashboard     final 200
GET /tasks         307 -> /login?next=%2Ftasks         final 200
GET /test-cases    307 -> /login?next=%2Ftest-cases    final 200
GET /integrations  307 -> /login?next=%2Fintegrations  final 200
GET /activity-log  307 -> /login?next=%2Factivity-log  final 200
```

No session, so the app routes redirect to login (expected); this proves the dev server compiles and serves, not the gated UI.

### 3.4 NOT VERIFIED (frontend)

- Rendered UI per role (R1.AC1–AC8, R2.AC1–AC8, R3.AC1–AC7): needs logged-in sessions and network capture; phase 7 (sdet `verify-ui-gates.mjs`, tester).
- That Fast Refresh kept the owner's open-page state on each save (R10.AC4): not observable from here.
- `npm run build` and DoD suites 4–7: phase 7 by sdet (separate worktree, Q1).
- The direct route 200 with a session (above only reaches the login page).

## 4. sdet — test scripts (R5, R6, R7, R9, R10.AC11/AC13, R11.AC4, Q7)

Author: sdet · Date: 2026-10-15 (UTC) · Test plan: `05-test-plan.md` A0–A12. Scripts only: no `src/`, `prisma/` or `.env` edit. The app on :3000 was not started or stopped. Only read-only runs in this phase. The writing suites were **not** run (phase 7, one serial window).

### 4.1 Files

| File | What | Pinned count |
|---|---|---|
| `scripts/lib/db-guard.mjs` (new) | `openGuardedDb()`: in-process `DATABASE_URL` check (127.0.0.1/localhost, 5500, `/tcms_test`; prints only `urlTargetOk`). A wrong URL aborts **before any connection** (3306 is never contacted). Single connection (`connection_limit=1`), first statement `SELECT @@port, DATABASE()`, then `GET_LOCK('tcms_verify', 0)`. Every abort is exit 2. A 30 s keepalive stops long HTTP-only stretches from dropping the session lock; `assertLockOwned()` checks the lock before cleanup. `sqlIn()` handles empty lists (`FALSE`). | — |
| `scripts/lib/fixture-users.mjs` (new) | Raw-SQL fixture INSERT per design 2.3: `UTC_TIMESTAMP(3)`, `notify_email=0`, `notify_telegram=0`, bcrypt of an in-memory random password (never printed); exact e-mails `<prefix>-<key>-<stamp>@tcms.test` | — |
| `scripts/lib/suite-harness.mjs` (new) | Counter; `VERIFY_FAIL_AT`/`VERIFY_PAUSE_AT` (an unknown value exits 2); SIGINT aborts the in-flight main request, then the `finally` cleanup runs (a second Ctrl+C prints `cleanup in progress`); cookie HTTP helpers; manifest; GET-only matrix snapshot diff; one counted check per cleanup step | — |
| `scripts/lib/suite-data.mjs` (new) | ID-scoped entity collection by SQL (before cascades); residue queries for 16 tables; FK-ordered cleanup statements (design 2.3); S2 restore of touched cells (fixture row → DELETE; foreign row → untouched + `matrix changed by another actor`); users deleted one by one | — |
| `scripts/lib/r9-candidates.mjs` (new) | R9 group roots A, B, C, D, E2, I, plus J (listed only); module subtree by materialised path; children; orphan guard; D-EMPTY (design 2.2 SQL) | — |
| `scripts/check-suite-residue.mjs` (new) | Read-only (`SELECT` only; no `$executeRaw` here or in r9-candidates): `--suite=wiki\|matrix --stamp`, `--pattern=A\|B\|C\|D\|E2\|I\|J`, `--table-counts`. Exit 0/1/2 | — |
| `scripts/cleanup-req001-testdata.mjs` (new) | R9. Dry run by default (SELECT only; `--template=` writes the approval file). Deletes only with `--delete` **and** `--approved=<file>`, in one transaction: `innodb_lock_wait_timeout=5`; `FOR UPDATE` re-check of every approved PK set (roots, children, orphans) against the approved ids; rollback on any difference; deletes in the design order with affected-row checks; in-transaction residue = 0; then COMMIT. No `UPDATE`, and no statement on users, activity_logs, role_permissions or refresh_tokens. **The delete path was never run.** | — |
| `scripts/verify-review-matrix.mjs` | R5: `:52` and `:74` → `hasPerform` only; comments updated; `hasSubmit` stays in the log line. No check removed | 36 |
| `scripts/verify-permissions.mjs` | R11.AC4: viewer `PUT ?id=<random uuid>` `{}` → 403 `Insufficient role`; qa1 same → 404. No check removed | 33 (34 if `:113` runs) |
| `scripts/verify-wiki.mjs` | R6 rewrite: all 48 existing checks kept (names and expected codes); section-8 grant/revoke via `PUT /api/permissions` as the fixture VP (+4); SQL precondition (exit 2); cleanup + 2 matrix + 5 residue checks; `--cleanup-stamp`; hooks `after-fixtures`, `section-5`, `after-grant`, `mid-cleanup-docs` | 64 |
| `scripts/verify-permission-matrix.mjs` | R7 port: precondition `role_permissions` = 0 rows (replaces the reset at `:61-66`); 6 SQL fixtures + a fixture module; no demo login; an explicit fixture reviewer on every submit; all 25 probes × 6 roles with stamped titles; toggle-restore check (+1); new round-trip order and hygiene; 10 cleanup + 2 matrix + 15 residue checks; `--cleanup-stamp`; hooks `after-fixtures`, `after-grant`, `mid-cleanup-content` | 193 |
| `scripts/verify-ui-gates.mjs` (new) | Q7: headless Chrome over CDP (Node's global WebSocket, no new dependency); profile `os.tmpdir()\tcms-ui-gates-<stamp>`; one browser context per role. Demo credentials are read from `seed.service.ts` at runtime (no new hard-coded copy, never printed). Precondition: 126 cells default, else exit 2. Kills only its spawned pid (`taskkill /PID <pid> /T /F`), proves no `chrome.exe` command line holds the profile, then deletes the profile | 159 |

Counts by code reading: wiki 43 + 7 + 2 + 5 + 2 + 5 = 64; matrix 2 + 1 + 150 + 1 + 10 + 2 + 2 + 10 + 15 = 193; ui-gates 66 + 18 + 10 + 6 + 15 + 15 + 20 + 6 + 3 = 159. The forced-failure counts FF-W1 12/1, FF-W2 57/1, FF-M1 30/1 and FF-M2 184/1 follow from where the hooks sit.

### 4.2 Deviations from 05-test-plan.md (no check weakened)

1. **The manifest is kept after a green run** (A0 says it is deleted). RES-1 and RES-2 need its entity ids to check notifications by entity after the users are gone. It holds ids only, under `os.tmpdir()\tcms-verify\`.
2. **R7 round-trip:** a 3.5 s wait follows each permission toggle, before the next probe. In `next dev`, other route bundles can serve a cached matrix for up to 3 s. No check changed.
3. **Check names:** the 4 new R6 PUT checks print the observed status, as the existing names do (`… -> 200 (must be 200)`).
4. **Failure-only checks:** `lock tcms_verify still owned by this run` and `cleanup completed` are printed **only** when they FAIL. A green run has exactly the pinned counts.
5. **R11.AC4 control run before the fix: NOT VERIFIED.** The server gate (49054b0) was already live when the checks were added.

### 4.3 Verification in this phase (raw)

```
$ node --check <each of the 12 new/changed script files>
(all 12: check-ok)

$ npx tsc --noEmit
tsc_exit=0

$ npx eslint .
C:\dev\tcms\src\components\shared\rich-text-editor.tsx
  46:5  warning  Unused eslint-disable directive (no problems were reported from 'react-hooks/exhaustive-deps')
✖ 1 problem (0 errors, 1 warning)
eslint_exit=0
(scripts/** are linted; eslint on the new/changed scripts alone → exit 0, no findings)

$ node scripts/audit-standards.mjs --self-test
PASS=12 FAIL=0          selftest_exit=0
$ node scripts/audit-standards.mjs
STANDARDS AUDIT: 0 violations across 193 TS files      audit_exit=0

static grep A2/A3 (ON CONFLICT | NOW() | INSERT IGNORE | db.<model>.<method> | $queryRaw`INSERT/UPDATE/DELETE | /tmp | execSync)
  on verify-wiki, verify-permission-matrix, lib/*, cleanup-req001-testdata, check-suite-residue, verify-ui-gates → 0 lines
grep "admin@tcms.com | @tcms.com'" in verify-permission-matrix.mjs → 0 lines
grep "UPDATE | DELETE FROM (users|activity_logs|role_permissions|refresh_tokens)" in the R9 script + libs → 0 lines
```

**DB guard and lock (P5, P8), read-only:**
```
$ DATABASE_URL='mysql://nobody:none@127.0.0.1:3306/tcms_test' node scripts/check-suite-residue.mjs --pattern=J
GUARD urlTargetOk=false (not connected)
NOT RUN: DB guard: DATABASE_URL does not point at 127.0.0.1:5500/tcms_test      exit=2
(same for 127.0.0.1:5500/other_db → exit=2)

# while a second process held GET_LOCK('tcms_verify') for 8 s:
$ node scripts/check-suite-residue.mjs --pattern=J
GUARD @@port=5500 DATABASE()=tcms_test urlTargetOk=true
NOT RUN: lock held: another verify/cleanup run holds 'tcms_verify'              checker_exit=2
# after release:
RESIDUE users=0
RESIDUE TOTAL=0                                                                  checker_exit_after_release=0
```

**RES-P1, the residue checker's positive control** (`evidence/res-p1-pattern-A.txt`, 2026-10-15T18:35:37Z; exit 1 = residue found):
```
RESIDUE modules=1 · test_cases=4 · bugs=2 · wiki_documents=1 · task_reports=0 · submodules=0
RESIDUE module_review_requests=1 · review_requests=3 · review_events=0 · test_case_history=0
RESIDUE bug_test_case_links=0 · crew_desk_links=0 · notifications=2
RESIDUE TOTAL=14
```
This matches QA doc lines 101-114 (module "QACHECK module 1792076976458", 4 cases, 2 bugs, 1 wiki). The checker is validated, so later "0" results count.

**R9 dry run 1** (`evidence/r9-dryrun-1.txt`, template `evidence/r9-dryrun-1.approved-template.json`, 2026-10-15T18:36:29Z, exit 0). Proof that it wrote nothing: `--table-counts` before and after are identical (`r9-dryrun-1.counts-before.txt` and `counts-after.txt`, empty diff; users=8, role_permissions=0, test_cases=13, review_requests=7, notifications=8, activity_logs=83, …). Counts per table:
```
modules=1 test_cases=8 bugs=3 wiki_documents=1 task_reports=2
submodules=0 module_review_requests=1 review_requests=7 review_events=0 test_case_history=0
bug_test_case_links=0 crew_desk_links=0 notifications=6   orphan_risk=0 group_j_users=0
GROUP G: role_permissions rows=0
```
Findings for the owner's approval of the list (R9.AC3). None of them is a script bug:
- **Group B matches 2 qa1 rows dated 2026-10-15.** `fc2f0e2f…` is the QA-check report (`report_date` 00:00, "QACHECK task", notes "QACHECK"). `c74e9549…` looks like **seed data** (`report_date` 2026-10-15T14:09:58.210Z, "Wrote test cases for login flow", 180 min). **It must be struck from the list.** Observation for the manager, not filed: qa1 has two `task_reports` rows for one calendar day. The seed row's `report_date` carries a time of day while the upsert writes midnight, so the unique key `(reported_by_id, report_date)` does not catch the pair. Not checked in the UI.
- **Group A reviews:** 1 module review `620acfe3…` (2 case reviews: tc1, tc2) plus 1 standalone case review for tc3 (`1eaacc37…`), so 3 `review_requests` in total. The QA doc says "1 module review + 1 case review". The tester reconciles this.
- **D-EMPTY:** the kept module review `11ceea3a…` (seed module "Authentication - Login") holds 4 case reviews: the 3 group C "Imported:" cases and the group D case. Deleting C and D leaves it with **0 case reviews**.
- Group I: no ids yet (`07-test-report.md` does not exist). Group J: none.

**R5, `verify-review-matrix`** (read-only, 2026-10-15T18:36:42Z–18:36:50Z, `evidence/suite-review-matrix-20261015T1836.txt`):
```
REVIEW-MATRIX RESULT: 36 passed, 0 failed      exit=0
(qa_engineer: module-reviews?action=all 403, GET /reviews 403 — the two former failures)
```

`GET http://localhost:3000/api` at the start and end of this phase: `{"status":"ok","service":"tcms-api"} http=200`.

### 4.4 Not run in this phase (phase 7, one serial window)

Not run: verify-wiki (64), verify-permission-matrix (193), verify-permissions (33), verify-import, verify-notifications, verify-ui-gates (159), the A9 forced-failure and recovery runs, A11 CONC/PRE, `npm run build` (worktree). The counts for these suites come from code reading only. **NOT VERIFIED:** the runtime behaviour of the new suites (CDP selectors, SIGINT in a Windows cmd console, the Prisma keepalive and lock over a long run) and the R11.AC4 pre-fix control.

### 4.5 SQL review requested (developer-backend, design 2.3 / 6)

Before the first phase 7 run, please review: `scripts/lib/db-guard.mjs`, `fixture-users.mjs`, `suite-data.mjs` (collect, residue, cleanup order), `r9-candidates.mjs` and `cleanup-req001-testdata.mjs` (delete transaction).
