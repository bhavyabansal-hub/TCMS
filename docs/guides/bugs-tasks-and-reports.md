# Pages — Bugs (Kanban), Tasks (daily log), Reports

> Files: `views/bugs.tsx` (492), `views/tasks.tsx` (546), `views/reports.tsx` (418).
> Three working surfaces: triage by drag & drop, personal accountability per day, and
> management analytics.

---

## 1. Bugs view (`'bugs'`) — board + table

### Layout & state
Header tabs **Board / Table** (`view: 'kanban' | 'table'`, default board) and **"Report
Bug"** (hidden for viewers). Data: `['bugs','list']` → `GET /api/bugs?pageSize=200`
(one fetch powers both views — the dataset is small by design).

### Kanban board (drag & drop with @dnd-kit)
- Five columns, keyed by `BUG_STATUSES = open, in_progress, resolved, closed, wont_fix`;
  each is a `useDroppable` with a count badge and a *"Drop here"* placeholder; columns
  highlight green when a card hovers (`isOver`).
- `DndContext` + `PointerSensor` (activation distance 5px — distinguishes click vs drag).
- **`handleDragEnd`**: if the status changed → `bugsApi.update(bugId, { status })` →
  toast `Moved to "{status}"`; invalidate `['bugs']`; failures toast via
  `handleApiError(err, 'Failed to move')`. **This is the only "drag = mutation" in the
  app** — any bug participant (`create_bug` or `assign_bug`) can move any bug; changing
  the assignee needs `assign_bug` and deleting needs `delete_bug`.

### Table view
Columns: ID (last 6), Title, Severity badge, Status badge, Assigned, Module, Reported
(`timeAgo`). Row click opens the detail sheet.

### CreateBugDialog ("Report a Bug")
Fields: Title (required), Severity (default `medium`), Environment (default
`staging`), Module select, **Assign To** (users whose role is in `BUG_ASSIGNEE_ROLES`:
vp, manager, product, qa_engineer; the picker is disabled without `assign_bug`), Description, Steps to Reproduce, Expected Behaviour, Actual Behaviour.
`POST /api/bugs` → toast `Bug reported`, invalidate `['bugs']`. If an assignee was
chosen the server notifies them (`bug_assigned`).

### BugDetailDialog (detail dialog)
Shows everything: badges, `#{id6}`, reporter + timestamp, Description, Environment,
Steps, Expected / Actual, module + assignee grid.
- **Edit** (`create_bug` or `assign_bug`) opens the edit form (Status / Severity / fields;
  Assignee only with `assign_bug`) + Save (`bugsApi.update` → `Bug updated`). Only changed
  fields are sent; the assignee is sent only when it changed, and a stale save answers 409
  *"This item was changed by someone else — reload"*. Moving status to resolved/closed makes the
  **server** stamp `resolvedAt`.
- **Delete** (red, shown with `delete_bug`) → `DELETE /api/bugs?id=`; no confirmation
  dialog (known quirk), toasts `Bug deleted`.

---

## 2. Tasks view (`'tasks'`) — one report per user per day

### The model
A TaskReport = a date + an array of task lines (`description`, `minutes`, optional
link to module/test-case/bug, `status: done|in_progress|blocked`) + notes. Unique per
(user, date) — the screen is an **editor for exactly one day of one person**.

### Who can edit whom
```
canViewAllReports = can('view_all_task_reports')
canCreateReport   = can('create_task_report')
view-all holders  → user switcher; viewing someone else = READ-ONLY
                    (notice: "You are viewing another user's report. …")
create holders    → full editing of their own report for any date
others            → read-only notice: "Your role can view work logs but cannot log work. …"
```
(The API mirrors this: upsert always owns the row; PUT is owner-only.)

### Data
- Self (non-manager): `['task-reports','my']` → `GET ?action=my`.
- Manager: `['users','list','all']` + `['task-reports','user',effectiveUserId,reportDate]`
  → `GET ?userId&dateFrom=date&dateTo=date`.
- Reference data: modules tree, light test-case list (pageSize 200), light bug list —
  for the link pickers.

### The form
- Header: date input (`reportDate`, timezone-safe `todayISO()`) + manager-only user
  select (`fullName · email`).
- Task lines: Description · Minutes · **Link type** (`No link / Module / Test case /
  Bug` — switching resets all three ids) · Status · remove. A linked line renders a
  second picker row (*"Linked module for entry #N"*, modules indented by depth).
- **"Add task"** appends a blank line (`status: in_progress`, 0 min).
- Notes card: free text.
- The whole form component is **re-keyed** by
  `` `${effectiveUserId}-${reportDate}-${existingReportId ?? 'new'}` `` — when the
  server data for a day changes, React remounts the form and local state resets
  cleanly (a deliberate alternative to effect-syncing).

### Save & export
- **Save** → `taskReportsApi.upsert({ reportDate, tasks, notes })` → `POST` (find-then-
  update upsert by user+date; server recomputes `totalMinutes`) → toast `Task report
  saved`; invalidate `['task-reports']`. Hidden when read-only.
- **Export CSV** (disabled when empty): rows `Date, Description, Minutes, Status,
  Linked Type, Linked ID` + notes + total; file `tasks-{reportDate}.csv`.
- Sticky footer: `Total time: {minutesToHuman(totalMinutes)}` + task count.

---

## 3. Reports view (`'reports'`) — team analytics

### Access
`view_all_task_reports` holders only — the sidebar hides the item and the view renders a
destructive *"Access restricted"* alert for others (the API enforces the same permission).

### Data
One query: `['stats','reports']` → `GET /api/stats?action=reports` →
`{ testCasesByStatus, testCasesByPriority, bugsByStatus, weeklyHours }` (weekly = last
30 days, Sunday-based weeks).

### Tabs
**Team summary** — pivot of `weeklyHours` into a per-user × per-week table (totals
column, `—` for zero) + vertical bar chart of total hours per user (emerald
`#10b981`, names truncated at 18 chars).

**Test case metrics** — three recharts: status donut (slate/amber/orange palette),
priority donut (`P0 #ef4444, P1 #f97316, P2 #eab308, P3 #0ea5e9`), bugs-by-status bar
(`open #f43f5e, in_progress #f59e0b, resolved #10b981, closed #64748b, wont_fix
#a1a1aa`) with legends.

### Known limitation (documented honestly)
The two date inputs in the *Weekly hours* card header (`dateFrom`, `dateTo`) are
**cosmetic** — `statsApi.reports()` takes no parameters, so changing them refetches
nothing. The API's `?action=summary` on task-reports *does* accept ranges; wiring the
UI to it is a straightforward future improvement (file under "next steps", `docs/CODEBASE-MAP.md`).

### Export
**"Export PDF"** → `window.print()` with a `.print-area` class on the metrics grid —
the browser's print dialog is the PDF pipeline (zero dependencies).
