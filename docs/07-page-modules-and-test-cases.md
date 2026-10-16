# 07 · Pages — Modules, Test Cases list, Test Case detail

> Files: `views/modules.tsx` (511 lines), `views/test-cases.tsx` (411),
> `views/test-case-detail.tsx` (626). These three screens cover the authoring core of
> TCMS: organising features, writing cases, and evolving them version by version.

---

## 1. Modules view (`'modules'`) — the feature tree

### Purpose & layout
Two panels. **Left:** the module tree (roots → submodules, expand/collapse, per-node
test-case-count badges). **Right:** the selected module's detail — metadata, owner,
submodule chips, its test cases, and module-level actions.

### Data
| Query | Endpoint | Notes |
|---|---|---|
| `['modules','tree']` | `GET /api/modules` | `{ tree, flat }` — the left panel + every module picker in the app |
| `['modules','detail',selectedId]` | `GET /api/modules?id=…` | `{ module, testCases, submodules }`, `enabled: !!selectedId` |
| `['users','all']` | `GET /api/users?pageSize=200` | for the reviewer picker in the submit dialog |

### State
`selectedId`, `expanded: Set<string>` (tree open/closed), `createOpen` +
`createParent: string|null`, `deleteId`, `submitReviewModule: {id,name}|null`.

### Derived permissions (permission matrix via `can()`)
- `canCreateModule = can('create_module')` → shows **"Submodule"** create button (and root create);
  `canEditModule = can('edit_module')` → edit.
- `canSubmit = can('submit_review')` → shows **"Submit for Review"**.
- `isSenior = can('edit_module')`.
- `canDeleteSelected = isCreator || isSenior` → the delete button is **always visible but
  disabled** otherwise, with tooltip *"Only the creator or a senior manager can delete
  this module"* plus an inline amber warning (`ShieldAlert`).

### Interactions, one by one
| Action | What happens |
|---|---|
| Click a tree row | selects module → right panel fetches detail |
| Click a submodule chip | selects it and auto-expands the parent branch |
| **Create Submodule / Root** dialog | fields Name (required — empty → `toast.error('Name is required')`), Description; info box *"Creator / Owner: {you}"* explaining the delete rule. `POST /api/modules` **without `ownerId`** (server forces creator=owner). Success: `Module created — you are the owner`; invalidate `['modules']` |
| **Submit for Review** dialog | Reviewer select (users whose role has `perform_review`; placeholder *"Auto-assign"* = first active manager, then VP), optional due date, checkbox **"Include submodules" (default true**; description notes approved/active cases are skipped). `PUT /api/modules?id=…&action=submit-review`. Success toast `Submitted {N} test case(s) for review`; invalidates `['modules','test-cases','reviews','module-reviews']`; **auto-navigates** to `module-review-detail { id }` |
| **Delete** confirm (`AlertDialog`) | warns about cascade to submodules and orphaned cases. `DELETE /api/modules?id=…`; invalidate `['modules']`; clear selection if deleted |
| Case row click / "View all →" | `navigate('test-case-detail', { id })` / `navigate('test-cases')` |

### Things to notice
The tree is rendered recursively from `tree` — materialised `path`/`depth` fields make
indention trivial. The create dialog deliberately never asks who owns the module;
ownership follows creation, which is what makes the delete-permission rule coherent.

---

## 2. Test Cases list (`'test-cases'`) — filter, find, export

### Layout
Toolbar (search + 3 filter selects + Export CSV + New Test Case) → table → shared
`<Pagination>` footer.

### Data
- `['test-cases','list',{ search, statusFilter, priorityFilter, moduleFilter, page }]`
  → `GET /api/test-cases?search&status&priority&moduleId&page&pageSize=20` — filters
  are **part of the query key**, so every combination caches independently.
- `['modules','tree']` for the module filter + create dialog.

### State & behaviours
| Control | Detail |
|---|---|
| Search input | placeholder *"Search by title..."*; typing resets `page` to 1 (server `contains` search — case-sensitive) |
| Status select | All + the 6 statuses |
| Priority select | All + P0–P3 |
| Module select | All + flat module list |
| **Export CSV** | client-side blob from **current page rows**; headers `ID, Title, Module, Priority, Status, Tags, Author, Updated`; file `test-cases-YYYY-MM-DD.csv`; toast `Exported CSV` / `No data to export` |
| **New Test Case** | **hidden for viewers**; opens the create dialog |

### Table columns
ID (last 6 chars), Title (truncated 60), Module, Priority badge, Status badge, Tags
(first 2 + `+N`), Author, Updated. Row click *and* eye icon →
`navigate('test-case-detail', { id })`. Empty state: *"No test cases match your filters"*.

### CreateTestCaseDialog
Fields: Title (required), Module select (optional), Priority (default `P2`), Tags
(comma-separated → array), Description, Preconditions, **Steps editor** (numbered rows
of Action + Expected result; "Add step"; remove disabled at 1 step; empty rows
filtered out), Expected Result, author info box. Submits `POST /api/test-cases`
**without `authorId`** (server: author = me, status = draft, version = 1). Success:
toast `Test case created — you are the author`, invalidate `['test-cases']`, close,
**navigate to the new case's detail page**.

---

## 3. Test Case detail (`'test-case-detail'`) — read, edit, version, review

Opened with `params.id`. The richest screen in the app: five queries, an inline editor,
a submit-for-review dialog, soft delete, and three side panels.

### Data (5 queries)
| Key | Endpoint |
|---|---|
| `['test-cases','detail',id]` | `GET /api/test-cases?id=` |
| `['test-cases','history',id]` | `…&action=history` |
| `['test-cases','reviews',id]` | `…&action=reviews` |
| `['activity','test_case',id]` | `GET /api/activity-logs?action=entity&type=test_case&id=` |
| `['modules','tree']` + `['users','all']` | pickers |

### Derived permissions
```
isAuthor           = tc.authorId === user.userId
canEdit            = can('edit_any_test_case') || (isAuthor && can('edit_own_test_case'))
canDelete          = isAuthor || can('delete_test_case')
canSubmitForReview = can('submit_review') && (status === 'draft' || status === 'needs_revision')
```
The API refuses a submit for a case that is `in_review` or `approved` (400).

### Main column (read mode)
Badges: priority, status, `v{version}` · module name · tags · then sections
Description → Preconditions → **Steps table** (# / Action / Expected Result) →
Expected Result. While under review the header additionally shows *Awaiting review*
(`in_review`) or *Approved* (`approved`) chips.

### Buttons & flows
| Button (when visible) | Flow |
|---|---|
| **Edit** (`canEdit`) | swaps the main column to the inline `TestCaseEditor` — Title, Module, Priority, **Reviewer (assignee)** select (users whose role has `perform_review`, placeholder *Unassigned*), Tags, Description, Preconditions, Steps editor, Expected Result. Save → `PUT /api/test-cases?id=` → server snapshots old state into history and bumps `version`. Client invalidates detail + history + list, toasts `Test case updated`, exits edit mode |
| **Delete** (`canDelete`) | `DELETE` → hard delete → toast `Test case permanently deleted` → navigate back to the list |
| **Submit for Review** (`canSubmit`) | dialog: Reviewer (pre-filled with `tc.assigneeId`, placeholder *Auto-assign*) + optional due date → `PUT …&action=submit-review` → toast `Submitted for review`, invalidates detail/reviews/queue |
| **Back to Test Cases** | navigate |

### Side panels (right column)
1. **People** — Author (+created date), Reviewer/assignee, Last edited by.
2. **Version History** — each entry `v{n}`, who changed, summary (`"Updated: …"` /
   `"Field update"`), `timeAgo`; scrollable. Data = TestCaseHistory snapshots (they hold
   the *previous* state of each version).
3. **Review Cycles** — per ReviewRequest: `Cycle {n}` badge, review status badge,
   reviewer, and the nested ReviewEvent timeline with verdict badges + comments +
   flagged-field badges (the author sees exactly which fields the reviewer flagged).
4. **Activity** — first 8 entity-scoped activity logs with `actionColor` badges.

### The versioning mental model (end to end)
Edit v3 → server writes history row `version: 3` containing the v3 snapshot → case
becomes v4. The history card shows where each version came from; the snapshots make
"what did it look like before" answerable forever (rows are only deleted with the case
itself, which never happens — delete is soft).
