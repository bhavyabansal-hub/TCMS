# 11 · End-to-End Flows — click to database and back

> The complete stories behind the six things this system does. Each flow names every
> file, function, endpoint, table and status change in order. These are the "movie
> versions" of docs 04–10; use them to trace or debug any real interaction.

---

## Flow 1 · From page load to logged-in dashboard

```
 1. GET /                     → Next.js serves layout.tsx + page.tsx (static shell)
 2. <Providers>               → QueryClient (staleTime 30s, retry 1, no refetch on focus)
 3. <AuthGate>                → useAuthStore.initialize()
      localStorage: tcms-user + tcms-access exist?
      ├─ no  → booted; AppShell renders <AuthScreen>                [auth-screen.tsx]
      └─ yes → GET /api/auth (Bearer token + cookie)
                 ├─ 200 → publicUser → setUser → AppShell
                 └─ 401 → tryRefresh() (single-flight)
                           ├─ ok → new pair saved, request retried → 200
                           └─ fail → clearSession() → reload → <AuthScreen>
 4. AppShell                  [app-shell.tsx]
      - useNotificationSocket(user.id)  → WS connect + seed notifications (50)
      - <Sidebar> prefetch ['reviews','queue'] + ['module-reviews','queue'] (30s poll)
      - CurrentView = 'dashboard'
 5. Dashboard                 [dashboard.tsx]
      GET /api/stats?action=dashboard → 6 parallel Prisma queries → KPIs + charts
 6. User clicks demo fill + "Sign in" (first visit):
      POST /api/auth?path=login → bcrypt check → createSession
        → RefreshToken row (7d) → logActivity(LOGIN/user)
      → setSession → cookie + localStorage → toast "Welcome back!"
```

**Tables touched:** `RefreshToken` (insert), `ActivityLog` (LOGIN).
**What can fail:** expired refresh → clean login screen; deactivated user → 401 at login.

---

## Flow 2 · Create a test case → edit it (versioning) → see its history

```
 1. Test Cases view → "New Test Case"          [test-cases.tsx]
      dialog validates Title → POST /api/test-cases
        server: can('create_test_case') → status 'draft', authorId=me, version=1
        → logActivity(CREATE/test_case, after {title, moduleId, priority})
 2. Client: toast, invalidate ['test-cases'], navigate('test-case-detail',{id})
 3. Detail page → "Edit"                       [test-case-detail.tsx]
      canEdit = isSenior || (isAuthor && qa_engineer)
      editor (inline) → PUT /api/test-cases?id=
        server route order:
          a. 404 check → b. permission check
          c. TestCaseHistory INSERT {snapshot of v1 fields, version: 1,
             changeSummary: "Updated: <new title>" | "Field update"}
          d. UPDATE ... version: 2, lastEditedById=me
          e. logActivity(UPDATE/test_case, before=full v1, after=full v2) → diff computed
          f. assigneeId changed? → notification 'test_case_updated' to assignee
 4. Client invalidates detail + history + list → the page now shows v2
 5. Side panel "Version History" lists v1 (the snapshot row) and the current version
```

**Tables:** `TestCase` (insert, update), `TestCaseHistory` (insert), `ActivityLog`,
`Notification` (optional).
**Invariant:** an edit NEVER changes `status`; only reviews do.

---

## Flow 3 · Submit for review → verdict → author notified (single case)

```
 1. Author (qa1) on case (status draft) → "Submit for Review"
      dialog: reviewer (prefilled = case.assigneeId) + optional due date
      PUT /api/test-cases?id=…&action=submit-review
        server: can('submit_review') → resolve reviewer (body → assigneeId →
          first active lead/admin) → cycle = max+1 (say 1)
        → ReviewRequest INSERT (pending, cycle 1)
        → TestCase UPDATE status='in_review' (version unchanged!)
        → logActivity(REVIEW_SUBMITTED/test_case)
        → createNotification(reviewer, 'review_assigned') → Notification row
                → fire-and-forget POST localhost:3003/notify → WS room user:{reviewerId}
 2. Reviewer's browser (WS connected): 'notification' event → bell badge +1 instantly
    (WS down? row is in the DB; 30s queue poll or next fetch shows it)
 3. Reviewer → Reviews view → "Single Test Cases" tab → card (Cycle 1, due date)
      → navigate('review-detail',{id})               [review-detail.tsx]
      GET /api/reviews?id= → review + case + events
 4. Reviewer clicks "Needs Revision" → dialog:
      flagged fields: [Steps unclear], comment required (client + server enforce)
      POST /api/reviews?id= body {verdict:'needs_revision', comment, flaggedFields}
        server: can('perform_review') ∧ (assigned ∨ admin)
        → ReviewEvent INSERT
        → ReviewRequest: pending → in_progress   (stays open for the rework loop)
        → TestCase: in_review → needs_revision
        → logActivity(REVIEW_VERDICT/test_case, before {status: in_review})
        → createNotification(AUTHOR, 'review_needs_revision', body incl. comment)
 5. Author: bell +1 → click → navigates (entityType 'review' → Reviews view);
    case page shows status needs_revision, cycle 1 with one event in Review Cycles
 6. Author edits (Flow 2; version++) and resubmits → ReviewRequest cycle 2 (pending)
 7. Reviewer approves → ReviewRequest completed; TestCase approved;
    author gets 'review_approved'
```

**Tables:** `ReviewRequest` ×2, `ReviewEvent`, `TestCase` (status only), `ActivityLog`,
`Notification`.
**Response shape the client receives:** `{ event, reviewStatus, testCaseStatus }`.

---

## Flow 4 · Module-level bulk review (and auto-completion)

```
 1. Team lead opens Modules → picks "Authentication" → "Submit for Review"
      dialog: reviewer=auto (first active lead), due date, includeSubmodules ✓
      auto-pick rule (findFirstActiveReviewer): active vp/manager only, managers
        preferred over the VP (VP = escalation path), then by created_at; the
        submitter is excluded so nobody auto-reviews their own work — with a
        single-lead deployment the exclusion is relaxed rather than failing.
      PUT /api/modules?id=…&action=submit-review
        server: eligible = cases of module + descendants with status
          draft|needs_revision (say 4 cases)
        → cycle = max(module cycles)+1 = 1
        → ModuleReviewRequest INSERT (pending, cycle 1)
        → ReviewRequest INSERT ×4 (pending, moduleReviewId=parent, cycle 1)
        → TestCase UPDATE ×4 → in_review
        → logActivity(REVIEW_SUBMITTED/module); notify reviewer (module_review)
      client: toast "Submitted 4 test case(s) for review"
              → navigate('module-review-detail',{id})
 2. Reviewer opens the workspace           [module-review-detail.tsx]
      header stats: Total 4 · Approved 0 · Needs Attention 0
      expands case rows → per-case Approve (immediate) or Fail/Needs-Revision (prompt)
      each verdict = Flow 3 step 4, PLUS module aggregation check:
        after each verdict the server asks "are ALL sibling reviews completed?"
          ├─ no  → parent ModuleReviewRequest → in_progress
          └─ yes → parent → completed
                  → notify REQUESTER 'review_approved' ("Module review completed")
 3. Shortcut: "Approve All (4)" → POST ?action=approve-all {comment?}
        → per pending child: ReviewEvent(approved) + review completed + case approved
        → parent → completed → notify requester "Module review approved"
        → response {approvedCount: 4, moduleReviewStatus: 'completed'}
 4. Everything refetches; the parent page is now fully read-only
```

**Tables:** `ModuleReviewRequest`, `ReviewRequest` ×N, `ReviewEvent` ×N, `TestCase` ×N,
`ActivityLog`, `Notification`.
**Invariant:** children inherit the parent's cycle; the umbrella auto-completes —
nobody closes it manually.

---

## Flow 5 · Bug reported → triaged by drag & drop → resolved

```
 1. Bugs view → "Report Bug"                    [bugs.tsx]
      dialog: title, severity, environment, module, assignee, descriptions
      POST /api/bugs → server: can('create_bug') → reportedById=me
        → optional BugTestCaseLink rows (none from this dialog today)
        → logActivity(CREATE/bug)
        → assigned? → notification 'bug_assigned' to assignee
 2. Kanban board: assignee drags card open → in_progress
      DndContext onDragEnd → status changed?
      PUT /api/bugs?id= body {status:'in_progress'}    (any authenticated user may)
        → logActivity(UPDATE/bug, before/after full row → field diff)
 3. Later: drag to resolved → PUT {status:'resolved'}
      server stamps resolvedAt = now() (client value ignored)
 4. Admin cleanup of a spam bug: sheet → Delete → DELETE (admin only, hard delete)
```

**Tables:** `Bug` (insert, update, delete), `BugTestCaseLink` (optional),
`ActivityLog`, `Notification` (optional).
**Quirk to remember:** delete has no confirmation dialog; assignment requires
`assign_bug`, movement does not.

---

## Flow 6 · Daily task report → team analytics

```
 1. Tasks view (qa1, date = today)              [tasks.tsx]
      form keyed by {userId}-{date}: 2 task lines
        line 1: "Wrote cases for login flow", 120m, linked Module "Authentication - Login", done
        line 2: "Investigated Safari bug", 60m, linked Bug #{…}, in_progress
      notes: "Need to sync with frontend."
      Save → POST /api/task-reports  (upsert by (me, reportDate))
        server: can('create_task_report') → findFirst(user,date)
          ├─ none → CREATE (first save today)
          └─ found → UPDATE tasks/notes, totalMinutes = Σ = 180
        → logActivity(CREATE|UPDATE/task_report, after/before {totalMinutes})
 2. Same screen later: refetch shows saved lines; edits upsert again (no duplicates,
    DB unique constraint [reportedById, reportDate] is the backstop)
 3. Manager opens Reports → Team summary
      GET /api/stats?action=reports (view_all_task_reports)
        weeklyHours = last 30 days grouped by user + Sunday-week → 3h for qa1 this week
      QA1 row appears in the pivot table + hours bar chart
 4. CSV: qa1 clicks Export on Tasks → tasks-2026-09-04.csv (client-side blob)
```

**Tables:** `TaskReport` (upsert), `ActivityLog`.
**Guard rails:** non-managers only ever see their own rows (API force-filters);
PUT is owner-only (admins included).

---

## Flow 7 · A notification's life (realtime vs fallback)

```
server createNotification(user, type, …)     [lib/notifications.ts]
  1. user exists? active? notifyInapp on?  (else: silent skip)
  2. Notification INSERT (isRead=false)
  3. fetch POST localhost:3003/notify {userId, …payload}   ← not awaited
       WS service: io.to('user:'+userId).emit('notification', payload)
         client hook [use-notification-socket.ts]: store.addNotification
           → topbar bell badge increments immediately
       (Vercel: fetch fails → console.warn ONLY. DB row remains; user sees it via
        the 30s queue polls or on next navigation/refresh. Zero functional loss.)
  4. user clicks it (bell popover or Notifications view)
       → PATCH /api/notifications?id= (isRead=true) + store.markRead
       → navigate by entityType (test_case/bug/module/review)
  5. "Mark all read" → POST ?action=read-all (updateMany)
```

**Tables:** `Notification`.
**Failure modes:** WS off → delayed visibility only; notifyInapp off → nothing at all
(by user choice); every step is try/catch-guarded so notifications can never break a
business operation.

---

## Flow 8 · Admin manages a user (invite → promote → offboard)

```
invite:  Users view → "Invite a new user" → POST /api/users (admin only)
           duplicate email → 400; zod: password ≥ 8; role required (any role)
           → logActivity(CREATE/user)
promote: inline Role select → PUT /api/users?id= {role:'team_lead'}
           → effect: next request that user makes carries the new role in its JWT…
           NOTE: the old access token (≤15 min) still has the old role until expiry
           or refresh — document this when testing permissions!
offboard: trash → confirm → DELETE → isActive:false (soft)
           → login now returns 401 Invalid credentials
           → history preserved: ActivityLog.user is SetNull-safe, author names remain
             via stored entityName / relation snapshots
self:     role/active/delete controls disabled for your own row ("Cannot delete yourself")
```

---

## Cross-flow invariants (the "physics" of TCMS)

1. **Only reviews change case status** (and soft-delete). Edits bump version, never status.
2. **Version up = history row written first.** You can always answer "what changed?".
3. **Every mutation → ActivityLog; every human-relevant mutation → Notification.**
4. **The UI hides forbidden actions; the API enforces them.** Bypassing the UI never bypasses a permission.
5. **No optimistic writes.** Server confirms → toast → cache invalidation → UI updates.
6. **Audit and notifications never break the operation** (both fully try/catch-wrapped).
7. **Deletes are deliberate per entity:** module hard (cascade), case soft (deprecated),
   bug hard (admin), user soft (deactivated).
