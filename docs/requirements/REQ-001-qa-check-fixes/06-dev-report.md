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

## 3. Frontend

_developer-frontend: to be added._
