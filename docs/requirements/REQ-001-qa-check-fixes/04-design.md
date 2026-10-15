# REQ-001 Low-Level Design

Authors: developer-backend (sections 0, 1 backend columns, 2, 4, 5, 6), developer-frontend (section 3 and frontend columns) · BRD version: 2 (approved with pins P1–P8; `decisions.md` D10–D13)

All `path:line` citations were opened in this run. No DB query was run and nothing was sent to :3000.

## 0. Scope, ownership and what this design touches

| Item | Owner (build) | developer-backend role |
|---|---|---|
| R1, R2, R3 (UI gates) | developer-frontend | none (server gates already correct, BRD §1) |
| R4 (docs) | manager under D11 | supplies the R11 wording for `docs/04-api-reference.md:206` and `CODEBASE-MAP.md:78` (section 2.1) |
| R5 `verify-review-matrix.mjs` | sdet | none |
| R6 `verify-wiki.mjs`, R7 `verify-permission-matrix.mjs` | sdet | SQL review: DB guard, lock, fixture-user INSERT (BE-R2), FK-ordered cleanup (section 2.3) |
| R8 `audit-standards.mjs` | sdet | none |
| R9 cleanup script, `check-suite-residue.mjs` | sdet writes the scripts | **designs the SQL** (section 2.2) and reviews it before the first dry run |
| R10 (running-app rules) | everyone | follows R10.AC1 (no start/stop of :3000) |
| **R11** PUT task-report gate | **developer-backend** | builds it (section 2.1); sdet adds the 2 suite checks (R11.AC4) |

| Touches | Answer |
|---|---|
| Schema / migration | **No.** No table, column or index change. `prisma/schema.prisma` and `prisma/migrations/` are not edited. |
| Auth | **No change.** `requireUser()` (`src/lib/auth.ts:150`) and `ensurePermission()` (`src/lib/auth.ts:186-188`) are reused as they are. |
| Permissions | **Yes, R11.** No new key. The existing key `create_task_report` is now also enforced on `PUT /api/task-reports?id=`. No `docs/03` matrix change (no route or key added). |
| Deletes | **Yes, R9 only**, by raw SQL in an sdet script. Gated: nothing is deleted before the owner's written go on the exact dry-run key list (D10, A2, R9.AC3). R6/R7 delete only their own stamped fixtures. |
| Shared server-side helper in `src/lib` | **None needed.** Scripts are plain `.mjs` and cannot import TypeScript from `src/` (no `tsx`/`ts-node` in `package.json`). The shared pieces for R6/R7/R9/residue live on the script side (section 2.3) and are owned by the sdet. |

## 1. Traceability

| BRD item | Backend parts | Frontend parts | Test ids |
|---|---|---|---|
| R1 | none (POST gate unchanged, `task-reports.service.ts:193`) | `tasks.tsx`: `isReadOnly` + notice pick + read-only empty state (3.1) | _tester/sdet: 05-test-plan.md_ |
| R2 | none | `dashboard-v2.tsx`: 9 `&&` gates + non-button `KpiCard` variant (3.2) | _05-test-plan.md_ |
| R3 | none (server 403s unchanged: `activity-logs.service.ts:31`, `:57`; `crewdesk.service.ts:122-126`) | `enabled: ... && can(...)` in `test-case-detail.tsx`, `integrations.tsx`, `activity-log.tsx`; Activity card hidden (3.3) | _05-test-plan.md_ |
| R4 | wording for AC8/AC9 lines (2.1 "Docs") | none | R4.AC8, R4.AC9 |
| R5 | none | none | R5.AC1–AC6 |
| R6 | SQL review: guard, lock, fixture INSERT, cleanup order (2.3) | none | R6.AC2, AC3, AC4, AC7, R10.AC11 |
| R7 | SQL review: same as R6 + notification-by-entity cleanup (2.3) | none | R7.AC2b, AC6, AC7, AC10, AC12 |
| R8 | none | none | R8.AC1–AC6 |
| R9 | SQL design of the cleanup (2.2) | none | R9.AC1–AC12 |
| R10 | guard + lock helper (2.3) | R10.AC4 (a)–(e): edit order and safeguards (3.5) | R10.AC1, AC10, AC11, AC13 |
| R11 | service gate (2.1) | none (UI does not call PUT, `tasks.tsx:395`) | R11.AC1–AC6 |

## 2. Backend (per API action)

### 2.1 R11 — `PUT /api/task-reports?id=` requires `create_task_report`

| Action | Method + URL | Validator | Service function | Repository function(s) | Permission | Errors |
|---|---|---|---|---|---|---|
| Update own report | `PUT /api/task-reports?id=<uuid>` | `validateUpdateTaskReportBody` (`task-reports.validation.ts:57-59`, unchanged) | `updateTaskReportFields` (`task-reports.service.ts:252-288`) | `findTaskReportById`, `updateTaskReport` (unchanged) | **new:** `create_task_report`; then ownership (unchanged) | 403 CSRF, 401, 400, **403 "Insufficient role"**, 404, 403 own-only (order below) |

**Code change (one line, service layer only).** First statement of `updateTaskReportFields`, before the lookup at `task-reports.service.ts:258`:

```ts
ensurePermission(me, 'create_task_report', 'Insufficient role')
```

Same call and message as POST (`task-reports.service.ts:193`). `ensurePermission` is already imported (`:10`). The JSDoc at `:248-251` gains one line: "Requires create_task_report (same gate as POST), checked before the lookup so a missing id does not reveal existence." The controller (`route.ts:54-63`), the validator and the repository are unchanged (agent.md §1 rules 9–10: the permission check belongs in the service).

**Status order after the fix (BE-R1).** The tester must not file a 400 for a bad request as a bug:

| # | Layer | Condition | Result | Where |
|---|---|---|---|---|
| 1 | `withApi` | no `X-Requested-With: tcms` and no matching Origin | 403 "Missing CSRF verification header" / "Cross-site request blocked" | `src/lib/api.ts:230`, `:169-210` |
| 2 | controller | no session | 401 | `route.ts:56` → `auth.ts:150-152` |
| 3 | controller | no `id` query param | 400 "Missing report id" | `route.ts:58` |
| 4 | controller | invalid body | 400 "Invalid input" + details | `route.ts:60` → `validation.ts:47-50` |
| 5 | service | caller lacks `create_task_report` (any id, existing or not) | **403 "Insufficient role"** (new) | new first line of `updateTaskReportFields` |
| 6 | service | report does not exist | 404 "Report not found" | `:258-259` |
| 7 | service | report belongs to another user | 403 "You can only edit your own reports" | `:260-262` |
| 8 | service | own report | 200 serialized report | `:264-287` |

So a viewer with a bad body gets 400 (step 4), not 403. R11.AC1 says "valid body", so the AC holds. `{}` is a valid body (`updateTaskReportSchema` is `.partial()`, `validation.ts:42`), so R11.AC4's probes can send `{}`; with a random UUID they write nothing.

**SQL.** No new SQL. Existing reads/writes are unchanged.

**Schema / migration.** None. Backward compatible: yes, only callers without `create_task_report` change from 200/404 to 403; the UI never calls PUT.

**Caching.** None. `can()` reads the override cache (3 s TTL, `permissions.ts:70`), refreshed on every `requireUser()` (`auth.ts:153-156`), so a VP toggle applies to PUT within the TTL (needed for R11.AC2).

**Logging, activity log, notifications.** The 403 is logged by `withApi` as the existing WARN line (no new log event). No `logActivity` row for a refused call (same as POST). No notification (PUT sends none today, `:258-288`).

**Concurrency.** Unchanged. A toggle racing a PUT is decided by the cache state at the time of the request (same as POST).

**Docs (edited by the manager under D11, wording supplied here).**
- `docs/04-api-reference.md:206` (R4.AC9): `PUT ?id=` 🛡 `create_task_report` + owner — "Update own report; 403 `Insufficient role` without `create_task_report` (checked first, any id), 404 `Report not found`, 403 `You can only edit your own reports`."
- `CODEBASE-MAP.md:78` (M2): unchanged text becomes true; optional precision "PUT `?id` (`create_task_report` + owner only)".

### 2.2 R9 — cleanup SQL design (script written by the sdet; SQL owned by this design)

**Name and modes.** `scripts/cleanup-req001-testdata.mjs` (plain Node, Windows, raw SQL only, R9.AC2d).
- Default (no flag) = **dry run**: SELECTs only, writes nothing, prints the list.
- `--delete --approved=<path-to-approved.json>` = delete run. Without both flags, no DELETE statement is reachable.
- Forbidden as tools or evidence: `scripts/cleanup-import-demo.mjs`, `scripts/check-overrides.mjs` (R9.AC12).

**Step 0 — DB guard, then lock (R9.AC2a, R10.AC11, Q18, P8).** Uses the shared helper in 2.3. The guard is the first statement. If `@@port` ≠ 5500, `DATABASE()` ≠ `tcms_test`, or the in-process `DATABASE_URL` check is false, abort with exit 2 before anything else. Then `GET_LOCK('tcms_verify', 0)`; if not 1, exit 2 ("another verify/cleanup run holds the lock").

**Step 1 — collect (dry run and delete run use the same SELECTs).** Groups per Q3/Q4/Q5/Q20:

| Group | In scope | Root selection (dry run only; the delete run uses PKs) |
|---|---|---|
| A | yes | `modules.name LIKE 'QACHECK%'`; `test_cases.title LIKE 'QACHECK%'`; `bugs.title LIKE 'QACHECK%'`; `wiki_documents.title LIKE 'QACHECK%'`; the 2 pending reviews come as cascade children of the case/module |
| B | **only if the owner keeps it on the list** | `task_reports` of `qa1@tcms.com` with `report_date` = 2026-10-15; printed with its `tasks` JSON and `notes` so the owner sees whether it holds QA-check text; flagged `B (owner decides)` |
| C | yes | `test_cases.title LIKE 'Imported: %'` (`verify-import.mjs:83`) |
| D | yes, **(a) only** | `test_cases.title LIKE 'Perm-verify case %'` (`verify-permissions.mjs:56`). Module reviews, the temp bug and seed statuses are **kept** (Q20 a) |
| E | no | `notif-verify-%@tcms-test.com` users stay soft-deleted (not listed for delete) |
| E2 | yes | `bugs.title LIKE 'Verify notification %'` (`verify-notifications.mjs:171-189`) |
| F | yes, cascades + entity notifications only | derived (below). **activity_logs are kept** (Q5, R9.AC7): no statement touches `activity_logs` |
| G | verify only | `SELECT COUNT(*) FROM role_permissions` printed (expected 0 = all 126 default); never written |
| H | no (Q4) | not selected |
| I | yes, by id | `task_reports.task_report_id IN (<ids from 07-test-report.md>)` passed as `--group-i=<id,id,id>` |
| J | listed only | users `wiki-%-%@tcms.test` and the R7 fixture pattern (named in `05-test-plan.md`), printed with counts of their authored rows and flagged `J`. **The R9 script deletes no user.** Recovery is the suite's own `--cleanup-stamp=<n>` (R6.AC9, R7.AC8), which follows Q14 (fixture activity_logs removed). This keeps R9 free of user deletes and of the activity_logs conflict with Q5 |

**Derived children (FK actions read from `prisma/migrations/20261015034822_init_mysql/migration.sql`).**

| Parent deleted | Child | FK action | Handling |
|---|---|---|---|
| module | submodules (`parent_id`) | CASCADE (`:318`) | listed by materialised path (below) |
| module (incl. descendants) | `module_review_requests` | CASCADE (`:348`) | listed |
| module_review_requests | `review_requests.module_review_id` | CASCADE (`:366`) | listed |
| module (incl. descendants) | `test_cases.module_id` | **SET NULL** (`:330`) | **orphan trap**: every case in the subtree must be on the approved list, else abort |
| module (incl. descendants) | `bugs.module_id` | **SET NULL** (`:381`) | same orphan rule |
| module (incl. descendants) | `crew_desk_links` | **no FK** | deleted explicitly by `link_id` (BE-R3), as the app does (`modules.repository.ts:144-148`) |
| test_case | `test_case_history` | CASCADE (`:342`) | listed |
| test_case | `review_requests` | CASCADE (`:357`) | listed |
| review_requests | `review_events` | CASCADE (`:369`) | listed |
| test_case / bug | `bug_test_case_links` | CASCADE (`:387`, `:384`) | listed |
| any entity | `notifications.entity_type/entity_id` | **no FK** | deleted explicitly by `notification_id` |
| any entity | `activity_logs.entity_id` | no FK | **kept** (Q5) |
| task_report | — | — | notifications `entity_type='task_report'` |

Notification entity mapping (from every `createNotification` call site): `test_case` → `test_case_id` (`test-cases.service.ts:232-233`); `review` → `review_request_id` (`reviews.service.ts:181-182`, `test-cases.service.ts:296-297`); `module_review` → `module_review_request_id` (`modules.service.ts:306-307`, `module-reviews.service.ts:235-246`, `reviews.service.ts:349-350`); `bug` → `bug_id` (`bugs.service.ts:139-140`, `:219-220`); `task_report` → `task_report_id` (`task-reports.service.ts:179-180`). Wiki and modules send none. Review ids must be collected **before** the delete, because they vanish with the cascade.

**Group D finding (for the owner's list approval, not a new question).** The Perm-verify case is created in the target submodule **before** the module submit (`verify-permissions.mjs:54-63`), so the kept module review normally contains a per-case review for it. Deleting the case cascades that one `review_requests` row and its events (`:357`, `:369`). The module review itself stays (Q20 a). The dry run prints, per affected module review, its remaining case-review count after the delete; a count of 0 is flagged `D-EMPTY` so the owner can strike that case from the list at approval.

**SQL shapes (parameterized; `Prisma.join` for id lists; no string concat).**

```sql
-- guard (first statement; see 2.3)
SELECT @@port AS port, DATABASE() AS db;
SELECT GET_LOCK('tcms_verify', 0) AS got;

-- roots (dry run): one per group, e.g.
SELECT module_id, name, path, created_at FROM modules WHERE name LIKE 'QACHECK%';
SELECT test_case_id, title, module_id, status, created_at FROM test_cases
 WHERE title LIKE ${prefix}  -- 'QACHECK%' | 'Imported: %' | 'Perm-verify case %'
SELECT bug_id, title, module_id, status, created_at FROM bugs WHERE title LIKE ${prefix};
SELECT wiki_document_id, title, author_id, created_at FROM wiki_documents WHERE title LIKE 'QACHECK%';
SELECT task_report_id, reported_by_id, report_date, total_minutes, tasks, notes FROM task_reports
 WHERE task_report_id IN (${Prisma.join(groupIIds)});

-- module subtree (root path '' → child path '.<root>' → '.<root>.<child>', modules.service.ts:160-167)
SELECT module_id, name, path FROM modules
 WHERE module_id IN (${roots})
    OR path = CONCAT(${rootPath}, '.', ${rootId})
    OR path LIKE CONCAT(${rootPath}, '.', ${rootId}, '.%');

-- orphan guard: must return 0 rows not already on the approved case/bug lists
SELECT test_case_id, title FROM test_cases WHERE module_id IN (${subtree});
SELECT bug_id, title FROM bugs WHERE module_id IN (${subtree});

-- children
SELECT module_review_request_id, module_id, status FROM module_review_requests WHERE module_id IN (${subtree});
SELECT review_request_id, test_case_id, module_review_id, status FROM review_requests
 WHERE test_case_id IN (${cases}) OR module_review_id IN (${moduleReviews});
SELECT review_event_id FROM review_events WHERE review_request_id IN (${reviewRequests});
SELECT history_id FROM test_case_history WHERE test_case_id IN (${cases});
SELECT bug_id, test_case_id FROM bug_test_case_links WHERE bug_id IN (${bugs}) OR test_case_id IN (${cases});
SELECT link_id, module_id, ticket_id FROM crew_desk_links WHERE module_id IN (${subtree});
SELECT notification_id, user_id, type, entity_type, entity_id FROM notifications
 WHERE (entity_type = 'test_case'     AND entity_id IN (${cases}))
    OR (entity_type = 'review'        AND entity_id IN (${reviewRequests}))
    OR (entity_type = 'module_review' AND entity_id IN (${moduleReviews}))
    OR (entity_type = 'bug'           AND entity_id IN (${bugs}))
    OR (entity_type = 'task_report'   AND entity_id IN (${taskReports}));
SELECT COUNT(*) AS n FROM role_permissions;   -- group G, printed only
```

(PKs confirmed in `migration.sql`: `review_events.review_event_id`, `test_case_history.history_id`, `bug_test_case_links (bug_id, test_case_id)`, `login_attempts.email`.) Empty id lists skip the statement (MySQL rejects `IN ()`).

**Dry-run output (R9.AC2).** Per group and per table: PK, identifying field (title / name / email / type), `created_at`, plus the flags `B (owner decides)`, `D-EMPTY`, `J (use --cleanup-stamp)`, `ORPHAN-RISK`. Then a count per table. The run also writes the same list as `approved.json` **template** (all keys, per table) next to the output; the owner's approval is that file with struck rows removed (R9.AC3). Any `ORPHAN-RISK` row makes the template invalid until the owner either adds the row or removes its module.

**Delete run (R9.AC2b, AC2c, AC4).** One interactive transaction on the guarded single connection:
1. `SET SESSION innodb_lock_wait_timeout = 5` (never hang on the live app).
2. `START TRANSACTION`.
3. For each table in the approved file: `SELECT <pk> FROM <table> WHERE <pk> IN (${approved}) FOR UPDATE`; then re-run the child and orphan SELECTs above with the **approved parent ids** (not the LIKE patterns) and `FOR UPDATE`. Compare **PK sets**, not only counts. Print `PASS`/`FAIL` per table. Any difference (a row gone, a new child such as a new review or history row, a new orphan) → `ROLLBACK`, exit 1, nothing deleted.
4. Deletes, each `WHERE <pk> IN (${approved})`, and each affected-row count compared with the approved count (direct rows only):
   1. `notifications` (by `notification_id`)
   2. `crew_desk_links` (by `link_id`)
   3. `bugs` (cascades `bug_test_case_links`)
   4. `test_cases` (cascades history, review_requests → review_events, links). **Before modules** (R9.AC2c).
   5. `wiki_documents`
   6. `task_reports` (groups I, and B only if approved)
   7. `modules` — the approved roots only; submodules and module reviews go by cascade.
5. In-transaction residue check: `SELECT COUNT(*)` for every approved PK of every table (parents **and** cascade children) must be 0. If not → `ROLLBACK`, exit 1.
6. `COMMIT`; `SELECT RELEASE_LOCK('tcms_verify')`; print per-table removed counts.

No statement touches `users`, `activity_logs`, `role_permissions`, `refresh_tokens` or any seed status (R9.AC6 a, AC7, AC8). No `UPDATE` exists in the script.

**Backup (R9.AC1).** The owner runs it, never an agent (credentials). Command shape (agreed, Q5): `mysqldump --protocol=TCP --host=127.0.0.1 --port=5500 --user=<user> -p --single-transaction --hex-blob --routines --triggers --no-tablespaces --set-gtid-purged=OFF --default-character-set=utf8mb4 --databases tcms_test --result-file=<path>`. Evidence recorded in `07-test-report.md`: path, size, the trailing `-- Dump completed` line, and exact per-table `COUNT(*)` (printed by `check-suite-residue.mjs --table-counts`, read-only). Still UNKNOWN (needed before phase 10, not now): `mysqldump.exe` on PATH and the user's SELECT/SHOW VIEW/TRIGGER rights.

**Timing (R9.AC10, A3).** Dry run and delete run in phase 10, after the last DoD run and the last tester write, before "RELEASE". Delete only after the owner's written go on the exact list (D10, D13).

### 2.3 Shared script-side helpers (R6, R7, R9, residue checker) — built by the sdet, SQL reviewed here

`scripts/lib/db-guard.mjs` (new, sdet):
- Builds one `PrismaClient` with the URL from `process.env.DATABASE_URL` plus `connection_limit=1`, so the `GET_LOCK` session and every later statement use the same connection (a session lock on one pooled connection does not protect statements on another).
- In-process URL check: `new URL(url)`; `hostname ∈ {127.0.0.1, localhost}`, `port === '5500'`, `pathname === '/tcms_test'`. Prints only `urlTargetOk=true|false`. Missing variable = false (fail closed). The URL is never printed.
- First statement `SELECT @@port AS port, DATABASE() AS db`; prints `@@port` and `DATABASE()`. Proceeds only if `db === 'tcms_test'`, `Number(port) === 5500` and `urlTargetOk` (Q18: no port mapping declared). Abort = exit 2.
- Then `SELECT GET_LOCK('tcms_verify', 0)`; 1 → continue; else exit 2. Released on exit (and implicitly when the process dies).
- Used by: R6, R7, the R9 script, `check-suite-residue.mjs` (P8).

`scripts/lib/fixture-users.mjs` (new, sdet) — fixture INSERT (BE-R2, R6.AC2, R7.AC10):

```sql
INSERT INTO users (user_id, email, full_name, password_hash, role, is_active,
                   notify_email, notify_telegram, notify_inapp, created_at, updated_at)
VALUES (${randomUUID()}, ${email}, ${name}, ${bcryptHash}, ${role}, 1,
        0, 0, 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3));
```

`notify_email = 0`, `notify_telegram = 0` stop delivery attempts to stamped addresses (schema defaults are true, `migration.sql` users table). In-app stays on (no asserted status depends on it either way). Passwords are generated in memory and never printed. `$executeRaw` for every write, no ORM call (replaces `verify-wiki.mjs:30`). The R7 signup viewer (when signup is open) keeps the defaults; it holds no `view_all_task_reports`, so it receives no report notifications.

**Fixture cleanup order (R6.AC4, R7.AC6), from the FK actions:**
1. Collect the run's entity ids first (cases, review_requests, module reviews, bugs, task_reports, wiki docs), because cascades erase them.
2. `notifications` by `entity_type`/`entity_id` of those ids (covers demo recipients, Q14/Q19).
3. RESTRICT content authored by fixtures: `bugs` (`reported_by_id`, `:375`), `test_cases` (`author_id`, `:333`; cascades their reviews/events, which also clears the RESTRICT `review_events.reviewer_id` `:372` and `review_requests.reviewer_id/requester_id` `:360-363`), remaining `review_requests`/`module_review_requests` by fixture reviewer/requester (`:351-354`), `wiki_documents` (`author_id`, `:399`), then `modules` owned/created by fixtures (`:321-324`). Cases before their module (SET NULL trap, `:330`).
4. `role_permissions` restore per R6.AC3 / P6 / S2 (rows written by the run only).
5. `activity_logs WHERE user_id IN (fixtures)` — **before** the users, because the FK is SET NULL (`:396`) and the rows would become unfindable.
6. `login_attempts` by fixture email (no FK), if any.
7. `users` by exact fixture ids; `task_reports` (`:390`), `notifications` (`:393`), `refresh_tokens` (`:315`) cascade.

Each step runs and reports on its own; a failed step does not skip later ones and forces a non-zero exit (R6.AC5).

### Schema / migration
- None. `notifications` has no `(entity_type, entity_id)` index; the cleanup lookups scan the table. Acceptable for `tcms_test` volumes and run once; no migration in REQ-001.

### Caching
| Cache key | Data | TTL | Invalidated by |
|---|---|---|---|
| permission overrides (`permissions.ts:70`) | `role_permissions` | 3 s | R11: read only. R6/R7 SQL restore: wait ≥ 3.5 s after the restore (R6.AC3). R9: not touched |
| stats cache (`stats.service.ts:37`) | dashboard counts | 5 s | R9 checks start ≥ 5 s after the delete (R9.AC5); no restart |

### Logging, activity log, notifications
- Log events: none new. R11's 403 is the existing `withApi` WARN line.
- logActivity entries: none new. R9 writes no activity rows and keeps all existing ones (Q5).
- Notifications: none new. R9 and R6/R7 cleanups delete notifications by entity as above.

### Concurrency
- R11: none new (see 2.1).
- R9: `GET_LOCK('tcms_verify', 0)` serializes it with the suites and the residue checker (P8); approved-PK `FOR UPDATE` re-count with set equality inside one transaction; any drift → rollback; 5 s lock-wait cap so the live app is never blocked for long. The tester's browser window stays procedural (R10.AC10).

## 3. Frontend (per page)

Author: developer-frontend. All `path:line` citations were opened in this run (`tasks.tsx`, `dashboard-v2.tsx`, `test-case-detail.tsx`, `integrations.tsx`, `activity-log.tsx`, `src/store/index.ts:33-42`, `providers.tsx:104-136`, `sidebar.tsx:47-54`, `eslint.config.mjs:22`, `src/types/index.ts:59`). No code was changed and nothing was sent to :3000.

**Scope of change.** Five view files under `src/components/views/` only. **No change** to `src/lib/client/api.ts`, `src/store/index.ts`, `providers.tsx`, `sidebar.tsx`, any route file under `src/app/(app)/**`, or any shared component. No new component, no new query key, no new client API function. No route or sidebar change (BRD §4).

**Gate mechanism (all items).** Gates read the existing `can` from `useAuthStore` (`src/store/index.ts:40`, `get().permissions.includes(...)`). `AuthGate` renders no view until `GET /api/auth` has filled `permissions` (`providers.tsx:136`), so `enabled: can(...)` never runs against an empty list, and a full load (C4) refreshes the snapshot. **No new React hook is added to any edited component**: every gate calls the `can` / `canReview` the component already reads (`tasks.tsx:101`, `dashboard-v2.tsx:128`, `:136`, `test-case-detail.tsx:40`, `integrations.tsx:57`, `activity-log.tsx:57`). This keeps each component's hook list unchanged, so Fast Refresh keeps local state on save (R10.AC4 support; the Q21 owner warning still applies). React Query does not refetch a disabled query on `invalidateQueries`, so `invalidateAfterMutation(qc, 'crewdesk')` and activity invalidations cannot fire a gated request.

| URL | File (route → view) | Gate (permission) | Sidebar | Components (new / reused) | Data calls + query key | States |
|---|---|---|---|---|---|---|
| `/tasks` | `src/app/(app)/tasks/page.tsx` → `src/components/views/tasks.tsx` | page: any user; edit: `create_task_report`; picker: `view_all_task_reports` (unchanged) | unchanged, everyone (`sidebar.tsx:52`) | reused: `Alert` (`:310`), `QueryErrorAlert` (`:318`), `TaskReportForm`, `TaskRowCard`. New: none (3 module-level string constants N1/N2/N3) | unchanged: `taskReportsApi.my` `['task-reports','my']` (`:112-116`), `usersApi.options` `['users','options']` (`:120-125`), `taskReportsApi.list` `['task-reports','user',id,date]` (`:127-137`), modules/test-cases/bugs (`:140-152`). `taskReportsApi.upsert` only reachable when editable (`:395`, `:422`, `:615`) | loading: skeleton (`:325-337`, unchanged); empty read-only: `No tasks logged for {YYYY-MM-DD}.`; empty editable: unchanged; error: `QueryErrorAlert` (unchanged, may sit next to one notice, P2); forbidden: n/a (read-only + N1) |
| `/dashboard` | `src/app/(app)/dashboard/page.tsx` → `dashboard-v2.tsx` | page: any user; buttons per gate map 3.2 | unchanged | reused: `Button`, `QuickAction`, `KpiCard` (gains a non-button branch inside the same function). New: none | unchanged: `['stats','dashboard']`, `['reviews','queue']` (`enabled: canReview`, `:136-141`), `['bugs','focus',userId]` | loading/error unchanged (`:154-168`); empty header group not rendered |
| `/test-cases/[id]` | `src/app/(app)/test-cases/[id]/page.tsx` → `test-case-detail.tsx` | page: any user; Activity card + query: `view_activity_logs` | unchanged | reused; Activity card (`:320-346`) rendered only with the permission (Q12) | `activityLogsApi.entity` `['activity','test_case',id]` gains `enabled: !!id && can('view_activity_logs')` (`:69-73`); other queries unchanged (`:45-88`) | without permission: card absent, no request; with: unchanged (incl. "No activity yet", B21 stays backlog) |
| `/integrations` | `src/app/(app)/integrations/page.tsx` → `integrations.tsx` | `manage_integrations` (gate unchanged at `:216-225`) | unchanged, `perm: 'manage_integrations'` (`sidebar.tsx:50`) | reused `PermissionDenied`, text unchanged | `crewdeskApi.config` `['crewdesk','config']` (`:68`), `crewdeskApi.list` `['crewdesk','links']` (`:69-72`), `crewdeskApi.emailCheck` `['crewdesk','email-check']` (`:73-77`) each gain `enabled: !!user && can('manage_integrations')`; `['modules','flat']` (`:67`) unchanged | forbidden: `PermissionDenied` (unchanged); others unchanged. `refreshAll` (`:207-211`) is only reachable from the permitted page |
| `/activity-log` | `src/app/(app)/activity-log/page.tsx` → `activity-log.tsx` | `view_activity_logs` (gate unchanged at `:97-99`) | unchanged, `perm: 'view_activity_logs'` (`sidebar.tsx:54`) | reused `PermissionDenied`, text unchanged | `activityLogsApi.list` `['activity-logs',params]` (`:88-92`) gains `enabled: !!user && can('view_activity_logs')`; `['users','options']` (`:69-73`) unchanged | forbidden: `PermissionDenied` (unchanged); loading/error/empty unchanged (`:231-233`) |

Form validation messages: none added or changed (the `handleSave` toasts at `tasks.tsx:425-455` are unchanged and unreachable in read-only mode).

### 3.1 R1 — `/tasks` (`src/components/views/tasks.tsx`)

**`TasksView` (replace `:182`):**
```ts
const canCreateReport = can('create_task_report')          // plain call, no new hook
const viewingOther = canViewAllReports && effectiveUserId !== user?.userId
const isReadOnly = !canCreateReport || viewingOther
const notice = viewingOther ? (canCreateReport ? N2 : N3) : !canCreateReport ? N1 : null
```
**Notice block (replace `:309-315`):** `{notice && <Alert><AlertDescription>{notice}</AlertDescription></Alert>}`, same `Alert` as today. Exactly one of N1/N2/N3 or none; the load-error alert (`:317-323`) is not a notice (pin **P2**) and stays independent.

Module-level constants (plain JS strings, so the straight `"` U+0022 and `'` U+0027 render exactly; `react/no-unescaped-entities` is off, `eslint.config.mjs:22`):
- `N1 = 'Your role can view work logs but cannot log work. A VP can enable "Create task reports" for your role under Permissions.'` (owner Q11; label matches `src/types/index.ts:59`)
- `N2 = "You are viewing another user's report. Switch back to yourself to make edits."` (same text as `:312` today)
- `N3 = "You are viewing another user's report."`

Four-row table → code:

| `create_task_report` | `view_all_task_reports` | Own log | Other user's log | Notice |
|---|---|---|---|---|
| yes | yes | `isReadOnly=false` | `viewingOther` → read-only | other: N2 |
| yes | no | `isReadOnly=false` | no picker (`:261`) | none |
| no | no | `isReadOnly=true` | no picker | own: N1 |
| no | yes (override) | `isReadOnly=true`, picker shown | read-only | own: N1, other: N3 |

**`TaskReportForm` (`:378-380`, `:551-567`):**
- Initial rows: `initialTasks.length ? initialTasks.map(withLinkType) : isReadOnly ? [] : [{ ...EMPTY_TASK }]`. Read-only users never get a blank disabled row; the editable path is unchanged.
- Empty state: when `isReadOnly`, render one line `<p className="text-sm font-medium">No tasks logged for {reportDate}.</p>`. No "No tasks logged yet" title, no "Add your first entry" line, no Add button. `reportDate` is the ISO `YYYY-MM-DD` state (`:104`), pin **P1** (e.g. `No tasks logged for 2026-10-01.`). Editable branch unchanged.
- "Export CSV" keeps `disabled={tasks.length === 0}` (`:539`). With `[]` it is disabled for R1.AC1(b) and enabled when saved entries exist (R1.AC4). "Export" (monthly, `:279-301`) unchanged.
- Already following `isReadOnly`, unchanged: Add task (`:543`, `:562`), Save (`:615`), remove (`:718`), row inputs (`:711`, `:744`, `:757`, `:783`, `:819`, `:882`), Notes (`:596`), `handleSave` guard (`:422`).

AC map: R1.AC1 (a)(b), AC2, AC6, AC7, AC8 by the table and empty state; AC3 because `upsert` is unreachable when read-only and PUT has no UI caller; AC4 by Export CSV; AC5 unchanged editable path.

### 3.2 R2 — `/dashboard` (`src/components/views/dashboard-v2.tsx`)

Gates use `can(...)` (`:128`) and `canReview` (`:136`). Each is a `&&` around the existing element; no element moves.

| Element (line) | Rendered only when |
|---|---|
| Header "New Test Case" (`:280-285`) | `can('create_test_case')` |
| Header "Report Bug" (`:286-292`) | `can('create_bug')` |
| Header "Reports" (`:293-301`) | unchanged `can('view_all_task_reports')` |
| Header wrapper `div` (`:279`) | at least one of the three keys above (R2.AC3: no empty gap) |
| QA "New Test Case" (`:682`) | `can('create_test_case')` |
| QA "Report Bug" (`:683`) | `can('create_bug')` |
| QA "Reviews" (`:684`) | `canReview` (= `perform_review`) |
| QA "Tasks", "Modules" (`:685-686`) | always |
| QA "Reports" (`:687`) | `can('view_all_task_reports')` |
| **Q10** KPI "My Pending Reviews" `onClick` (`:370`) | `canReview ? () => navigate('reviews') : undefined` |
| **Q10** Focus Queue "+ N more · view reviews" (`:661-670`) | `canReview && focusItems.length > focusShown.length` |
| **Q10** Latest Activity "View all" (`:699-701`) | `can('view_activity_logs')` |

Quick Actions stays `grid-cols-2` (`:681`): viewer 2 tiles (one row), developer 3, qa_engineer 4; no empty tiles.

**`KpiCard` (`:898-937`), R2.AC6.** When `onClick` is undefined, render a `<div>` with the same card classes minus `group`, `hover:-translate-y-0.5`, `hover:shadow-md`, and without the `ChevronRight` (`:930`); no `role`, no `tabIndex`, no `aria-label` (the label is visible text). With `onClick`, the current `<button>` markup is unchanged. DOM expectations for users without `perform_review`: (a) the card is a `div`, not focusable by Tab; (b) no `svg.lucide-chevron-right` inside it; (c) click: URL stays `/dashboard`, no `/api/reviews*` request (`['reviews','queue']` is disabled, `:140`); (d) value = `data.myPendingReviews`, same source as the hero chip (`:274`, `:362`). Positive case (vp/manager/product): `<button>` that opens `/reviews`. The other three KPI cards always pass `onClick`, so they are unchanged.

### 3.3 R3 — needless requests

| File:line | Change |
|---|---|
| `test-case-detail.tsx:72` | `enabled: !!id && can('view_activity_logs')` |
| `test-case-detail.tsx:320-346` | wrap the Activity `Card` in `{can('view_activity_logs') && (...)}` (Q12: not rendered) |
| `integrations.tsx:68`, `:69-72`, `:73-77` | add `enabled: !!user && can('manage_integrations')` to each (contiguous block, one edit) |
| `activity-log.tsx:88-92` | add `enabled: !!user && can('view_activity_logs')` |

Unchanged any-user queries: `test-case-detail.tsx:45-67`, `:75-88`; `integrations.tsx:67`; `activity-log.tsx:69-73`; global prefetches (`providers.tsx:114-134`: stats, modules tree, users options). These three files are the only callers of `activityLogsApi.*` and `crewdeskApi.config|list|emailCheck` (grep in this run, `src/**` excluding `api.ts`). The page gates (`integrations.tsx:216-225`, `activity-log.tsx:97-99`) and their texts stay as they are (R3.AC4, AC5).

### 3.4 Exact edit order (phase 6)

Lowest risk first; `tasks.tsx` last because it needs the owner warning. One complete save per file.

| # | File | Hunks | How it is saved |
|---|---|---|---|
| 1 | `activity-log.tsx` | 1 (`:88-92`) | one `Edit` |
| 2 | `integrations.tsx` | 1 (`:68-77`, contiguous) | one `Edit` |
| 3 | `test-case-detail.tsx` | 2 (`:72`, `:320-346`) | one write (see below) |
| 4 | `dashboard-v2.tsx` | 6 (header, KPI `:370`, focus link, QA grid, View all, `KpiCard`) | one write |
| 5 | **owner warning** → `tasks.tsx` | 4 (constants, `:182`, `:309-315`, `TaskReportForm` init + empty state) | one write, only after the facilitator confirms the owner saved or left any open /tasks log |

### 3.5 R10.AC4 hot-reload safeguards

- (a) **One save per file.** Multi-hunk files are produced by a small Node script in the session scratchpad that reads the file, applies each exact replacement in memory (each must match exactly once, else the script aborts and writes nothing) and saves the file with one `fs.writeFileSync`. No temp or backup file is created under `src/` (the dev watcher would compile it). Single-hunk files use one `Edit`.
- (b) Right after each file: `npx tsc --noEmit` and `npx eslint <file>`. On failure, one complete corrective save at once, then re-run both. The next file starts only after both pass.
- (c) Only the five view files above. `src/store/index.ts`, `providers.tsx`, `src/lib/client/api.ts`, `sidebar.tsx`, shared components and route files are not touched. No new hooks (see Gate mechanism), so Fast Refresh keeps component state.
- (d) Before step 5 the facilitator tells the owner to save or leave any open /tasks work log (Q21); I wait for that confirmation.
- (e) Route checks are read-only `GET`s: `GET http://localhost:3000/api` (200, `status: ok`) before and after, and `GET /dashboard`, `/tasks`, `/test-cases`, `/integrations`, `/activity-log` (expect 200 HTML). No start, stop, kill or restart of :3000; no login from my side.

### 3.6 Verification plan (frontend items)

| Item | Check (phase 6, developer-frontend) | Then (phase 7, tester / sdet `verify-ui-gates.mjs`, Q7) |
|---|---|---|
| R1 | tsc + eslint per file; `git diff` shows only the 4 hunks; text search proves N1/N2/N3 strings match the BRD byte for byte | per-role pass: viewer N1 + empty state `No tasks logged for 2026-10-01.` + Export CSV disabled + no POST/PUT; R1.AC7/AC8 toggles; product/qa2 saves |
| R2 | tsc + eslint; diff review of the gate map (R2.AC7 evidence is this code review, written in `06-dev-report.md`) | 6-role DOM table (R2.AC1), clicks (AC2), 400 px layout (AC3), toggles (AC4), KPI DOM checks (AC6 a–d), "View all" (AC8) |
| R3 | tsc + eslint; grep: every `activityLogsApi.*` and `crewdeskApi.config` / `.list` / `.emailCheck` call site has an `enabled` with the matching key | network capture per role and entry path (R3.AC1), 200s for holders (AC2), card hidden (AC3), PermissionDenied texts (AC4, AC5), R3.AC6 toggle, R3.AC7 log window |
| R10.AC4 | one save per file (Edit count / script log), tsc+eslint raw output per file, `GET /api` 200 before and after, owner confirmation before `tasks.tsx` | R10.AC6: testing starts only after `06-dev-report.md` says files are complete |
| DoD | `agent.md` §3 run after step 5; `npm run build` in the separate worktree (Q1) | raw output in `06-dev-report.md` |

## 4. Risks and rollback
- **R11:** callers without `create_task_report` change from 200/404 to 403. UI unaffected (no PUT caller). Rollback = revert the one-line commit; no data impact.
- **R9 deletes data.** Mitigations: owner backup first; dry run default; PK list approved in writing; in-transaction set re-check; orphan guard; residue check before COMMIT; no UPDATE, no user or activity_logs delete. Rollback = owner restores the backup (the script never retries on its own).
- **Group D cascade** removes one case review from a kept module review (flagged `D-EMPTY` if it empties it).
- **Prisma env loading:** whether `process.env.DATABASE_URL` is populated in a plain `node` script before the guard (Prisma loads `.env` itself) is NOT VERIFIED. The helper fails closed (`urlTargetOk=false`, exit 2), so the risk is a blocked run, not a wrong target.
- **`connection_limit=1`:** a long suite holds one connection for its whole run; acceptable for these scripts.

## 5. Open questions
- None for the owner. The R9 delete still needs the owner's written go on the exact dry-run key list (D10).
- For developer-frontend: none (section 3 filled; the only gate before `tasks.tsx` is the owner warning, Q21).

## 6. Verification plan (backend-owned and backend-reviewed items)

| Item | Check | Evidence |
|---|---|---|
| R11 | `npx tsc --noEmit`, `npx eslint .`, `npm run build` in the separate worktree (Q1), and DoD suites 4–7 | raw counts in `06-dev-report.md` |
| R11.AC4 | sdet adds to `verify-permissions.mjs`: viewer `PUT ?id=<random uuid>` body `{}` → 403 "Insufficient role"; holder (qa1) same call → 404. Run before the fix (expect the viewer check to FAIL: 404) and after (PASS) | both raw outputs |
| R11.AC1–AC3 | tester: status table in 2.1 with the CSRF header; R11.AC2 checked with `GET ?id=` (`route.ts:38`) | `07-test-report.md` |
| R11 code | `git diff` shows one added line + JSDoc in `task-reports.service.ts` only | `06-dev-report.md` |
| R6/R7 SQL | I review the sdet's guard, lock, fixture INSERT and cleanup order against 2.3 before the first run; text search for `ON CONFLICT`, `NOW()`, `INSERT IGNORE`, `db.<model>.` = 0 | review note in `06-dev-report.md` |
| R9 script | I review every SQL statement against 2.2 before the first dry run; dry run (no flags) proves no DELETE path ran (per-table counts unchanged via `check-suite-residue.mjs`); positive control P5 (group A found before R9); guard abort branch by code reading + printed guard line | phase 10 report |
| R9 delete | after the owner's go: script PASS per table, residue = 0 for every approved PK, `COUNT(*) FROM role_permissions` = 0, R9.AC5/AC9 read-only UI checks ≥ 5 s later | phase 10 report |

```
STATUS: Phase 5 Design (backend part) — done
FILES CHANGED: docs/requirements/REQ-001-qa-check-fixes/04-design.md (new; sections 0, 1 backend, 2, 4, 5, 6; section 3 placeholder for developer-frontend)
EVIDENCE: code and migration citations opened in this run (task-reports route/service/validation, auth.ts:150-188, api.ts:169-231, init_mysql migration.sql FK lines 315-402 and table DDL, modules.repository.ts:136-149, test-cases.repository.ts:184-193, modules.service.ts:160-167, createNotification call sites, verify-permissions.mjs:45-75, verify-notifications.mjs:45-52/165-195, verify-wiki.mjs:1-35/225-275). No code, DB query or :3000 request.
NOT VERIFIED: actual rows in tcms_test; Prisma populating process.env.DATABASE_URL in plain node scripts; whether any module review would be emptied by the group D delete (dry run shows it); mysqldump on PATH and DB user rights (owner, phase 10)
NEXT AGENT: developer-frontend — fill section 3 and the frontend column of section 1 in 04-design.md (R1–R3, P1/P2, R10.AC4); then sdet — 05-test-plan.md using sections 2.1 (R11.AC4 checks), 2.2 and 2.3 (script SQL contract)
```
