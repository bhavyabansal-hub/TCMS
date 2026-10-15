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
