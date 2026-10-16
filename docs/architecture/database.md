# Database Schema — every table explained

> Source of truth: `prisma/schema.prisma` (MySQL 8.4 provider, utf8mb4). This document mirrors
> every model, column, relation, default and index, then explains *why* it is shaped
> that way. Apply `prisma/migrations/` (`npx prisma migrate deploy`) to create it.


> **Naming:** SQL tables and columns are snake_case with **entity-named primary keys**
> (`users.user_id`, `modules.module_id`, `test_cases.test_case_id`, … — never a generic
> `id`). This chapter uses the Prisma model and field names (`TestCase.authorId`); the SQL
> name of each is in `prisma/schema.prisma` (`@map` / `@@map`). Raw SQL in the
> repositories always uses the snake_case names.

---

## 1. Conventions

| Convention | Detail |
|---|---|
| Primary keys | `CHAR(36)` UUIDs named after the entity (`user_id`, …); the repositories supply app-generated UUIDs (`src/lib/server/id.ts`); `BugTestCaseLink` has a composite PK. |
| Timestamps | `created_at` / `updated_at` `DATETIME(3)` in UTC; raw SQL writes `UTC_TIMESTAMP(3)`. Some log-like tables deliberately omit `updated_at`. `updated_at` also serves the optimistic lock (a save with a stale `expectedUpdatedAt` answers 409). |
| Enums | Stored as plain `String` columns with documented value sets (roles, statuses, priorities). The TypeScript unions in `src/types/index.ts` mirror them. |
| JSON columns | **10 columns are MySQL JSON** (Prisma `Json`): `TestCase.steps/tags/attachments`, `TestCaseHistory.snapshot`, `ReviewEvent.flaggedFields`, `Bug.attachments`, `TaskReport.tasks`, `ActivityLog.beforeSnapshot/afterSnapshot/diff`. Array-typed ones carry `@default("[]")`. |
| Collation | `utf8mb4_unicode_ci` (case-insensitive `LIKE`); `utf8mb4_bin` for the password hash and refresh token. |
| Datasource | `DATABASE_URL` (app user, DML) + `DIRECT_URL` (migrate user, DDL for `prisma migrate deploy`). |

### Entity relationship overview

```
 User ──owns/creates/updates──▶ Module (self-nested tree via parentId/path)
   │                              │
   │                              ├── (module-level permissions: removed — role-based only)
   │                              ├── ModuleReviewRequest ──▶ has many ReviewRequest (children)
   │                              ├── Bug (optional module link)
   │                              └── TestCase (optional module link, SetNull)
   │                                         │
   │                                         ├── TestCaseHistory (version snapshots)
   │                                         └── ReviewRequest ──▶ ReviewEvent (verdicts)
   │                                                   │
   ├── RefreshToken (JWT rotation)                     └── moduleReviewId ▶ ModuleReviewRequest
   ├── Bug (reportedBy / assignedTo)
   │      └── BugTestCaseLink ◀──▶ TestCase (many-to-many)
   ├── TaskReport (one per user per day)
   ├── Notification
   └── ActivityLog (audit trail)
```

---

## 2. User

The account table. One row per person.

| Column | Type | Default | Notes |
|---|---|---|---|
| `email` | String, **unique** | — | Login identifier, lowercase enforced by convention |
| `fullName` | String | — | Display name |
| `passwordHash` | String | — | bcrypt hash (10 rounds); never returned by any API |
| `role` | String | `"qa_engineer"` | `vp` \| `manager` \| `product` \| `developer` \| `qa_engineer` \| `viewer` (only a VP sets or changes it) |
| `telegramChatId` | String? | null | Reserved for future Telegram delivery (unused) |
| `avatarUrl` | String? | null | Optional avatar image URL |
| `isActive` | Boolean | `true` | `false` = soft-deleted user; login rejected |
| `notifyEmail` | Boolean | `true` | Preference flag (email sending not implemented) |
| `notifyTelegram` | Boolean | `true` | Preference flag (unused) |
| `notifyInapp` | Boolean | `true` | **Used**: if `false`, `createNotification()` skips in-app rows |

Relations: this table is referenced by almost everything — modules owned/created/updated,
module permissions, test cases authored/edited/assigned, review requests (as reviewer and
as requester), review events, bugs reported/assigned, task reports, notifications,
activity logs, refresh tokens. None of these cascade-delete the user; the user row is
the anchor.

## 3. RefreshToken

Enables the "remember me for 7 days" experience with rotation.

| Column | Type | Default | Notes |
|---|---|---|---|
| `token` | String, **unique** | — | The JWT refresh token itself |
| `userId` | String | — | → User, **onDelete: Cascade** |
| `expiresAt` | DateTime | — | 7 days after issue |
| `revoked` | Boolean | `false` | Set on refresh/logout (rotation) |

Index: `userId`. Rotation story: every `POST /api/auth?path=refresh` revokes the old row
and inserts a new one; a revoked token can never be reused.

## 4. Module

Feature area, arranged in a tree (root modules → submodules → …).

| Column | Type | Default | Notes |
|---|---|---|---|
| `name` | String | — | e.g. `Authentication - Login` |
| `description` | String? | null | |
| `parentId` | String? | null | → parent Module, **Cascade** (deleting a parent deletes children) |
| `path` | String | — | Materialised path of ancestor ids: `""` for roots, `"<rootId>"` for depth-1, `"<rootId>.<childId>"` for depth-2 … |
| `depth` | Int | `0` | 0 = root |
| `ownerId` | String | — | → User ("ModuleOwner"). Creator becomes owner automatically |
| `createdById` | String | — | → User ("ModuleCreator"). **Immutable; governs delete rights** |
| `updatedById` | String? | null | → User ("ModuleUpdater") |

Indexes: `parentId`, `ownerId`. The `path`/`depth` pair makes "give me this module and
all descendants" a prefix scan in JS (the API walks the tree once and matches by
`path.startsWith`), and lets the UI indent the tree without extra queries.

## 5. RolePermission & LoginAttempt (access control)

**`role_permissions`** — runtime-togglable permission matrix overrides. Cells absent
from this table follow the built-in defaults in `src/lib/permissions.ts`. The VP
toggles cells from the Permissions panel (`PUT /api/permissions`); toggling a cell
back to its default deletes the row, so the table only holds real deviations.
Composite PK `(role, action)`; `updated_by_id` intentionally has **no FK** (a toggle
outlives user deletion).

**`login_attempts`** — login brute-force guard state, one row per email: failed
attempt counter + `locked_until`. 5 failures lock the email for 60 s; a successful
login deletes the row. (Module-level permissions were removed by design — access is
role-based only.)

## 6. TestCase

The core entity.

| Column | Type | Default | Notes |
|---|---|---|---|
| `moduleId` | String? | null | → Module, **onDelete: SetNull** (deleting a module orphans its cases) |
| `title` | String | — | |
| `description` | String? | null | |
| `preconditions` | String? | null | |
| `steps` | **Json** | `[]` | Array of `{ stepNumber: number, action: string, expected: string }` |
| `expectedResult` | String? | null | |
| `priority` | String | `"P2"` | `P0` \| `P1` \| `P2` \| `P3` |
| `status` | String | `"draft"` | `draft` \| `in_review` \| `needs_revision` \| `approved` \| `active` \| `deprecated` |
| `tags` | **Json** | `[]` | Array of strings |
| `version` | Int | `1` | Bumped on every edit; old state stored in TestCaseHistory |
| `authorId` | String | — | → User "TestCaseAuthor"; immutable |
| `lastEditedById` | String? | null | → User "TestCaseEditor" |
| `assigneeId` | String? | null | → User "TestCaseAssignee" — the suggested reviewer |
| `attachments` | **Json** | `[]` | Array (reserved for future file links) |

Indexes: `moduleId`, `authorId`, `status` (status is the most-filtered column).

### Status lifecycle

```
            submit-review            verdict approved
 draft ────────────────▶ in_review ──────────────▶ approved
   ▲                         │  ▲                    
   │      verdict failed /   │  │ resubmit (submit-review
   └── needs_revision ◀──────┘  │  allowed from needs_revision)
                                │
 any status ── DELETE (soft) ──▶ deprecated
```

`active` exists as a post-approval "promoted" state (seed data uses it; the API does not
transition into it yet).

## 7. TestCaseHistory

Immutable version snapshots, written **before** each update.

| Column | Type | Notes |
|---|---|---|
| `testCaseId` | String | → TestCase, **Cascade** |
| `version` | Int | The version that was current *before* the edit |
| `snapshot` | **Json** (required) | `{title, description, preconditions, steps, expectedResult, priority, tags, moduleId, assigneeId}` |
| `changedById` | String? | → User |
| `changeSummary` | String? | `"Updated: <new title>"` or `"Field update"` |

Index: `testCaseId`. Reading history = the UI's "Version History" card on the case detail page.

## 8. ModuleReviewRequest

Umbrella review for a whole module (bulk review workspace).

| Column | Type | Default | Notes |
|---|---|---|---|
| `moduleId` | String | — | → Module, **Cascade** |
| `reviewerId` | String | — | → User "ModuleReviewer" |
| `requesterId` | String | — | → User "ModuleReviewRequester" |
| `status` | String | `"pending"` | `pending` \| `in_progress` \| `completed` |
| `dueDate` | DateTime? | null | |
| `cycle` | Int | `1` | Per-module review round counter |

Indexes: `reviewerId`, `moduleId`, `status`. Auto-transitions: `pending → in_progress`
when the first child verdict lands; `→ completed` when **all** child case reviews are
completed (server-side aggregation in `api/reviews` POST), or immediately via
`approve-all`.

## 9. ReviewRequest

One review of one test case. Lives alone **or** as a child of a module review.

| Column | Type | Default | Notes |
|---|---|---|---|
| `testCaseId` | String | — | → TestCase, **Cascade** |
| `reviewerId` | String | — | → User "Reviewer" |
| `requesterId` | String | — | → User "ReviewRequester" |
| `status` | String | `"pending"` | `pending` \| `in_progress` \| `completed` |
| `dueDate` | DateTime? | null | |
| `cycle` | Int | `1` | Per-test-case round counter (resubmission increments) |
| `moduleReviewId` | String? | null | → parent ModuleReviewRequest, **Cascade** — the bulk-review link |

Indexes: `reviewerId`, `status`, `moduleReviewId`. Status transitions: `pending →
in_progress` on a `needs_revision` verdict (the case needs rework, the review stays
open); `→ completed` on `approved`/`failed`.

## 10. ReviewEvent

Append-only verdict history for a review request.

| Column | Type | Notes |
|---|---|---|
| `reviewRequestId` | String | → ReviewRequest, **Cascade** |
| `reviewerId` | String | → User |
| `verdict` | String | `approved` \| `failed` \| `needs_revision` |
| `comment` | String? | **Required** by the API unless verdict is `approved` |
| `flaggedFields` | **Json** | `[]` default; array of human labels, e.g. `"Steps unclear"` |

Index: `reviewRequestId`. The UI renders these as the "Review History" timeline with
color-coded verdict badges.

## 11. Bug

| Column | Type | Default | Notes |
|---|---|---|---|
| `title` | String | — | |
| `description` | String? | null | |
| `severity` | String | `"medium"` | `critical` \| `high` \| `medium` \| `low` |
| `status` | String | `"open"` | `open` \| `in_progress` \| `resolved` \| `closed` \| `wont_fix` |
| `environment` | String? | null | e.g. `staging`, `production` |
| `stepsToReproduce` | String? | null | |
| `expectedBehaviour` | String? | null | |
| `actualBehaviour` | String? | null | |
| `reportedById` | String | — | → User "BugReporter" |
| `assignedToId` | String? | null | → User "BugAssignee"; assignment triggers a notification |
| `moduleId` | String? | null | → Module (no explicit onDelete → DB default RESTRICT) |
| `attachments` | **Json** | `[]` | |
| `resolvedAt` | DateTime? | null | Server stamps `now()` when status becomes `resolved`/`closed` |

Indexes: `status`, `severity`, `assignedToId`. Bugs are **hard-deleted** (`delete_bug`: vp + manager by default).

## 12. BugTestCaseLink

Many-to-many between bugs and test cases.

| Column | Notes |
|---|---|
| `bugId` + `testCaseId` | Composite primary key (also the uniqueness) |
| Both FKs **Cascade** | Deleting a bug or case removes its links |

Written at bug creation (`testCaseIds[]` body param) or via `PUT /api/bugs?id=…&action=link-tc`.

## 13. TaskReport

Daily work log — **one row per user per day**, enforced by
`@@unique([reportedById, reportDate])`. The API uses find-then-update (upsert) on this.

| Column | Type | Default | Notes |
|---|---|---|---|
| `reportedById` | String | — | → User, **Cascade** |
| `reportDate` | DateTime | — | The day being reported |
| `tasks` | **Json** | `[]` | Array of `TaskItem` (below) |
| `notes` | String? | null | Free-text end-of-day notes |
| `totalMinutes` | Int | `0` | Server-computed sum of task minutes |

`TaskItem` shape (inside the MySQL JSON array):
`{ description, timeSpentMinutes, moduleId | null, testCaseId | null, bugId | null, status: 'done' | 'in_progress' | 'blocked' }`
— the three optional ids link a task line to any entity (rendered as pickers in the Tasks view).

Indexes: `reportedById`, `reportDate`.

## 14. Notification

In-app notification row (the bell).

| Column | Type | Default | Notes |
|---|---|---|---|
| `userId` | String | — | Recipient, **Cascade** |
| `type` | String | — | `review_assigned` \| `review_approved` \| `review_failed` \| `review_needs_revision` \| `comment_added` \| `bug_assigned` \| `test_case_updated` \| `module_created` \| `daily_summary` |
| `title` | String | — | Short headline |
| `body` | String? | null | Longer text (e.g. includes verdict comment) |
| `entityType` / `entityId` | String? | null | Deep-link target: clicking navigates to the related view |
| `isRead` | Boolean | `false` | Flipped by PATCH / read-all |

Index: composite `[userId, isRead]` — exactly the query the bell badge runs
("count unread for me").

## 15. ActivityLog

The audit trail. Written by `logActivity()` from **every** mutating route.

| Column | Type | Notes |
|---|---|---|
| `userId` | String? | Actor; → User with **SetNull** (logs survive user deletion) |
| `action` | String | `CREATE` \| `UPDATE` \| `DELETE` \| `STATUS_CHANGE` \| `LOGIN` \| `REVIEW_SUBMITTED` \| `REVIEW_VERDICT` (some writers use suffixed forms like `REVIEW_SUBMITTED`) |
| `entityType` | String | `test_case` \| `module` \| `bug` \| `review` \| `user` \| `task_report` |
| `entityId` / `entityName` | String? | What was touched; name keeps logs readable after renames |
| `beforeSnapshot` | **Json?** | Full relevant fields before the change |
| `afterSnapshot` | **Json?** | After the change |
| `diff` | **Json?** | `{ field: { before, after } }` — only changed keys; shallow JSON.stringify comparison |
| `ipAddress` / `userAgent` | String? | From `x-forwarded-for` / `user-agent` headers |

Indexes: composite `[entityType, entityId]` (per-entity history card on the case detail
page), `userId`, `action`. Activity rows are never deleted by the app.

---

## 16. Deletion semantics summary (important!)

| Entity | Delete behaviour | Who may delete |
|---|---|---|
| Module | **Hard** — cascades to submodules and module reviews; test cases and bugs keep the row with `module_id` NULL | Creator, or `edit_module` |
| Test case | **Hard** — row deleted (history and reviews cascade) | Author, or `delete_test_case` |
| Bug | **Hard** — cascades links | `delete_bug` (vp + manager by default) |
| User | **Soft** — `isActive: false`; login blocked; data preserved | `manage_users` (not on self) |
| TaskReport / Notification / ActivityLog | Not deletable via dedicated business rules (notifications deletable by owner; reports editable only by owner) | — |

## 17. How MySQL JSON is read back (the parser contract)

Prisma returns MySQL JSON as already-parsed JavaScript objects. To stay compatible with
legacy rows that might contain JSON *strings*, every read path funnels through:

```ts
parseJson(value, fallback)  // null → fallback; object → as-is; string → JSON.parse (safe)
toJson(value)               // pass-through, kept for call-site readability
```

Central normalisers in `src/lib/serializers.ts` (`serializeTestCase`, `serializeBug`,
`serializeTaskReport`, `serializeActivityLog`, `serializeReviewEvent`, …) guarantee each
JSON column is parsed **exactly once** before the row leaves the server — the class of
bug that originally motivated them (`flaggedFields.map is not a function`) is documented
in the project history.
