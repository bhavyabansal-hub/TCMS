# API Reference — every endpoint

> All endpoints live under `/api/*` in `src/app/api/**/route.ts`. Conventions:
> **query-param addressing** (`?id=`, `?action=`, auth also accepts `?path=`), JSON
> bodies, errors as `{ "error": "message" }` with proper status codes
> (400/401/403/404), list responses via `paginate()` = `{ data, page, pageSize, total,
> totalPages }`. Unless stated otherwise every endpoint requires the `tcms-access`
> JWT (401 `Unauthorized` otherwise).
>
> Legend: 🔓 no auth · 🛡 permission gate · 👑 ownership/extra check


> **⚠️ SEPTEMBER 2026 RESTRUCTURE:** every API resource now uses the layered
> architecture Controller (`route.ts`) → Validation (`*.validation.ts`) →
> Service (`*.service.ts`) → Repository (`*.repository.ts`, raw SQL only), with
> responses through `src/lib/api.ts` (`ok`, `paginate`, `ApiError`, `withApi`)
> and structured logging (`src/lib/logger.ts`). Entity keys in responses are
> renamed end-to-end (`id` → `userId`/`moduleId`/`testCaseId`/`bugId`/...).
> Unknown actions consistently return 400; search is case-insensitive
> (`LIKE` on `utf8mb4_unicode_ci`).

---

## 1. `GET /api` 🔓

Liveness check. Returns `{ "status": "ok", "service": "tcms-api" }`. No DB.

### 1b. `GET /api/ready` 🔓 — readiness (`ready/route.ts`)

200 `{ status: 'ready', database: 'ok', databaseLatencyMs, readOnly }` when the database
answers within 3 s; otherwise **503** `{ error: 'Not ready: the database is not answering' }`.
Use it for load-balancer / uptime checks and the go-live smoke test.

### 1c. Maintenance mode (`TCMS_READ_ONLY=true`)

Every API write (POST/PUT/PATCH/DELETE) answers **503** `{ error: 'TCMS is in read-only
maintenance mode — changes are paused, try again later.' }` before any work. Still open:
all GETs and `POST /api/auth?path=login|refresh|logout` (`src/lib/server/read-only.ts`).

### 1d. Login limits

Per email: 5 failures → 60 s lock (429, `login_attempts` table). Per client IP: 30 failed
sign-ins per 15 min (`TCMS_LOGIN_IP_MAX_FAILURES` / `_WINDOW_SECONDS`) → 429 `Too many
failed sign-ins from your network…` until the window ends, even with valid credentials
(in memory, single instance).

## 2. `/api/auth` — authentication (`src/app/api/auth/route.ts`)

Action dispatch: `?path=register | login | refresh | logout` (falls back to an
`x-action` header, unused by the client). Unknown action → 400 `Unknown action`.

| Endpoint | Auth | Request | Success response |
|---|---|---|---|
| `POST ?path=register` | 🔓 | `{ email, fullName(min 2), password(min 8), role? }` | `{ user, accessToken, refreshToken }` |
| `POST ?path=login` | 🔓 | `{ email, password }` | same |
| `POST ?path=refresh` | 🔓 | `{ refreshToken }` | `{ accessToken, refreshToken }` (rotated) |
| `POST ?path=logout` | 🔓 | `{ refreshToken }` | `{ "success": true }` |
| `GET /api/auth` | ✓ | — | `publicUser` (validated against DB) |
| `PUT /api/auth` | ✓ | profile fields **or** `?path=password` | `publicUser` / `{ "success": true }` |

Business rules:
- **register**: duplicate email → 400 `Email already registered`; **first user in an
  empty DB gets the `vp` role** (top of the hierarchy); otherwise the role is chosen
  from the 6-role list at signup.
- **login**: unknown email, deactivated user or wrong password all return the same 401
  `Invalid credentials` (no user enumeration).
- **refresh**: validates the `RefreshToken` row (exists ∧ not revoked ∧ not expired ∧
  JWT valid ∧ user active), revokes it, issues a fresh pair.
- **PUT (profile)**: only `fullName, avatarUrl, telegramChatId, notifyEmail,
  notifyTelegram, notifyInapp` are accepted — role/email are immutable here.
- **PUT ?path=password**: verifies `currentPassword`, requires `newPassword ≥ 8`.

Side effects: `CREATE/user` or `UPDATE/user` activity logs; `LOGIN` log on login.

## 3. `/api/seed` — demo data 🔓 (`seed/route.ts`)

**Security gate (new):** the endpoint answers **403** unless the deployment
sets `TCMS_ENABLE_SEED=true` in `.env`. Local/dev environments flip the flag
deliberately while seeding; production keeps it off so a fresh deployment can
never be seeded by a stranger. `GET` (browser-friendly) and `POST` behave
identically. **Idempotent**: if `user.count() > 0` →
`{ seeded: false, message: "Database already has users; skipping seed." }`.
Otherwise inserts 7 users, one per role plus a second QA (`admin@tcms.com` vp,
`teamlead@tcms.com` manager, `product@`, `developer@`, `qa1@`, `qa2@`, `viewer@tcms.com`,
with the documented passwords), sample modules, test cases, bugs and task reports. Returns
`{ seeded: true, users: […7 emails], modules, testCases, bugs, taskReports }` (counts).
No activity logs / notifications are produced by the seed.

## 4. `/api/stats` — aggregates (`stats/route.ts`) 🛡 any role

| Endpoint | Returns |
|---|---|
| `GET ?action=dashboard` | `{ totalTestCases, statusBreakdown[{status,count}], openBugs, severityBreakdown[{severity,count}], myPendingReviews, recentActivity(10, with user; summaries without snapshots, IP or user agent — full feed with `view_activity_logs`, else own rows) }` |
| `GET ?action=reports` 🛡 `view_all_task_reports` | `{ testCasesByStatus, testCasesByPriority, bugsByStatus, weeklyHours[{user,week,minutes,hours}] }` — last 30 days, Sunday-based weeks |

`openBugs` counts `status ∈ ['open','in_progress']`; `myPendingReviews` counts reviews
where I am reviewer and status ∈ pending/in_progress. Quirk: an unknown action here
returns **200** `{ error: 'Unknown action' }` (elsewhere it's 400).

## 5. `/api/modules` — module tree (`modules/route.ts`)

| Endpoint | Auth rules | Behaviour |
|---|---|---|
| `GET` | any role | `{ tree, flat }` — `flat`: every module once (no `children`), with `owner` and `testCaseCount` (whole subtree); cached server-side (cleared by every write). The client builds the nested tree from `flat` (`modulesApi.tree()`); `tree` is deprecated, kept for open tabs on the previous client (backlog B30) |
| `GET ?id=` | any role | `{ module (incl. owner/createdBy/updatedBy/permissions), testCases (desc by updated), submodules }`; 404 `Module not found` |
| `POST` 🛡 `create_module` | body `{ name(min 1), description?, parentId? }` | Root: `path=''`, depth 0. Child: parent 404-checked; `path=parent.path + '.' + parentId`, `depth+1`. **`ownerId` is never taken from the client — owner = creator.** Logs `CREATE/module` |
| `PUT ?id=` 🛡 `edit_module` | body `{ name?, description?, ownerId? }` | Ownership transfer allowed; `createdById` immutable (governs delete rights). Sets `updatedById`. Logs `UPDATE/module` with before/after |
| `PUT ?id=&action=submit-review` 🛡 `submit_review` | body `{ reviewerId?, dueDate?, includeSubmodules=true }` | **Module-level review** — see below |
| `DELETE ?id=` 🛡 | creator **or** `edit_module`; else 403 `Only the creator of this module or a role with edit-module rights can delete it.` | **Hard delete**; DB cascades children/permissions/module reviews; cases get `moduleId=null`. Logs `DELETE/module` |

### `action=submit-review` step by step

1. Resolve reviewer: body `reviewerId` → else the first **active** manager (then VP),
   never the submitter → none: 400 `No reviewer available. Assign a VP or Manager.`
2. Target set = module (+ all descendants when `includeSubmodules` — iterative stack walk).
3. Eligible cases = in targets ∧ `status ∈ ['draft','needs_revision']`; none → 400
   `No eligible test cases (draft or needs_revision) found in this module.`
4. `cycle = max(existing module cycles) + 1` → create `ModuleReviewRequest(pending)`;
   `createMany` child `ReviewRequest` per case (same cycle, `moduleReviewId` set);
   `updateMany` cases → **`in_review`**.
5. Log `REVIEW_SUBMITTED/module`; notify reviewer (`review_assigned`, entityType
   `module_review`). Returns `{ moduleReview, caseReviewCount, testCaseIds }`.

## 6. `/api/test-cases` — the core domain (`test-cases/route.ts`)

| Endpoint | Auth rules | Behaviour |
|---|---|---|
| `GET` list 🛡 any | params `page(1)`, `pageSize(20)`, `moduleId`, `status`, `priority`, `authorId`, `search` | `paginate` of serialized cases, fixed sort `updatedAt desc`. `search` = title `LIKE` (case-insensitive on MySQL 8.4 utf8mb4_unicode_ci) |
| `GET ?action=options` | any | Light picker list `[{ testCaseId, title }]`, newest first, `limit` 1–500 (default 500) — e.g. the work-log link picker |
| `GET ?id=` | any | single serialized case; 404 `Test case not found` |
| `GET ?id=&action=history` | any | `TestCaseHistory[]` (version desc, with `changedBy`) — snapshots parsed |
| `GET ?id=&action=reviews` | any | `ReviewRequest[]` for the case (with reviewer/requester/events) |
| `POST` 🛡 `create_test_case` | body `{ moduleId?, title(min 1), description?, preconditions?, steps[] (default []), expectedResult?, priority (default P2), tags[] (default []), assigneeId? }` | Creates with `status:'draft'`, `authorId = me`, `version 1`. Logs `CREATE/test_case` |
| `PUT ?id=` 🛡 | `edit_any_test_case` ∨ (author ∧ `edit_own_test_case`); else 403 `You can only edit your own test cases` | **Versioned update** — see below |
| `PUT ?id=&action=submit-review` 🛡 `submit_review` | body `{ reviewerId?, dueDate? }` | **Single-case review** — see below |
| `DELETE ?id=` 🛡 | author ∨ `delete_test_case` | **PERMANENT delete**: hard `DELETE` — cascades wipe history, review requests and bug links; activity log rows kept for audit. Logs `DELETE/test_case` |

### Regular PUT (versioned update) — the heart of case editing

1. Fetch case (404 first), then permission check (above).
2. **Snapshot the *current* state** into `TestCaseHistory` (`version = tc.version`,
   `changedById = me`, summary `"Updated: <new title>"` if the title changes, else
   `"Field update"`).
3. Update with `version: tc.version + 1`, `lastEditedById = me`, partial fields.
4. **Status is never touched by an edit** (approved stays approved).
5. Logs `UPDATE/test_case` with full serialized before/after (diff computed server-side).
6. If `assigneeId` changed → notify new assignee (`test_case_updated`).

### `action=submit-review`

Reviewer resolution: body `reviewerId` → case `assigneeId` → first active
manager, then VP (400 `No reviewer available. Assign a reviewer first.`).
Refused with 400 when the case is already `in_review` or `approved`; the case's old
open review is closed in the same transaction (one open review per case).
`cycle = max(case review cycles) + 1` → create `ReviewRequest(pending)`; case →
**`in_review`** (version NOT bumped). Logs `REVIEW_SUBMITTED/test_case`; notifies
reviewer (`review_assigned`, entityType `review`). Returns the review row.

## 7. `/api/reviews` — single-case reviews (`reviews/route.ts`)

| Endpoint | Auth rules | Behaviour |
|---|---|---|
| `GET ?action=queue` 🛡 any | — | My open queue (`reviewerId = me`, status pending/in_progress), with testCase/author/module summary |
| `GET ?id=` 🛡 `perform_review` | — | Full detail: review + testCase + reviewer + requester + events |
| `GET` (list) 🛡 `perform_review` | — | All reviews, paginated (pageSize 50), filters `status`, `reviewerId`, `testCaseId` |
| `POST ?id=` 🛡 `perform_review` 👑 | assigned reviewer only (no VP bypass); else 403 `Only the assigned reviewer can submit a verdict for this review`; 409 when `expectedUpdatedAt` is stale | **Verdict** — see below |

### Verdict (`POST ?id=`)

Body: `{ verdict: 'approved'|'failed'|'needs_revision', comment?, flaggedFields[] }`.
Rule: **comment required unless approved** → 400 `Comment is required when verdict is not "approved"`.

1. Create `ReviewEvent { verdict, comment, flaggedFields }`.
2. ReviewRequest status: `needs_revision` → `in_progress` (stays open for the rework
   loop); `approved`/`failed` → `completed`.
3. TestCase status: `approved` → `approved`; `failed` **or** `needs_revision` → `needs_revision`.
4. Log `REVIEW_VERDICT/test_case` (before: old case status; after: new status + verdict).
5. Notify the **author** (`review_approved` / `review_failed` /
   `review_needs_revision`), body includes the verdict comment.
6. **Module aggregation**: if this review has `moduleReviewId` → check all siblings;
   every sibling `completed` ⇒ parent module review → `completed` + notify its
   requester (`review_approved`, title `Module review completed`); otherwise parent →
   `in_progress`.
7. Returns `{ event, reviewStatus, testCaseStatus, moduleReviewCompleted? }`.

## 8. `/api/module-reviews` — bulk reviews (`module-reviews/route.ts`)

| Endpoint | Auth rules | Behaviour |
|---|---|---|
| `GET ?action=queue` | any | Mine, pending/in_progress, with `module` + `_count.caseReviews` |
| `GET ?action=all` 🛡 `perform_review` | — | Latest 100 with module/reviewer/requester + counts; else 403 `Only roles with perform-review rights can view all module reviews` |
| `GET ?id=` 🛡 `perform_review` | — | Detail: module, reviewer, requester, **caseReviews[]** each embedding full serialized testCase + events |
| `POST ?id=&action=approve-all` 🛡 `perform_review` 👑 | assigned reviewer only; 409 stale | **Bulk approve** — see below. A bulk verdict notifies each person once (an author who also requested the review gets one notification) |

### Bulk approve

Body `{ comment? }` (default `"Bulk approved with module review."`). Pending set =
case reviews not `completed`; empty → 400 `No pending case reviews to approve.`
For each: `ReviewEvent(approved, comment)` → review `completed` → its case →
**`approved`**. Parent module review → `completed`. Logs
`REVIEW_VERDICT/module_review`; notifies requester (`review_approved`, title
`Module review approved`). Returns `{ approvedCount, moduleReviewStatus: 'completed' }`.

## 9. `/api/bugs` — bug tracker (`bugs/route.ts`)

| Endpoint | Auth rules | Behaviour |
|---|---|---|
| `GET` list | any | `page(1)`, `pageSize(100)`, filters `status`, `severity`, `moduleId`, `assignedToId`, `reportedById`, `search` (title contains, case-insensitive); sort `createdAt desc` |
| `GET ?action=options` | any | Light picker list `[{ bugId, title }]`, newest first, `limit` 1–500 (default 500) |
| `GET ?id=` | any | Bug + module + reportedBy + assignedTo + testCaseLinks |
| `GET ?id=&action=links` | any | `BugTestCaseLink[]` with testCase summaries |
| `POST` 🛡 `create_bug` | body `{ title, description?, severity(default medium), environment?, stepsToReproduce?, expectedBehaviour?, actualBehaviour?, moduleId?, assignedToId?, testCaseIds[] }` | `reportedById = me`; optional test-case links. An `assignedToId` additionally needs `assign_bug` (403 otherwise). Logs `CREATE/bug`; if assigned → notify assignee (`bug_assigned`) |
| `PUT ?id=` | `create_bug` **or** `assign_bug` for fields; **`assign_bug` required only when `assignedToId` changes the assignee** (re-sending the current one is a no-op); 409 when `expectedUpdatedAt` is stale | Partial update: only the fields sent change (no defaults are re-applied). Status `resolved`/`closed` ⇒ server stamps `resolvedAt = now()`. Logs `UPDATE/bug` (full before/after); assignee change → `bug_assigned` notification |
| `PUT ?id=&action=link-tc` | `create_bug` ∨ `assign_bug` | Body `{ testCaseId }` → create link (duplicate-safe); always `{ "success": true }` |
| `DELETE ?id=` 🛡 `delete_bug` | vp + manager by default | **Hard delete** (links cascade). Logs `DELETE/bug` |

Any bug participant (`create_bug` or `assign_bug`) can drag a card across the Kanban
board; changing the assignee and deleting are gated separately.

## 10. `/api/task-reports` — daily work log (`task-reports/route.ts`)

| Endpoint | Auth rules | Behaviour |
|---|---|---|
| `GET ?action=my` | self | All my reports (desc by date), serialized |
| `GET ?action=summary` 🛡 `view_all_task_reports` | — | Per-user aggregates for a date range (default last 30 days): `{ users: [{ userId, userName, totalMinutes, days, hours }] }` |
| `GET ?id=` 👑 | owner ∨ `view_all_task_reports` | Single report; else 403 `You can only view your own reports` |
| `GET` list | any | Without `view_all_task_reports` force-filtered to own rows; holders may pass `userId`; filters `dateFrom`, `dateTo`, `moduleId` (substring match inside the tasks JSON — heuristic) |
| `POST` 🛡 `create_task_report` | body `{ reportDate, tasks[] (default []), notes? }` | **Upsert by (me, reportDate)** — unique constraint; recomputes `totalMinutes`. Logs `CREATE` or `UPDATE/task_report` |
| `PUT ?id=` 🛡 `create_task_report` + 👑 | `create_task_report` **and** owner only — even VPs | Partial update (only the fields sent change), recomputes total. Logs `UPDATE/task_report`. 403 `Insufficient role` without `create_task_report` (checked first, any id), 404 `Report not found`, 403 `You can only edit your own reports` |

`tasks[]` item validation: `{ description(min 1), timeSpentMinutes(int ≥0), moduleId?,
testCaseId?, bugId?, status: done|in_progress|blocked }`.

## 11. `/api/activity-logs` — audit trail (`activity-logs/route.ts`)

| Endpoint | Auth rules | Behaviour |
|---|---|---|
| `GET` full list 🛡 `view_activity_logs` | — | `page(1)`, `pageSize(50)`, filters `userId`, `entityType`, `action`, `dateFrom`, `dateTo`; desc; snapshots/diff parsed |
| `GET ?action=entity&type=&id=` 🛡 `view_activity_logs` | 403 otherwise | Latest 50 logs for one entity (used by the case-detail Activity card) |
| `GET ?action=user&id=` 🛡 `view_activity_logs` | 403 otherwise | Latest 50 logs by one user |

## 12. `/api/notifications` — the bell (`notifications/route.ts`)

Everything is scoped to the logged-in user.

| Endpoint | Behaviour |
|---|---|
| `GET` | My notifications, paginated (pageSize 50), optional `isRead=true|false` filter |
| `POST ?action=read-all` | `updateMany` my unread → read; `{ "success": true }` |
| `PATCH ?id=` | Mark one read; owner check → 403 `Not your notification` |
| `DELETE ?id=` | Hard delete one of my notifications |

## 13. `/api/users` — user management 👑 (`users/route.ts`)

**Every method** requires `manage_users` (vp + manager by default). `GET ?action=options`
(picker rows: names + roles, no emails) is open to every signed-in user.

**Role rules:** only a VP may create an account with a role other than `viewer`
(403 `Only a VP can create accounts with a role other than viewer`) or change a role
(403 `Only a VP can change roles`); nobody changes their own role (403).

| Endpoint | Behaviour |
|---|---|
| `GET` | Paginated `publicUser`s (pageSize 50), filters `role`, `isActive`; sort `createdAt asc` |
| `POST` | Invite: `{ email, fullName(min 2), password(min 8), role }`; duplicate email → 400 `Email already registered`. Logs `CREATE/user` |
| `PUT ?id=` | `{ fullName?, role?, isActive?, avatarUrl? }`. Logs `UPDATE/user` (before/after role+active+name) |
| `DELETE ?id=` | **Soft delete**: `isActive: false`; self-delete → 400 `Cannot delete yourself`. Logs `DELETE/user` |

## 14. `/api` and `/api/ready` — health 🔓

`GET /api` is the liveness check. `GET /api/ready` also checks the database
(`SELECT 1`) and answers 503 when it is down — use it for load-balancer readiness.

## 14b. `/api/integrations/crewdesk` — Crew Desk link management 🔒 (`integrations/crewdesk/route.ts`)
| Method + path | Who | Validation | Service |
|---|---|---|---|
| `GET ?path=status` | any authenticated user | — (config projection, non-secret) | `getCrewDeskStatus` |
| `GET ?path=links` | any authenticated user (own links; broader sees module-scoped rows) | query whitelist | `listCrewDeskLinks` |
| `GET ?path=comment&linkId=` | link owner or manage rights | `validateRetryLinkId` | `buildCommentForLink` (copy-path text) |
| `POST ?path=retry&linkId=` | link owner or manage rights | `validateRetryLinkId` | `retryCrewDeskLink` |
| `POST` (create link) | module link rights via `can('manage_integrations')`-family checks + module-permission gate in service | body validated in service (moduleId/ticketId/note) | `createCrewDeskLink` |

Modes: `manual` (zero Crew Desk calls) / `test` (comments ONLY to the designated
ticket **1355** — hard guard) / `live`. Email verification against the Crew Desk
user list runs per-user at posting time (10-min list cache). Mock: `127.0.0.1:3010`.

## 14c. `/api/permissions` — VP permission matrix 🔒 (`permissions/route.ts`)
| Method | Who | Validation | Service |
|---|---|---|---|
| `GET` | `manage_permissions` (VP by default) | — | `getPermissionMatrix` (`ensurePermission` in service) |
| `PUT` | `manage_permissions` | `validateTogglePermissionBody` | `togglePermission` (+ cache invalidation) |

## 14d. `/api/search` — global search 🔓 any authenticated user (`search/route.ts`)
| Method | Who | Validation | Service |
|---|---|---|---|
| `GET ?q=&limit=` | any authenticated user | `validateSearchQuery` (q length cap, limit clamp) | `globalSearch` (modules/test-cases/bugs/wiki, parameterized `LIKE`) |

## 14e. `/api/wiki` — wiki documents 🔒 per-action (`wiki/route.ts`)
| Method | Who | Validation | Service |
|---|---|---|---|
| `GET` list/detail/download | any authenticated user | query whitelist (kind/id/action) | `listWikiPaginated` / `getWikiDocument` / `getWikiFileDownload` |
| `POST` written doc | `create_wiki_doc` | `validateCreateWikiDocBody` | `createWrittenWikiDoc` |
| `POST` uploaded file | `create_wiki_doc` | multipart branch → upload validation | `createUploadedWikiDoc` |
| `PUT ?id=` | `edit_own_wiki_doc` / `edit_any_wiki_doc` (owner check in service) | `validateUpdateWikiDocBody` | `updateWikiDoc` |
| `DELETE ?id=` | `delete_wiki_doc` | — | `deleteWikiDoc` |

## 15. Response envelope examples

```jsonc
// GET /api/test-cases?status=draft&page=1
{ "data": [ { "id": "clx…", "title": "…", "steps": [ { "stepNumber": 1, "action": "…", "expected": "…" } ],
    "tags": ["smoke"], "status": "draft", "priority": "P2", "version": 3,
    "module": { "id": "…", "name": "Authentication - Login" }, "author": { "id": "…", "fullName": "Quinn Tester" },
    "lastEditedBy": null, "assignee": null } ],
  "page": 1, "pageSize": 20, "total": 1, "totalPages": 1 }

// POST /api/reviews?id=… (verdict)
{ "event": { "id": "…", "verdict": "needs_revision", "comment": "…", "flaggedFields": ["Steps unclear"] },
  "reviewStatus": "in_progress", "testCaseStatus": "needs_revision" }
```

## 15b. Concurrent edits — optimistic locking (409)

Two users editing the same record never silently overwrite each other
(`src/lib/server/optimistic-lock.ts`). These writes accept an optional body field
`expectedUpdatedAt` = the record's `updatedAt` the client loaded (ISO date-time):

| Write | Guard |
|---|---|
| `PUT /api/test-cases?id=` | loaded `updatedAt` + server-side `version` |
| `PUT /api/bugs?id=` (form and Kanban drag) | `WHERE updated_at = expected` |
| `PUT /api/modules?id=` | `WHERE updated_at = expected` |
| `POST /api/reviews?id=` (verdict), `&action=forward` | `WHERE status <> 'completed' AND updated_at = expected` |
| `POST /api/module-reviews?id=&action=bulk-verdict` / `approve-all` | module review row, same guard, taken first |

If the record changed since it was loaded the answer is **409**
`{ "error": "This item was changed by someone else — reload" }` and nothing is written.
Without `expectedUpdatedAt` (older clients) the server guards with the value it read
in the same request, so two simultaneous saves still produce one 200 and one 409.
A malformed value → 400. The guarded UPDATE runs before any child insert (history,
review events), so parallel saves wait for each other instead of deadlocking.
Race test: `node scripts/verify-concurrency.mjs` → `34 passed, 0 failed` (2026-10-16).

## 15c. Database errors → API errors (`src/lib/server/db-errors.ts`, used by `withApi`)

The client never sees SQL text, table/column names or driver messages; the original
error goes to the server log only (`logs/app-*` warn line with the MySQL errno, or
`logs/error-*` for 503s).

| MySQL / Prisma | Status | `error` |
|---|---|---|
| 1062 duplicate key (P2002) | 409 | This record already exists — one of its values must be unique. |
| 1451 row still referenced | 409 | This item is still used by other records and cannot be removed. |
| 1452 referenced row missing (P2003) | 400 | A referenced item does not exist — check the selected module, user or test case. |
| 1406 data too long (P2000) | 400 | A value is too long for its field. |
| 1048 NOT NULL · 1264 out of range · 1366/1292/3140 bad value | 400 | A required value is missing. / A value is out of range. / A value has the wrong format. |
| 1213 deadlock · 1205 lock wait timeout | 409 | Someone else is saving the same item right now — try again. |
| P2024 pool timeout | 503 | The server is busy — try again in a moment. |
| P1001/P1002/P1017, 2002/2003/2006/2013, init error | 503 | The database is unavailable — try again shortly. |
| anything else | 500 | Internal server error |

`POST /api/task-reports` keeps its upsert contract under a race: the loser of the
unique (user, date) insert is retried as an update (6 parallel saves → 6 × 200).
Verifier: `node scripts/verify-db-errors.mjs` → `21 passed, 0 failed` (real MySQL
errors raised in rolled-back transactions + live upsert race).

## 16. Known quirks (documented on purpose)

1. `stats` unknown action → 200 with `{error}` (everywhere else 400).
2. `search` filters are case-insensitive (`LIKE` on `utf8mb4_unicode_ci`).
3. Task-report date uniqueness is on the stored datetime — the client normalises dates
   to `YYYY-MM-DD` (timezone-safe `todayISO()`), so in practice one row per calendar day.
4. The Reports view's date inputs are currently cosmetic (not sent to the API).
