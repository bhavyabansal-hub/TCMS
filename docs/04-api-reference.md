# 04 · API Reference — every endpoint

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
> Unknown actions now consistently return 400; search is case-insensitive
> (`ILIKE`). Details: `REFACTORING-REPORT.md`.

---

## 1. `GET /api` 🔓

Health check. Returns `{ "message": "Hello, world!" }`. No DB.

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
Otherwise inserts exactly: 4 users (admin/teamlead/qa1/qa2 with the documented
passwords), 9 modules (3 roots × login+validation children), 5 test cases (one in each
key status), 3 bugs, 2 task reports. Returns
`{ seeded: true, users: […4 emails], modules: 9, testCases: 5, bugs: 3, taskReports: 2 }`.
No activity logs / notifications are produced by the seed.

## 4. `/api/stats` — aggregates (`stats/route.ts`) 🛡 any role

| Endpoint | Returns |
|---|---|
| `GET ?action=dashboard` | `{ totalTestCases, statusBreakdown[{status,count}], openBugs, severityBreakdown[{severity,count}], myPendingReviews, recentActivity(10, with user) }` |
| `GET ?action=reports` 🛡 `view_all_task_reports` | `{ testCasesByStatus, testCasesByPriority, bugsByStatus, weeklyHours[{user,week,minutes,hours}] }` — last 30 days, Sunday-based weeks |

`openBugs` counts `status ∈ ['open','in_progress']`; `myPendingReviews` counts reviews
where I am reviewer and status ∈ pending/in_progress. Quirk: an unknown action here
returns **200** `{ error: 'Unknown action' }` (elsewhere it's 400).

## 5. `/api/modules` — module tree (`modules/route.ts`)

| Endpoint | Auth rules | Behaviour |
|---|---|---|
| `GET` | any role | `{ tree, flat }` — every module with `owner`, `testCaseCount` (groupBy), nested `children` |
| `GET ?id=` | any role | `{ module (incl. owner/createdBy/updatedBy/permissions), testCases (desc by updated), submodules }`; 404 `Module not found` |
| `POST` 🛡 `create_module` | body `{ name(min 1), description?, parentId? }` | Root: `path=''`, depth 0. Child: parent 404-checked; `path=parent.path + '.' + parentId`, `depth+1`. **`ownerId` is never taken from the client — owner = creator.** Logs `CREATE/module` |
| `PUT ?id=` 🛡 `edit_module` | body `{ name?, description?, ownerId? }` | Ownership transfer allowed; `createdById` immutable (governs delete rights). Sets `updatedById`. Logs `UPDATE/module` with before/after |
| `PUT ?id=&action=submit-review` 🛡 `submit_review` | body `{ reviewerId?, dueDate?, includeSubmodules=true }` | **Module-level review** — see below |
| `DELETE ?id=` 🛡 | `admin`/`team_lead` **or** creator; else 403 `Only the creator of this module or a senior manager (team lead / admin) can delete it.` | **Hard delete**; DB cascades children/permissions/module reviews; cases get `moduleId=null`. Logs `DELETE/module` |

### `action=submit-review` step by step

1. Resolve reviewer: body `reviewerId` → else first **active** user with role
   `team_lead`/`admin` → none: 400 `No reviewer available. Please assign a team lead.`
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
team_lead/admin (400 `No reviewer available. Assign a reviewer first.`).
`cycle = max(case review cycles) + 1` → create `ReviewRequest(pending)`; case →
**`in_review`** (version NOT bumped). Logs `REVIEW_SUBMITTED/test_case`; notifies
reviewer (`review_assigned`, entityType `review`). Returns the review row.

## 7. `/api/reviews` — single-case reviews (`reviews/route.ts`)

| Endpoint | Auth rules | Behaviour |
|---|---|---|
| `GET ?action=queue` 🛡 any | — | My open queue (`reviewerId = me`, status pending/in_progress), with testCase/author/module summary |
| `GET ?id=` | any | Full detail: review + testCase + reviewer + requester + events |
| `GET` (list) | any role | All reviews, paginated (pageSize 50), filters `status`, `reviewerId`, `testCaseId` — *no permission gate on this branch (see 03 §8)* |
| `POST ?id=` 🛡 `perform_review` 👑 | assigned reviewer ∨ admin; else 403 `You are not the assigned reviewer` | **Verdict** — see below |

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
| `GET ?action=all` 🛡 `view_all_task_reports` | lead/admin | Latest 100 with module/reviewer/requester + counts; else 403 `Team lead or admin only` |
| `GET ?id=` | any | Detail: module, reviewer, requester, **caseReviews[]** each embedding full serialized testCase + events |
| `POST ?id=&action=approve-all` 🛡 `perform_review` 👑 | assigned ∨ admin | **Bulk approve** — see below |

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
| `GET` list | any | `page(1)`, `pageSize(100)`, filters `status`, `severity`, `moduleId`, `assignedToId`, `reportedById`, `search` (title contains, case-sensitive); sort `createdAt desc` |
| `GET ?id=` | any | Bug + module + reportedBy + assignedTo + testCaseLinks |
| `GET ?id=&action=links` | any | `BugTestCaseLink[]` with testCase summaries |
| `POST` 🛡 `create_bug` | body `{ title, description?, severity(default medium), environment?, stepsToReproduce?, expectedBehaviour?, actualBehaviour?, moduleId?, assignedToId?, testCaseIds[] }` | `reportedById = me`; optional `createMany` links. Logs `CREATE/bug`; if assigned → notify assignee (`bug_assigned`) |
| `PUT ?id=` | any authenticated user for fields; **`assign_bug` required if payload contains `assignedToId`** (403 `Only team leads and admins can reassign bugs`) | Partial update. Status `resolved`/`closed` ⇒ server stamps `resolvedAt = now()`. Logs `UPDATE/bug` (full before/after); assignee change → `bug_assigned` notification |
| `PUT ?id=&action=link-tc` | any | Body `{ testCaseId }` → create link (duplicate-safe); always `{ "success": true }` |
| `DELETE ?id=` 👑 | **admin only** (403 `Admin only`) | **Hard delete** (links cascade). Logs `DELETE/bug` |

The deliberately open field-edit rule is what lets any teammate drag a card across the
Kanban board without role friction; only *assignment* and *deletion* are gated.

## 10. `/api/task-reports` — daily work log (`task-reports/route.ts`)

| Endpoint | Auth rules | Behaviour |
|---|---|---|
| `GET ?action=my` | self | All my reports (desc by date), serialized |
| `GET ?action=summary` 🛡 `view_all_task_reports` | lead/admin | Per-user aggregates for a date range (default last 30 days): `{ users: [{ userId, userName, totalMinutes, days, hours }] }` |
| `GET ?id=` 👑 | owner ∨ `view_all_task_reports` | Single report; else 403 `You can only view your own reports` |
| `GET` list | any | **Non-managers force-filtered to own rows**; managers may pass `userId`; filters `dateFrom`, `dateTo`, `moduleId` (substring match inside the tasks JSON — heuristic) |
| `POST` 🛡 `create_task_report` | body `{ reportDate, tasks[] (default []), notes? }` | **Upsert by (me, reportDate)** — unique constraint; recomputes `totalMinutes`. Logs `CREATE` or `UPDATE/task_report` |
| `PUT ?id=` 👑 | **owner only** — even admins | Partial update, recomputes total. Logs `UPDATE/task_report` |

`tasks[]` item validation: `{ description(min 1), timeSpentMinutes(int ≥0), moduleId?,
testCaseId?, bugId?, status: done|in_progress|blocked }`.

## 11. `/api/activity-logs` — audit trail (`activity-logs/route.ts`)

| Endpoint | Auth rules | Behaviour |
|---|---|---|
| `GET` full list 🛡 `view_activity_logs` | lead/admin | `page(1)`, `pageSize(50)`, filters `userId`, `entityType`, `action`, `dateFrom`, `dateTo`; desc; snapshots/diff parsed |
| `GET ?action=entity&type=&id=` | any authenticated *(checked after this branch)* | Latest 50 logs for one entity (used by the case-detail Activity card) |
| `GET ?action=user&id=` | any authenticated *(same)* | Latest 50 logs by one user |

## 12. `/api/notifications` — the bell (`notifications/route.ts`)

Everything is scoped to the logged-in user.

| Endpoint | Behaviour |
|---|---|
| `GET` | My notifications, paginated (pageSize 50), optional `isRead=true|false` filter |
| `POST ?action=read-all` | `updateMany` my unread → read; `{ "success": true }` |
| `PATCH ?id=` | Mark one read; owner check → 400 `Not your notification` |
| `DELETE ?id=` | Hard delete one of my notifications |

## 13. `/api/users` — admin user management 👑 (`users/route.ts`)

**Every method** requires `manage_users` → admin only (403 `Admin only`).

| Endpoint | Behaviour |
|---|---|
| `GET` | Paginated `publicUser`s (pageSize 50), filters `role`, `isActive`; sort `createdAt asc` |
| `POST` | Invite: `{ email, fullName(min 2), password(min 8), role (required) }`; duplicate email → 400. Logs `CREATE/user` |
| `PUT ?id=` | `{ fullName?, role?, isActive?, avatarUrl? }`. Logs `UPDATE/user` (before/after role+active+name) |
| `DELETE ?id=` | **Soft delete**: `isActive: false`; self-delete → 400 `Cannot delete yourself`. Logs `DELETE/user` |

## 14. ~~`/api/keep-alive`~~ — REMOVED 2026-10-14 with the MySQL migration (health: `GET /api`) 🔓

**Public by design** — Vercel Cron sends unauthenticated GETs, and the endpoint
leaks nothing. `GET` runs `SELECT 1` through Prisma and answers
`{ ok: true, message: …, pingedAt }`; on database failure 500 `{ ok: false }`.
Purpose: free database providers pause idle projects. NOTE (2026-10-14): the keep-alive route was REMOVED with the MySQL migration — MySQL has no free-tier pause;
activity). `vercel.json` schedules a daily cron — the Hobby plan's maximum
frequency — to call this endpoint, so the database records activity every day and
never pauses. Harmless with every provider; also callable manually from a browser.
See doc 12 §3 and DEPLOYMENT-GUIDE.md Appendix E.

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

## 16. Known quirks (documented on purpose)

1. `stats` unknown action → 200 with `{error}` (everywhere else 400).
2. `GET /api/reviews` (all) and `activity-logs ?action=entity|user` have weaker gates
   (see `03-authentication-and-permissions.md` §8).
3. Notification ownership violations return **400** rather than 403.
4. `search` filters were case-sensitive on PostgreSQL; on MySQL 8.4 they are case-insensitive (`LIKE` on utf8mb4_unicode_ci)
   `mode: 'insensitive'`).
5. Task-report date uniqueness is on the stored datetime — the client normalises dates
   to `YYYY-MM-DD` (timezone-safe `todayISO()`), so in practice one row per calendar day.
6. The Reports view's date inputs are currently cosmetic (not sent to the API).
