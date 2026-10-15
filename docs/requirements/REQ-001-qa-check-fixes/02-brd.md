# REQ-001 BRD: QA-check fixes (7 bugs + B12 + QACHECK test-data cleanup)

Version: 2 · Author: product-owner · Status: DRAFT v2 (phase 3 review changes applied; waiting for the owner's answers to Q1–Q22 and APPROVED in `03-review.md`)
Date: 2026-10-15 · Inputs: `01-kickoff.md`, `03-review.md` (all four reviews), `docs/qa/QA-CHECK-2026-10-15.md` (QA doc), `docs/process/backlog.md`

> **Hard constraints for everyone working on this REQ**
> - The app at http://localhost:3000 (`next dev`, started via `npm run dev`, `package.json:6-8`, `scripts/dev-tcms.mjs:107`) is the owner's running window. **No agent starts, stops, restarts or kills it.** Only a browser reload is allowed. See R10 for the full testing rules.
> - **No data in `tcms_test` is deleted for R9 until the owner has approved the scope, the method and the backup** in `03-review.md` (WORKFLOW.md rule 9). R9 is BLOCKED until then.
> - The server gates that R1–R3 rely on are correct (QA doc §B, lines 67-80). **One server gap was found in review**: `PUT /api/task-reports?id=` ignores `create_task_report` (R11, S2). R11 is the **only** possible API change, and it is in scope only if the owner answers Q15 "yes". No schema or migration change.
> - Database: MySQL 127.0.0.1:5500 `tcms_test` only. Never port 3306 (`agent.md` §6). Every DB-touching script proves its target first (R10.AC11).

All `path:line` citations were opened in this run or in the phase 3 review run unless marked "(from kickoff)".

---

## 1. Problem

A full QA check on 2026-10-15 (QA doc) found that the server side is correct, but:

- **Users see controls they cannot use.** A viewer can fill in the daily work log on /tasks and gets a 403 "Insufficient role" toast on save (bug 1). Every role sees the dashboard buttons "New Test Case", "Report Bug", "Reviews" and "Reports", and some roles land on an "Access restricted" screen or on a list with no create button (bug 2). This breaks the owner's rule "granted → visible AND works; not granted → hidden AND 403" (`CODEBASE-MAP.md:109`).
- **Pages fire requests they know will be refused** (bug 3). Every test-case page opened by a developer, QA engineer or viewer causes a 403. /integrations and /activity-log fire their data requests before their own permission check. This adds noise to the WARN log (QA doc line 83: 182 x 403 in one day).
- **Docs disagree with the repo** (bug 4), so the next reader is misled.
- **Three verification scripts are out of date or unsafe** (bugs 5–7). One fails against a correct app, so DoD item 7 cannot pass (`agent.md:208-209`). The other two cannot run on this MySQL database and would leave test users, documents or a permanent permission override behind.
- **The standards audit is useless on Windows** (B12): every file is reported "not kebab-case".
- **The QA check left test data in `tcms_test`** (QA doc lines 101-114). It shows up in lists, searches, review queues and notifications.
- **(Found in review)** `PUT /api/task-reports?id=` lets a user without `create_task_report` edit an existing own report (`task-reports.service.ts:252-262` has no permission check; POST has one at `:193`). WORKFLOW.md:97 classes "permission wrong" as S2. See R11 / Q15.

## 2. Users and roles affected

Default matrix (`src/lib/permissions.ts:37-63`) for the permission keys this REQ uses:

| Permission key | vp | manager (lead) | product | developer | qa_engineer | viewer |
|---|---|---|---|---|---|---|
| `create_test_case` | yes | yes | yes | no | yes | no |
| `create_bug` | yes | yes | yes | yes | yes | no |
| `perform_review` | yes | yes | yes | no | no | no |
| `submit_review` | yes | yes | yes | no | yes | no |
| `create_task_report` | yes | yes | yes | yes | yes | no |
| `view_all_task_reports` | yes | yes | yes | no | no | no |
| `view_activity_logs` | yes | yes | yes | no | no | no |
| `manage_integrations` | yes | yes | no | no | no | no |

(vp holds every action, `permissions.ts:38`.) Every cell can be changed at runtime by the VP (`role_permissions` overrides). **All UI gates in this REQ must follow the user's effective permissions (`useAuthStore.can`), never the role name** (`CODEBASE-MAP.md:110`).

How each role is affected:
- **viewer:** R1 (read-only work log), R2 (sees fewer dashboard buttons), R3 (no failed calls on test-case pages), R11 (PUT refused, if in scope).
- **developer, qa_engineer:** R2 (some dashboard buttons hidden), R3 (no failed calls on test-case pages; no failed calls if they open /integrations or /activity-log by URL).
- **product:** R3 (no failed Crew Desk calls if they open /integrations by URL).
- **vp, manager, product:** one small visible change: when they view **another user's** day that has no report, they see "No tasks logged for {date}." instead of a blank disabled task row (R1.AC1(b), applies to every read-only view). Otherwise they keep every button and page they have today.
- **Any role whose `create_task_report` the VP has revoked:** own log read-only (R1.AC7, R1.AC8), PUT refused (R11).
- **Engineering team / owner (not an app role):** R4–R8 (docs and tooling), R9 (clean test database), R10 (the running app is not disturbed).

---

## 3. Requirements

### Conventions used in the acceptance criteria
- **C1 Default matrix** = every one of the 126 cells in `GET /api/permissions` has `source: "default"` (QA doc line 35). Matrix state is always read from `GET /api/permissions`, **never** from the `PUT /api/permissions` response, which always says `source: "override"` (`permissions.service.ts:85-90`).
- **C2 Demo accounts** (7, from `src/app/api/seed/seed.service.ts:56-83`; passwords are in that file and are not repeated here): `admin@tcms.com` (vp), `teamlead@tcms.com` (manager), `product@tcms.com` (product), `developer@tcms.com` (developer), `qa1@tcms.com` (qa_engineer), **`qa2@tcms.com` (qa_engineer, used for every qa_engineer write and toggle check)**, `viewer@tcms.com` (viewer). qa1 is not used for writes, because it holds QA-check group B data. qa2's login and current password are NOT VERIFIED (the seed runs only on an empty DB, `seed.service.ts:47-51`).
- **C3 Network evidence** = the browser DevTools Network tab with "Preserve log" on, filtered to `/api/`, **or** an equivalent CDP `Network` capture from the tester's own isolated browser (R10.AC5).
- **C4 Permission refresh** = "after a full page load (F5 or typing the URL) **or** a fresh login". A full load calls `GET /api/auth`, which returns the current permissions before any view renders (`src/store/index.ts:44-62`; `providers.tsx:136-146`). **Client-side navigation does not count.** For every toggle check, the tester records which method was used and captures the `GET /api/auth` response showing the toggled key present or absent. The first toggle check (R1.AC7) runs both methods as a cross-check. If they differ, that is a bug, and every later check uses a fresh login.
- **C5 Test date** = the single past date the owner approves in Q13 (never today). Every tester task-report write uses it.

---

### R1. The /tasks work-log editor follows `create_task_report` (QA bug 1, S3)

**Story:** As a viewer (or any user whose role lacks `create_task_report`), I want the work log shown read-only, so that I am not invited to type a report that the server will refuse.

**Current behavior (verified):** `src/components/views/tasks.tsx:182` sets `isReadOnly = canViewAllReports && effectiveUserId !== user?.userId`. Nothing in the file checks `create_task_report`. The server refuses the save: `src/app/api/task-reports/task-reports.service.ts:193`. With no saved report, the form starts with one blank row (`tasks.tsx:378-380`), so "Export CSV" (`:539` disabled only when `tasks.length === 0`) is enabled and the empty-state text "Add your first entry for {date}." (`:559`) is never reached.

**Expected per permission combination**

| Holds `create_task_report` | Holds `view_all_task_reports` | Own log | Another user's log (user picker) | Notice shown |
|---|---|---|---|---|
| yes | yes (vp, manager, product) | editable (unchanged) | read-only, picker shown (unchanged) | other user: N2 |
| yes | no (developer, qa_engineer) | editable (unchanged) | no picker (unchanged) | none |
| no | no (viewer) | **read-only** | no picker (unchanged) | own: **N1** |
| **no** | **yes** (only via a VP override, e.g. manager) | **read-only** | read-only, picker shown | own: **N1**; other user: **N3** |

Exact notice texts (character for character; quotes are straight ASCII `"` U+0022, apostrophe is ASCII `'` U+0027). N1 is pending owner confirmation in Q11.
- **N1:** `Your role can view work logs but cannot log work. A VP can enable "Create task reports" for your role under Permissions.`
- **N2 (unchanged):** `You are viewing another user's report. Switch back to yourself to make edits.`
- **N3:** `You are viewing another user's report.`

N1 is rendered as the same plain `Alert` as `tasks.tsx:310-314`, not as `PermissionDenied`, because the page itself is allowed. **Never more than one notice at a time.**

**Acceptance criteria**

- **R1.AC1** Given the default matrix and the viewer is logged in, when they open `/tasks`, then: no "Add task" button (card header or empty state), no "Save report" button, no remove control on task rows, and exactly one notice, N1, above the log. In addition:
  - (a) **date with a saved report:** every task-row input and the Notes box are shown and disabled;
  - (b) **date with no saved report:** no blank task card is shown; the empty state reads `No tasks logged for {date}.` (date as shown in the Date field), with no "Add your first entry" line; "Export CSV" is disabled.
- **R1.AC2 (chained after R1.AC7)** Given the viewer saved a report on the C5 date while granted (R1.AC7), and the VP has revoked the grant again, when the viewer reloads (C4) and opens that date, then the saved entries are shown, every input is disabled, there is no "Save report" and no "Add task", and N1 is shown. When the viewer switches to any other date without a report, R1.AC1(b) holds.
- **R1.AC3** Given the viewer (and, under R1.AC8, the manager without `create_task_report`) is on `/tasks`, when the tester watches the C3 network evidence during the whole visit, then no `POST /api/task-reports` and no `PUT /api/task-reports?id=…` request is sent.
- **R1.AC4** Given the viewer is on `/tasks`, then the read-only features still work: the "Export" button under the "Monthly report" label (`tasks.tsx:279`, `:301`) downloads the viewer's own month (`GET /api/task-reports?action=export…`, allowed for everyone and locked to own data, `task-reports.service.ts:114-126`). "Export CSV" (`:541`) is enabled only when the shown day has saved entries, and disabled for R1.AC1(b). Downloads go to the tester's scratchpad and are deleted after the check.
- **R1.AC5 (regression, minimal writes)** Given the default matrix:
  - **Real saves (2):** product (report-holder path, `tasks.tsx:127-137`) and qa2 (own-reports path, `:112-116`) each open `/tasks` on the C5 date, add one task (description containing emoji and Hindi text, 15 minutes) and click "Save report". Each save returns 200 with a success toast. The tester records each `taskReportId` (group I).
  - **No save (3+):** for vp, manager and developer, the tester checks only that the editor is enabled and "Save report" is visible, and does not click it.
- **R1.AC6** Given vp, manager or product (default matrix) picks another user in the "User" picker, then the read-only view shows N2 exactly as today (`tasks.tsx:309-315`). If that user has no report for the date, R1.AC1(b) applies (empty state, no blank row).
- **R1.AC7 (follows the matrix)** Inside the toggle window (R10.AC9):
  - Given the VP turns `create_task_report` **off** for `qa_engineer`, when qa2 refreshes per C4 (both methods, cross-check), then qa2's own log is read-only exactly as in R1.AC1, with N1.
  - Given the VP turns `create_task_report` **on** for `viewer`, when the viewer refreshes per C4, then the viewer's own log is editable, and one save on the C5 date returns 200 (recorded in group I; reused by R1.AC2 and R11.AC2).
  - Each cell is restored right after its check, and all 126 cells are default at the end (C1).
- **R1.AC8 (holder without create)** Inside the toggle window, given the VP turns `create_task_report` **off** for `manager`, when teamlead refreshes per C4, then:
  - own log: read-only with N1; the user picker is still shown;
  - another user picked: read-only with N3 (not N2);
  - never two notices at once;
  - no `POST`/`PUT /api/task-reports` is sent (R1.AC3).

  The VP restores the cell, and all 126 cells are default (C1).

**Error cases**
- A user without `create_task_report` who sends `POST /api/task-reports` some other way still gets **403 `{ "error": "Insufficient role" }`** (unchanged, `task-reports.service.ts:193`). For `PUT`, see R11.
- If the work log fails to load, the existing alert "Could not load the work log" (`tasks.tsx:317-323`) is shown for every role, viewer included (unchanged). Test method: block `/api/task-reports*` **in the tester's own browser only** (DevTools request blocking or CDP `Network.setBlockedURLs`). The server is never touched.
- Double click on "Save report": Save is disabled while pending (`tasks.tsx:616`); no second row (upsert). The tester records the notification count.

---

### R2. Dashboard buttons follow the user's permissions (QA bug 2, S4)

**Story:** As a user of any role, I want the dashboard to show only actions I can use, so that a click never ends on "Access restricted" or on a page with no create button.

**Current behavior (verified):** in `src/components/views/dashboard-v2.tsx`, the header buttons "New Test Case" (`:280-285`) and "Report Bug" (`:286-292`) are ungated. "Reports" is already gated with `can('view_all_task_reports')` (`:293`). The Quick Actions (`:682-687`) are all ungated. The tester checked every `navigate(` call in the file: the gated targets are only `reviews`, `review-detail` (already behind `perform_review`), `reports` and `activity-log`. The list below is complete.

**Gate map**

| Button (location) | Navigates to | Show only when the user holds | Why this key |
|---|---|---|---|
| "New Test Case" (header `:280`, Quick Action `:682`) | /test-cases | `create_test_case` | create button on /test-cases uses `can('create_test_case')` (`test-cases.tsx:70`) |
| "Report Bug" (header `:286`, Quick Action `:683`) | /bugs | `create_bug` | create button on /bugs uses `can('create_bug')` (`bugs.tsx:54`) |
| "Reviews" (Quick Action `:684`) | /reviews | `perform_review` | /reviews shows PermissionDenied without it (`reviews.tsx:84`); sidebar `sidebar.tsx:49` |
| "Reports" (header `:293`, already gated; Quick Action `:687`) | /reports | `view_all_task_reports` | /reports shows PermissionDenied without it (`reports.tsx:56-57`); sidebar `sidebar.tsx:53` |
| "Tasks" (Quick Action `:685`) | /tasks | any logged-in user | no page gate (`sidebar.tsx:52`) |
| "Modules" (Quick Action `:686`) | /modules | any logged-in user | no page gate (`sidebar.tsx:46`) |

**Acceptance criteria**

Expected visible buttons with the default matrix ("yes" = visible, "no" = not rendered at all). qa1 and qa2 behave identically.

| Button | vp | manager | product | developer | qa_engineer | viewer |
|---|---|---|---|---|---|---|
| Header "New Test Case" | yes | yes | yes | **no** | yes | **no** |
| Header "Report Bug" | yes | yes | yes | yes | yes | **no** |
| Header "Reports" (unchanged) | yes | yes | yes | no | no | no |
| Quick Action "New Test Case" | yes | yes | yes | **no** | yes | **no** |
| Quick Action "Report Bug" | yes | yes | yes | yes | yes | **no** |
| Quick Action "Reviews" | yes | yes | yes | **no** | **no** | **no** |
| Quick Action "Tasks" | yes | yes | yes | yes | yes | yes |
| Quick Action "Modules" | yes | yes | yes | yes | yes | yes |
| Quick Action "Reports" | yes | yes | yes | **no** | **no** | **no** |

- **R2.AC1** Given the default matrix, when each of the 6 role accounts logs in and opens `/dashboard`, then the header and Quick Actions buttons in the DOM match the table exactly. Hidden buttons are not rendered. Disabled or greyed-out buttons do not count as hidden.
- **R2.AC2** Given any role, when the user clicks every dashboard button visible to them, then the target page shows its content. No click lands on a PermissionDenied ("Access restricted" / "No access") screen. For "New Test Case" the /test-cases page shows its create button; for "Report Bug" the /bugs page shows its create button. No item is created.
- **R2.AC3 (layout)** Given the viewer opens `/dashboard`, at the default desktop width and at about 400 px:
  - the Quick Actions card shows exactly "Tasks" and "Modules", with no empty tile and no overlapping tiles;
  - the header button group, which is now empty for the viewer, is not rendered and leaves no visible empty gap.
- **R2.AC4 (follows the matrix)** Inside the toggle window (R10.AC9):
  - Given the VP turns `create_bug` on for `viewer`, when the viewer refreshes per C4, then both "Report Bug" buttons are visible and lead to /bugs, where the create button is **present**. The tester does **not** submit a bug.
  - Given the VP turns `perform_review` on for `developer`, when the developer refreshes per C4, then the "Reviews" Quick Action is visible and /reviews opens.
  - Both cells are restored right after, and C1 holds at the end.
- **R2.AC5** Given vp or manager, then the dashboard shows every button it shows today (regression).
- **R2.AC6 to R2.AC8: only if the owner answers Q10 "yes".**
  - **R2.AC6 "My Pending Reviews" KPI card** (`dashboard-v2.tsx:357-371`). For users **without** `perform_review`:
    - (a) the card element is not a `<button>` and has no `role="button"` and no `tabindex` (DOM check); pressing Tab through the KPI row never focuses it;
    - (b) no chevron icon element is rendered inside the card (DOM check);
    - (c) clicking the card leaves the URL at `/dashboard` and sends no new request to `/api/reviews*`;
    - (d) the number shown equals the hero chip "pending reviews" (both from `data.myPendingReviews`, `:274`, `:362`).

    For vp, manager and product (positive case): the card is still a focusable `<button>` and opens `/reviews`.
  - **R2.AC7 Focus Queue link** "+ N more · view reviews" (`:661-669`) is not rendered for users without `perform_review`. **Evidence:** code review in `06-dev-report.md`. The link renders only above 8 Focus items (`:239`), and the current data does not reach that for roles without `perform_review`. A runtime check is done only if some role already has more than 8 items; otherwise the runtime part is reported NOT VERIFIED. No fixture bugs are created for this.
  - **R2.AC8** The "View all" button on the Latest Activity card (`:699`) is not rendered for users without `view_activity_logs`. The activity list on the dashboard itself is unchanged (`src/app/api/stats/stats.service.ts:76-78`).

**Error cases:** none. Buttons are only hidden. Target pages keep their own in-page guards (`reviews.tsx:84`, `reports.tsx:56`). The dashboard error state (`dashboard-v2.tsx:156-168`) is unchanged and can be checked with browser-side request blocking (as in R1).

**Out of scope here:** "New Test Case" opening the create dialog (B15).

---

### R3. Pages do not fire requests they know will be refused (QA bug 3, S4)

**Story:** As a user without a given permission, I want pages not to call endpoints I cannot use, so that I see no hidden failures and the server log is not filled with expected 403s.

**Current behavior (verified):**
- `src/components/views/test-case-detail.tsx:69-73`: the activity query (`GET /api/activity-logs?action=entity&type=test_case&id=…`) has `enabled: !!id` only. The server requires `view_activity_logs` (`activity-logs.service.ts:31`). Without data, the "Activity" card shows "No activity yet" (`test-case-detail.tsx:320-329`), which is wrong information.
- `src/components/views/integrations.tsx:68`, `:69-72`, `:73-77`: Crew Desk config, links list and email check run before the page gate at `:216`. The server refuses them without `manage_integrations` (`crewdesk.service.ts:122-126`). The modules-tree query at `:67` is an any-user call and stays.
- `src/components/views/activity-log.tsx:88-92`: the feed query runs before the gate at `:97`. The server refuses it without `view_activity_logs` (`activity-logs.service.ts:57`). The users-options query at `:69-73` stays.
- The frontend reviewer grepped every caller of `activityLogsApi.*` and `crewdeskApi.config|list|emailCheck`: these three files are the only ones.

**Acceptance criteria**

| Page | Request that must not be sent without the permission | Permission | Roles that must send no such request (default matrix) | Roles that keep the request |
|---|---|---|---|---|
| /test-cases/[id] | `GET /api/activity-logs?action=entity&type=test_case&id=…` | `view_activity_logs` | developer, qa_engineer, viewer | vp, manager, product |
| /integrations | `GET /api/integrations/crewdesk?path=config`, `GET /api/integrations/crewdesk?pageSize=50`, `GET /api/integrations/crewdesk?path=email-check` | `manage_integrations` | product, developer, qa_engineer, viewer | vp, manager |
| /activity-log | `GET /api/activity-logs?page=…` (feed) | `view_activity_logs` | developer, qa_engineer, viewer | vp, manager, product |

- **R3.AC1** Given the default matrix, for each role in the "must send no such request" column, and for **each** of these ways to reach the page:
  1. typing the URL;
  2. a full reload while on the page;
  3. browser back and forward to the page;
  4. (test-case detail only) clicking a case in /test-cases, in /modules/[id], and from Ctrl+K search;

  when the tester watches the C3 network evidence from page load until 30 s later, then **no** request to the listed endpoint is sent and **no** `/api/*` response on that page has status 403. A 401 followed by a token refresh and a successful retry is normal (`agent.md:127-129`) and is not a failure.
- **R3.AC2** Given the roles in the "keep the request" column, when they open the same page, then the request is sent and returns 200. The one exception is `?path=email-check`, which may return the existing environment response 502 "Crew Desk integration is not configured" (QA doc line 63). Any other status fails. The page shows the same content as today.
- **R3.AC3** Given a developer, qa_engineer or viewer opens `/test-cases/[id]`, then the "Activity" card follows the owner's answer to **Q12** (recommended: the card is not rendered at all). For vp, manager and product the card shows the case's activity as today.
- **R3.AC4** Given product, developer, qa_engineer or viewer opens `/integrations` by URL, then the existing PermissionDenied screen is shown with its current text (`integrations.tsx:216-225`, unchanged).
- **R3.AC5** Given developer, qa_engineer or viewer opens `/activity-log` by URL, then the existing PermissionDenied screen "The activity log is only available to roles with view-activity-log rights." is shown (`activity-log.tsx:97-98`, unchanged).
- **R3.AC6 (follows the matrix)** Inside the toggle window, given the VP turns `view_activity_logs` on for `qa_engineer`, when qa2 refreshes per C4 and opens a **seed** test case that has activity (named in `05-test-plan.md` before the run), then the activity request is sent, returns 200, and the Activity card shows that activity. The cell is restored right after.
- **R3.AC7 (log evidence)** Given a recorded **UTC** time window (start and end written in `07-test-report.md`) in which the tester runs the R3 pass, **no suite runs and the owner does not use those pages** (R10.AC10), when the tester searches `logs/app-<date>.log` for that window, then it contains **0** lines matching `/api/activity-logs` or `/api/integrations/crewdesk` with `-> 403`. (The WARN line has no user id, `src/lib/api.ts:241`, so attribution comes only from the exclusive window.)

**Error cases:** none new. The server's 403 responses are unchanged and stay the real gate (`agent.md:136-137`).

---

### R4. Documentation matches the repo (QA bug 4, S4)

**Story:** As an engineer or agent reading the project docs, I want them to match the files and suites as they are, so that I do not waste time or act on false information.

**Current status of the three QA findings (verified):**
- (a) **Battery count 63 vs 67: mostly resolved.** `agent.md` §3 and `CODEBASE-MAP.md` §10/§11 no longer state a count. The only "63" left is `docs/README.md:75`, which describes the migration-time dossier. The newest worklog runs show 67 (`worklog.md:1547`, `:1566`).
- (b) **`auth-screen.tsx` path: still wrong** (`CODEBASE-MAP.md:114`, `:120`; the file is `src/components/auth-screen.tsx`, from kickoff: glob).
- (c) **`.zscripts/`: resolved** (`agent.md:250-253`, `CODEBASE-MAP.md:37`).

Docs that must follow this REQ's behavior changes: `agent.md:208-209` (DoD item 7), `docs/06-page-login-and-dashboard.md:74-76` and `:93-94`, `CODEBASE-MAP.md:126`. If R11 is in scope: `docs/04-api-reference.md:206`. **New finding (review):** `docs/04-api-reference.md:216` says the entity activity feed is "any authenticated", but the server requires `view_activity_logs` (`activity-logs.service.ts:31`). See Q22.

**Acceptance criteria**
- **R4.AC1** `CODEBASE-MAP.md` gives the correct location of `auth-screen.tsx` (`src/components/auth-screen.tsx`). A tester can open every path named in the §6 routes table (`CODEBASE-MAP.md:118-132`) at the stated location.
- **R4.AC2** `docs/README.md:75` is handled as the owner decides in **Q8** (recommended: unchanged). Either way, no current-state document (`agent.md`, `CODEBASE-MAP.md`) states a battery count that differs from the newest worklog run (67).
- **R4.AC3** `agent.md` §3 item 7 no longer says the suite still has to be updated. It reads as a plain DoD item: `node scripts/verify-review-matrix.mjs` → `36 passed, 0 failed`.
- **R4.AC4** `docs/06-page-login-and-dashboard.md` describes the dashboard buttons with their permission gates as delivered under R2. If Q10 is "yes" this includes the KPI card and the "View all" link.
- **R4.AC5** `CODEBASE-MAP.md` §6 row `/tasks` states both gates: `view_all_task_reports` for the team view and `create_task_report` for editing your own log.
- **R4.AC6** No agent edits `agent.md`, `CODEBASE-MAP.md`, `docs/README.md`, `docs/04-api-reference.md` or `docs/06-page-login-and-dashboard.md` unless the owner gives the edit right in **Q2**. Until Q2 is answered, R4 is **BLOCKED for editing**. The tester checks this with `git log -p` on those files.
- **R4.AC7** `.zscripts/` needs no change. The tester only confirms the current wording at `agent.md:250-253` and `CODEBASE-MAP.md:37`.
- **R4.AC8 (only if Q22 = yes)** `docs/04-api-reference.md:216` states that `GET /api/activity-logs?action=entity` requires `view_activity_logs`.
- **R4.AC9 (only if Q15 = yes)** `docs/04-api-reference.md:206` states that `PUT /api/task-reports?id=` requires `create_task_report` **and** ownership, and lists the 403 "Insufficient role".

**Error cases:** not applicable (documentation).

---

### R5. `verify-review-matrix.mjs` checks the current reviews rule (QA bug 5, S3)

**Story:** As the owner running the Definition of Done, I want the review-matrix suite to expect what the app is meant to do, so that DoD item 7 passes on a correct app and fails on a wrong one.

**Target rule (the owner approves it in phase 4, because it changes existing assertions):** only `perform_review` grants `GET /api/reviews` (list) and `GET /api/module-reviews?action=all`. `submit_review` alone grants neither. Ground truth: `src/app/api/reviews/reviews.service.ts:58-62`, `src/app/api/module-reviews/module-reviews.service.ts:102-107`, the UI (`sidebar.tsx:49`, `:76`; `reviews.tsx:84`).

**Current behavior (verified):** `scripts/verify-review-matrix.mjs:52` and `:74` compute the expectation as `hasPerform || hasSubmit` (QA doc line 92: `34 passed, 2 failed`). The suite runs 6 checks per account (`:56`, `:60`, `:67-70` ×2, `:76`, `:85`) for 6 accounts = 36.

**Acceptance criteria**
- **R5.AC1** Given the default matrix and the running app, when `node scripts/verify-review-matrix.mjs` runs on the owner's Windows machine, then it prints **exactly** `REVIEW-MATRIX RESULT: 36 passed, 0 failed` and exits 0. A different total is allowed only if `05-test-plan.md` lists each added check before the run.
- **R5.AC2** For `GET /reviews` and `module-reviews?action=all` the suite expects **200 for vp, manager, product** and **403 for developer, qa_engineer, viewer**.
- **R5.AC3** Both expectations are computed from `perform_review` alone, from the session's effective permissions (`:49-50`), not from a role name. The comment at `:72-73` is updated to match. `hasSubmit` may stay in the log line (`:53`) for diagnosis only.
- **R5.AC4 (no weakening)** No check is removed, skipped or loosened. The total is not below 36.
- **R5.AC5** The suite is read-only. It creates no rows other than login refresh tokens and login activity.
- **R5.AC6** It runs only under the serial rule (R10.AC10), because its expectations come from the login snapshot and a concurrent matrix toggle would make it flaky.

**Error cases:** app unreachable or a failed login → `PROBE ERROR: …`, exit 1 (unchanged, `:97`).

---

### R6. `verify-wiki.mjs` runs on MySQL and leaves nothing behind (QA bug 6, S3)

**Story:** As the owner, I want the wiki suite to run on this MySQL database and to restore everything it touches, so that I can run it any time without polluting `tcms_test` or changing the permission matrix.

**Current behavior (verified):**
- `scripts/verify-wiki.mjs:231-233` uses PostgreSQL `ON CONFLICT … DO UPDATE` and `NOW()` (breaks D7, `docs/process/decisions.md:14`). The grant is written by SQL, which skips cache invalidation and the audit row (`permissions.service.ts:65-83`).
- Everything runs as top-level code with no try/finally (`:29-52`, cleanup `:251-271`). A throw leaves 6 users `wiki-{vp,mgr,prod,qa,dev,viewer}-<stamp>@tcms.test` (created with an ORM call at `:30`) and their documents.
- `:245` deletes the developer `create_wiki_doc` / `delete_wiki_doc` override rows without checking whether they existed before the run.
- Writes use `$queryRaw` (`:231`, `:245`, `:267-271`).

**Acceptance criteria**
- **R6.AC1** Given the default matrix and the running app, when `node scripts/verify-wiki.mjs` runs on the owner's Windows machine, then it prints raw counts `PASS=<n> FAIL=0`, ends with `RESULT: ALL WIKI API CHECKS GREEN`, and exits 0. `<n>` equals the executed-check count that the sdet fixes in `05-test-plan.md` by code reading **before** editing (existing checks + each new restore/residue check, listed). Note: 48 lines contain `ok(`, one of them is the definition at `:18`.
- **R6.AC2 (MySQL, D7, raw SQL)** A text search of the file finds no `ON CONFLICT`, no `NOW()`, no `INSERT IGNORE` and no ORM model call (`db.<model>.<method>`). Every write uses `$executeRaw`. Every **new** timestamp uses `UTC_TIMESTAMP(3)`. The only exception: the restore may write back a **captured** `updated_at` value (R6.AC3).
- **R6.AC3 (precondition and exact restore)**
  - (i) **Default state:** given both cells `developer/create_wiki_doc` and `developer/delete_wiki_doc` have no override row, the run is green (R6.AC1). Afterwards both cells again have no row, and the full 126-cell `GET /api/permissions` equals the snapshot taken before the run.
  - (ii) **Non-default state:** given either cell has an override row before the run, the suite detects it at start, prints `PRECONDITION: …` naming the cell, creates nothing, exits **2**, and the row is byte-identical afterwards (`enabled`, `updated_by_id`, `updated_at`).
  - **Restore mechanism:** before any write, the suite snapshots the touched cells' rows by SQL. In cleanup it restores exactly those rows by SQL (delete, or `INSERT … ON DUPLICATE KEY UPDATE` with the captured values), waits at least 3.5 s (3 s permission cache, `src/lib/permissions.ts:70`), and then compares the full `GET /api/permissions` with the pre-run GET snapshot. It never reads the PUT response (C1).
- **R6.AC4 (no residue, ID-scoped)** Given the run finished, then the residue checker (R10.AC13) reports **0** rows for the run's stamp and fixture user ids in: users, wiki_documents (by fixture `author_id`, which also catches the unstamped docs at `:180`, `:192`, `:247`), activity_logs (by fixture `user_id`), notifications, refresh_tokens. Global table counts are supplementary and valid only in an exclusive window (R10.AC10).
- **R6.AC5 (cleanup on failure and interrupt)** Given a failure forced through the script-only env hook `VERIFY_FAIL_AT=<step>` (at least `after-fixtures`, `after-grant`, `mid-cleanup-docs`), **and** given a Ctrl+C during the run, then cleanup still runs, R6.AC3(i) and R6.AC4 still hold, and the exit code is not 0. `after-grant` proves the suite restores its **own** grant. Each cleanup step reports separately, and a failed step does not skip the later ones. Any cleanup error forces a non-zero exit.
- **R6.AC6 (no weakening)** Every existing check in sections 1–9 (`:59-264`) is kept with the same expected status codes.
- **R6.AC7** The suite runs with plain `node` on Windows with no Linux tool (`agent.md:259-261`) and passes the DB guard (R10.AC11) before any statement.
- **R6.AC8 (grant through the real path)** The section-8 grant is made with `PUT /api/permissions` as the fixture VP, not by SQL. This is a strengthening. The audit rows it writes belong to the fixture VP and are removed with that user's activity_logs.
- **R6.AC9 (killed-run recovery)** The suite prints its stamp as the first output line. `node scripts/verify-wiki.mjs --cleanup-stamp=<n>` runs only the cleanup and restore for that earlier run, and the residue checker then reports 0 for that stamp.
- **R6.AC10 (concurrency guard)** If any cell the suite did **not** touch differs between the start and end GET snapshots, the suite does **not** restore that cell, reports FAIL `matrix changed by another actor`, and exits non-zero.

**Error cases:** a failed login is reported by role (never the password), then cleanup runs (R6.AC5).

---

### R7. `verify-permission-matrix.mjs` runs on this database with the default matrix and leaves nothing behind (QA bug 7, S3)

**Story:** As the owner, I want the full permission-matrix suite to run on a normal `tcms_test` (7 demo users, default matrix), so that I can prove every role × action rule without preparing special data and without leaving a permission override behind.

**Current behavior (verified):**
- It logs in as `qamarathon.{vp,…}@tcms.dev` (`:44-51`), takes the viewer from self-signup (`:38-42`) and needs a module "QA Marathon Alpha" (`:68-70`, crashes if missing). This database has only the demo users (QA doc line 154).
- It logs in as **demo** `admin@tcms.com` for setup (`:57`) and resets `viewer/create_bug` and `viewer/create_test_case` to default **unconditionally** at start (`:61-66`), which destroys any real VP override.
- Its expectations assume seeded overrides giving developer and qa_engineer `perform_review` (`:5-6`). The round-trip re-grants developer `perform_review` (`:284`) and **asserts the override remains** (`:309`).
- It never deletes what it creates. Several probes create rows with **no stamp** (`:105`, `:148`, `:216`).
- The "create task report" probe (`:164-168`) posts a report dated today. Each save notifies **every active `view_all_task_reports` holder** (`task-reports.service.ts:158-183`), which includes demo admin, teamlead and product, and email/Telegram delivery is attempted per recipient preference (`src/lib/server/delivery.ts:146-173`). The submit probe (`:115`) sends `{}`, so the server auto-picks a VP/manager reviewer (`modules.service.ts:247-248`, per backend review).
- The toggle probe (`:199-205`) never checks the status of its restore.
- Executed checks today: 2 signup + 1 fixtures + 150 probes + 10 round-trip + 2 hygiene = **165**.

**Target (Q9, recommended):** stamped fixture users (one per role) and a fixture module, default matrix, everything removed afterwards.

**Acceptance criteria**
- **R7.AC0 (precondition replaces the reset)** The unconditional reset at `:61-66` is removed. At start, the suite reads `GET /api/permissions`. If any of the 126 cells is not `source: "default"`, it prints `PRECONDITION: …` with the cells, makes no write, and exits **2**.
- **R7.AC1** Given `tcms_test` with the demo users and seed data (no `qamarathon.*` users, no "QA Marathon Alpha") and the default matrix, when `node scripts/verify-permission-matrix.mjs` runs on the owner's Windows machine, then it prints `RESULT: <n> passed, 0 failed` with `<n>` = the R7.AC9 count, and exits 0.
- **R7.AC2 (expectations = default matrix)** All 25 matrix probes (`:98-252`) run for all 6 roles. Each expectation agrees with `DEFAULT_PERMISSIONS` (`permissions.ts:37-63`) and the owner rules the probes already document. Nothing assumes developer or qa_engineer holds `perform_review`.
- **R7.AC2b (raw SQL)** Any SQL the suite runs follows R6.AC2 (raw SQL, `$executeRaw` for writes, no ORM model calls, D7).
- **R7.AC3 (verdict round-trip on the default matrix)** (1) a review is assigned to the fixture developer; (2) the developer's verdict returns 403 (default, no `perform_review`); (3) the fixture VP grants developer `perform_review`; (4) the verdict returns 200; (5) the fixture VP turns it off. The hygiene check asserts that `developer/perform_review` reads `source: "default"`, `enabled: false` from `GET /api/permissions`. This replaces the `:309` assertion.
- **R7.AC4 (matrix unchanged)** Given the 126-cell GET snapshot taken at start (all default per R7.AC0), when the run ends (pass or fail), then all 126 cells are identical. Touched cells (`viewer/create_bug`, `viewer/create_test_case`, `developer/perform_review`) are restored as in R6.AC3, and the concurrency guard R6.AC10 applies.
- **R7.AC5 (signup independence, D3)** `TCMS_ALLOW_SIGNUP` is never changed (`agent.md:262`). When signup is open, the suite asserts the new account is a `viewer` with no permissions, and that account is cleaned up by id like the other fixtures. When signup is closed, it asserts the register call returns **403** and no user is created. **Accepted evidence:** the open branch at runtime, plus a code reading of `src/app/api/auth/auth.service.ts:167-173` for the closed branch (403 before any DB write).
- **R7.AC6 (no residue, ID-scoped)** Given the run finished (pass or fail), then the residue checker reports **0** rows created by the run (keyed on fixture user ids and the ids the run collected, not on titles) in: users, modules, test_cases, test_case_history, review_requests, review_events, module_review_requests, bugs, bug_test_case_links, wiki_documents, task_reports, role_permissions, activity_logs (authored by fixture users), refresh_tokens, and notifications (by fixture `user_id` **and** by `entity_type`/`entity_id` of every entity the run created, which covers notifications addressed to demo users). Global counts follow R10.AC10.
- **R7.AC7 (demo data untouched)** After cleanup, no row remains that the run created, including notifications addressed to demo users. No demo user's `task_reports` row, profile or password is created or changed, and no seed module, case or bug is changed. The `edit module` probe (`:141-145`) points at the fixture module.
- **R7.AC8 (cleanup on failure and interrupt)** As R6.AC5 (`VERIFY_FAIL_AT`, Ctrl+C), with R7.AC4 and R7.AC6 still holding and a non-zero exit. Killed-run recovery as R6.AC9 (`--cleanup-stamp=<n>`).
- **R7.AC9 (exact count, no weakening)** No probe is removed. Today's executed count is 165. The ported suite's exact count is fixed in `05-test-plan.md` before the edit, with one line per added or changed check, and the suite must print exactly that count. Matrix checks stay at 150 (25 × 6).
- **R7.AC10 (no demo login)** Setup and every probe use only stamped fixture users created by SQL. No demo account logs in, so no demo refresh token or LOGIN activity row is created. Fixture passwords are generated in memory and never printed.
- **R7.AC11 (explicit reviewer)** Every review submission passes an explicit fixture `reviewerId`, so no demo VP/manager is picked or notified. This changes the target, not the asserted status.
- **R7.AC12 (notification side effect: owner precondition)** Before the first run, the owner has answered **Q17** (email/Telegram) and **Q19** (transient in-app notifications to demo report holders). The create-task-report probe still notifies demo holders in-app during the run, because the server notifies every active holder. Those rows are deleted at cleanup (R7.AC6), but an email or Telegram message cannot be recalled.
- **R7.AC13 (toggle probe)** The toggle probe (`:199-205`) checks the status of its own restore with `check()`. That adds a check and removes none.

**Error cases:** if setup fails, the suite names the failed step, runs cleanup, and exits 1. It never prints a password.

---

### R8. `audit-standards.mjs` gives real results on Windows (backlog B12)

**Story:** As the owner, I want the standards audit to report only real violations on Windows, so that its output is usable as the "report only" step of the DoD (`agent.md:214`).

**Current behavior (verified):** `scripts/audit-standards.mjs:89` takes the file name with `file.split('/').pop()`. The paths come from `path.join` (`:18`), which uses `\` on Windows, so the "name" is the whole path and fails the kebab-case test (`:90-91`). Backlog B12 records 193 false positives.

**Acceptance criteria**
- **R8.AC1** Given the current `src/` tree, when `node scripts/audit-standards.mjs` runs on the owner's Windows machine, then no `[naming]` finding names a file whose base name is kebab-case.
- **R8.AC2** In every `[naming]` finding, the quoted name is the file's base name only.
- **R8.AC3 (rule still works: `--self-test`)** `node scripts/audit-standards.mjs --self-test` runs the **same** naming function the audit uses on fixed sample names and prints `PASS=<n> FAIL=0`. `BadName.ts` and `bad_name.service.ts` must be reported as violations; `test-cases.service.ts` and `page.tsx` must pass. No file is added under `src/`.
- **R8.AC4** The full raw output of the fixed audit is pasted in `06-dev-report.md`. Real violations it reports are **not** fixed in REQ-001. The manager lists them for the backlog.
- **R8.AC5 (baseline first, same tree)** Before line 89 is edited **and before any `src/` edit of this REQ**, the sdet records `git rev-parse HEAD` and an empty `git status --porcelain src`, runs the unmodified audit, and saves stdout **and** stderr together plus the exit code (Git Bash `> file 2>&1`; not PowerShell 5.1 redirection). The fix is applied and the audit runs again immediately on the same tree. Both raw files go to `docs/requirements/REQ-001-qa-check-fixes/evidence/`. Comparison: drop the `[naming]` lines from both, sort, diff (must be empty), and the file count in the summary line (`:109`) is unchanged.
- **R8.AC6 (diagnosis check)** In the baseline, the number of `[naming]` findings equals the "across N TS files" count. If it does not, the sdet stops and reports, because the B12 diagnosis would then be incomplete.

**Error cases:** not applicable (exit code 1 when violations exist, unchanged `:108-111`).

---

### R9. Remove the QA-check test data from `tcms_test`. **BLOCKED until the owner answers Q3, Q4, Q5, Q6 and Q20 and approves the dry-run list.**

**Story:** As the owner, I want the test data left by the 2026-10-15 QA check (and by this REQ's own testing) removed, exactly as I approve it, so that lists, searches, review queues and notifications show only real or demo data.

> **Nothing is deleted under R9 until all of these are true:**
> 1. The owner has answered Q3, Q4, Q5, Q6 and Q20 in `03-review.md`.
> 2. A fresh backup of `tcms_test` exists (R9.AC1).
> 3. A dry run has printed the exact row list and the owner has written approval of that list.

**Why the method matters (verified in review):** the API cannot do this cleanup alone. There is no DELETE endpoint for task_reports, reviews or module-reviews (DELETE handlers exist only in bugs, modules, notifications, test-cases, users, wiki). Users are soft-delete only (`users.repository.ts:102-107`). Deleting a module **orphans** its cases and bugs (`migration.sql:330`, `:381` SET NULL), so they stay visible in /test-cases and search. A "soft only" cleanup also fails, because search does not filter `deprecated` (`search.repository.ts:51`), and modules, bugs, wiki docs and reviews have no soft state.

**Candidate inventory** (QA doc lines 101-114, kickoff groups, and review findings. **No row was checked in the database.**)

| Group | Rows | How identified |
|---|---|---|
| A | Module "QACHECK module 1792076976458"; cases "QACHECK tc1/tc2/tc3", "QACHECK qa case"; 1 pending module review + 1 pending case review (assigned to product); wiki "QACHECK wiki"; bugs "QACHECK bug", "QACHECK dev bug" | "QACHECK" prefix |
| B | qa1's `task_reports` row for 2026-10-15 | user + date |
| C | Cases "Imported: <stamp> …" in seed module "Authentication - Login" (every run, including this REQ's DoD runs) | title prefix (`verify-import.mjs:83`) |
| D | "Perm-verify case <ts>" (`verify-permissions.mjs:56`); the module review it raises on the first submodule (`:54`, `:63`, one per run); bug "Permission battery temp bug" (`:111`, only if no bug exists; otherwise the first existing bug's status/assignee is changed, `:107-122`) | prefixes; module review on the first submodule. Handling per **Q20** |
| E | verify-notifications temp users, already soft-deleted | `notif-verify-<stamp>@tcms-test.com` (`verify-notifications.mjs:50`, `:192-193`) |
| **E2** | Bug "Verify notification <stamp>" in the first module, assigned to the temp user, plus its `bug_assigned` notification (every run) | title prefix (`verify-notifications.mjs:171-189`) |
| F | refresh_tokens, notifications from the above (activity_logs per Q5) | user id / `entity_type` + `entity_id` |
| G | Permission overrides | verify only: all 126 cells default |
| H | B8 `self-*@tcms.test` accounts | per Q4 (recommended out) |
| **I** | **REQ-001 tester rows:** the task reports saved under R1.AC5 and R1.AC7 (by `taskReportId` recorded in `07-test-report.md`), their `daily_report_submitted` notifications (`entity_type='task_report'`, `entity_id`) | ids from `07-test-report.md` |
| **J** | **Killed suite runs:** leftover `wiki-%-%@tcms.test` users and the R7 fixture email pattern (named in `05-test-plan.md`), with their content | email patterns; flagged separately in the dry run |

**Proposed acceptance criteria (BLOCKED)**
- **R9.AC1 (backup first)** Before any delete, a backup of `tcms_test` exists, taken by the person and method in Q5. It is recorded in `07-test-report.md` with file path, size, the trailing `-- Dump completed` line, and an exact `COUNT(*)` per table at backup time. No credentials are recorded. If no backup exists, no delete runs.
- **R9.AC2 (dry run is the default)** Started without the explicit delete flag, the cleanup deletes nothing and prints, for each approved group, every matching row (table, primary key, identifying field such as title, name or email, created_at) **plus every cascade child** that the delete would remove (test_case_history, review_requests, review_events, bug_test_case_links, module descendants by `path`), `crew_desk_links` by module id, and notifications pointing at the entities (`entity_type`/`entity_id`), with a count per table.
- **R9.AC2a (DB guard)** The script passes R10.AC11 before any other statement.
- **R9.AC2b (approved keys only)** The delete run takes the **approved list of primary keys** as input, not patterns. Inside one transaction it re-counts the matches. If any count differs from the approved list, it rolls back and aborts with a non-zero exit, printing PASS/FAIL per table.
- **R9.AC2c (order)** Test cases are deleted before their module. activity_logs (only if the owner ever chooses to delete them) are deleted before users.
- **R9.AC2d** The script uses raw SQL per R6.AC2.
- **R9.AC3 (owner approves the exact list)** The dry-run output is attached to `03-review.md` (or a file the owner names). The owner writes approval of that exact list. Any row the owner strikes out is excluded. Before approval, the tester reconciles the list line by line against QA doc lines 101-114 and the group I ids, and flags anything in neither source to the owner.
- **R9.AC4 (only approved rows go)** The rows removed per table equal the approved dry-run count (including approved children). Evidence is the script's per-table output and the residue checker (R10.AC13). Global before/after counts are supplementary and valid only in an exclusive window.
- **R9.AC5 (gone everywhere a user looks)** After the run: Ctrl+K search for "QACHECK" returns nothing for the VP; /modules shows no "QACHECK module…"; product's /reviews queue no longer lists the two QACHECK reviews; /bugs shows no "QACHECK" bug; /wiki shows no "QACHECK wiki". The same applies to every included group (for example no "Imported: ", "Perm-verify case", "Verify notification" titles in search). The stats cache has a 5 s TTL (`stats.service.ts:37`), so checks start at least 5 s after the run, and no restart is needed.
- **R9.AC6 (group D)** Follows **Q20**. With (a), the recommended answer, no seed module or case changes status, and the verify-permissions module review(s) stay. With (b), each affected seed case is back in the status the owner approved from the dry-run evidence, and no other seed module or case changes status.
- **R9.AC7 (audit history)** activity_logs rows are kept or deleted exactly as the owner decides in Q5 (recommended: keep).
- **R9.AC8 (permissions untouched)** All 126 cells are `source: "default"` afterwards (group G checked, not changed).
- **R9.AC9 (app unaffected)** Each of the 7 demo users can log in and open /dashboard, /modules, /test-cases, /bugs and /tasks without an error, and all 7 are active. The refresh-token and LOGIN activity rows these checks create are accepted.
- **R9.AC10 (timing)** The cleanup runs **once, last**: after the final DoD run of phase 9 **and** of the phase 10 release review, and after the last tester or sdet write, including phase 9 re-tests.
- **R9.AC11 (after R9)** Every check after R9 is read-only (logins and GETs). Any write or DoD run after R9 needs a second dry run and owner approval, or the owner's explicit acceptance of the new rows.
- **R9.AC12 (forbidden tools)** `scripts/cleanup-import-demo.mjs` (no dry run, no guard, deletes activity_logs, `:5-14`) and `scripts/check-overrides.mjs` (selects a non-existent `source` column, `:4`) are not run or reused for R9 or as evidence.

**Error cases:** if the delete run fails part-way, the transaction rolls back (R9.AC2b), the script prints what was and was not deleted, and it does not retry on its own. The backup is the recovery path, and the owner decides whether to restore.

---

### R10. The running app is not disturbed, and testing on it is safe (owner constraint)

**Story:** As the owner, I want all work on this REQ done without starting or stopping my running app on :3000, and without testing that interferes with my session, so that my working session is not interrupted.

**Acceptance criteria**
- **R10.AC1** No agent runs `npm run dev`, `npm start`, `next dev`, `next start`, `scripts/dev-tcms.mjs`, `start-dev.sh`, `run-crewdesk-tests.sh` (it kills `next-server`, QA doc line 94) or any command that kills a node or next process. The only process kill allowed is of the **pid tree of a Chrome that the agent's own script spawned**, by pid (`taskkill /PID <pid> /T /F`). Killing by image name is forbidden. Checked by reviewing the commands each agent reports.
- **R10.AC2** `GET http://localhost:3000/api` returns **200 with `status` = `ok`** (`src/app/api/route.ts:8`) at the start and end of each of phases 6, 7, 8 and 9. The raw response is pasted in that phase's report. This proves Next is alive, not MySQL.
- **R10.AC3** `npm run build` (DoD item 3) runs only as the owner decides in **Q1**. Until then DoD item 3 is reported NOT VERIFIED and never as passed.
- **R10.AC4 (hot reload into the owner's window)**
  - (a) Each frontend file is changed in **one** edit whose saved state is complete and valid. No partial multi-step edits to one file.
  - (b) `npx tsc --noEmit` and `npx eslint <file>` run right after each file. If either fails, the fix goes in at once.
  - (c) Only view files under `src/components/views/` are edited for R1–R3. `src/store/index.ts` and `providers.tsx` are not touched.
  - (d) Before `tasks.tsx` is saved, the facilitator tells the owner to save or leave any open /tasks work log, because Fast Refresh drops unsaved form state when the hook list changes (Q21).
  - (e) Route checks are read-only `GET`s.
- **R10.AC5 (isolated browser)** The tester and any UI script use `http://localhost:3000` in a **separate browser profile** (own `--user-data-dir` in a temp/scratchpad folder), never the owner's profile, because a login replaces the session cookie for that host.
- **R10.AC6 (no testing during a save)** Testing starts only after `06-dev-report.md` says the files are complete. If Fast Refresh reloads a page during a check, that check's evidence is void and the check is repeated (not filed as a bug). A slow first compile of a route is not a failure.
- **R10.AC7 (login hygiene)** Exact seed credentials only (5 wrong passwords lock the email for 60 s, `agent.md:131-132`). No demo user's password or profile is changed (a password change revokes all that user's sessions). Logout is allowed.
- **R10.AC8 (writes are listed)** Tester writes are limited to: 3 task-report saves (R1.AC5 ×2, R1.AC7 ×1), the R11 checks if in scope (R11.AC3 one 200 PUT on a group I report), and the toggles in R1.AC7, R1.AC8, R2.AC4 and R3.AC6. Everything else is logins and GETs.
- **R10.AC9 (toggle window)**
  - (a) All toggles run in one announced, short window (Q21).
  - (b) A `GET /api/permissions` snapshot is taken before and after; all 126 cells are `source: "default"` at the end.
  - (c) Each cell is restored immediately after its check, also when the check fails.
  - (d) Toggles are made only through Permissions as the VP, never by SQL.
  - (e) State is read from `GET /api/permissions`, never from the toggle response (C1).
- **R10.AC10 (serial runs, one matrix actor)** `verify-permissions`, `verify-permission-matrix`, `verify-wiki`, `verify-review-matrix`, any R6/R7 restore or recovery run, `verify-ui-gates` (if approved) and the tester's toggle window never overlap each other. No suite runs during the tester's R1–R3 window (R3.AC7). The facilitator runs suites one at a time and announces each window in the phase report. A window counts as "exclusive" only if it is recorded with UTC start/end and the owner confirmed they did not use :3000.
- **R10.AC11 (DB guard)** Every DB-touching script first runs `SELECT @@port, DATABASE()` and aborts before any other statement unless `DATABASE()` = `tcms_test` and the port check passes as decided in **Q18**. It prints only the result, never the connection string.
- **R10.AC12 (notification delivery check)** After every write window (tester or suite), the tester counts `Notification delivery attempted` log lines with `email:sent` or `telegram:sent` (`delivery.ts:171-172`) in that window. If Q17 says "none may be sent" and the count is above 0, all writes stop and the owner is told.
- **R10.AC13 (shared evidence)** One read-only residue checker (`scripts/check-suite-residue.mjs`, `--stamp=<n>` / `--ids=…` / `--pattern=<group>`) prints per-table counts and primary keys. R6.AC4, R7.AC6, R9.AC2 and R9.AC4 use it. The tester reconciles its output; the tester does not query the DB. Every row the tester creates is recorded by id in `07-test-report.md`.

---

### R11. `PUT /api/task-reports?id=` requires `create_task_report` (found in review, S2). **In scope only if the owner answers Q15 "yes".**

**Story:** As the VP, when I revoke `create_task_report` for a role, I want that role unable to change any work log through any route, so that the permission matrix means what it says.

**Current behavior (verified):** `updateTaskReportFields` (`src/app/api/task-reports/task-reports.service.ts:252-262`) checks only that the report exists (`:258-259`) and that the caller owns it (`:260-262`). It never checks `create_task_report`; POST does (`:193`). PUT sends no notification (`:258-288`). The UI does not call PUT today (`tasks.tsx:395` uses the upsert).

**Acceptance criteria**
- **R11.AC1** Given the viewer (default matrix, no `create_task_report`), when they send `PUT /api/task-reports?id=<id>` with header `X-Requested-With: tcms` and a valid body, for **any** id (an existing report of another user, or a random UUID that does not exist), then the response is **403 `{ "error": "Insufficient role" }`** and no row changes. A non-existent id also returns 403, not 404, so the permission check comes before the lookup.
- **R11.AC2** Given the viewer saved a report while granted (R1.AC7) and the VP has revoked the grant again, when the viewer sends `PUT` for that **own** report id, then the response is 403 "Insufficient role" and the report is unchanged (checked by `GET /api/task-reports?id=…`).
- **R11.AC3 (unchanged for holders)** Given a user who holds `create_task_report`:
  - PUT on their own report → 200 (tester uses product's group I report);
  - PUT on another user's report → 403 "You can only edit your own reports";
  - PUT on a non-existent id → 404 "Report not found";
  - invalid body → 400;
  - no session → 401.
- **R11.AC4 (automated)** A DoD suite (`verify-permissions.mjs`) gains: viewer `PUT ?id=<random UUID>` → 403, and a holder `PUT ?id=<random UUID>` → 404 (proves the gate passes for holders without writing a row). No check is removed. The new total is stated in `05-test-plan.md`.
- **R11.AC5** No schema, migration, cache or client change. The UI is unchanged.
- **R11.AC6** Docs per R4.AC9.

**Error cases:** as listed in R11.AC1–AC3.

---

## 4. Routes and permissions

No route, page or permission key is added or removed.

| Page | URL | Permission to open the page | Without permission | In sidebar for (default matrix) | Change in this REQ |
|---|---|---|---|---|---|
| Dashboard | `/dashboard` | any logged-in user | n/a | everyone | Buttons gated (R2) |
| Tasks (daily work log) | `/tasks` | any logged-in user; team view needs `view_all_task_reports`; editing your own log needs `create_task_report` | Without `create_task_report`: own log read-only with notice N1 (R1). Without `view_all_task_reports`: no user picker (unchanged) | everyone (`sidebar.tsx:52`) | R1 |
| Test-case detail | `/test-cases/[id]` | any logged-in user; Activity card needs `view_activity_logs` | Activity card per Q12 (recommended: not shown); no activity request (R3) | via "Test Cases", everyone (`sidebar.tsx:47`) | R3 |
| Integrations | `/integrations` | `manage_integrations` | PermissionDenied (`integrations.tsx:216-225`); no Crew Desk requests (R3) | vp, manager (`sidebar.tsx:50`) | R3 |
| Activity log | `/activity-log` | `view_activity_logs` | PermissionDenied (`activity-log.tsx:97-98`); no feed request (R3) | vp, manager, product (`sidebar.tsx:54`) | R3 |
| Test cases (dashboard target) | `/test-cases` | any logged-in user; create button needs `create_test_case` | list without create button | everyone | none |
| Bugs (dashboard target) | `/bugs` | any logged-in user; create button needs `create_bug` | board without create button | everyone (`sidebar.tsx:51`) | none |
| Reviews (dashboard target) | `/reviews` | `perform_review` | PermissionDenied | vp, manager, product (`sidebar.tsx:49`) | none |
| Reports (dashboard target) | `/reports` | `view_all_task_reports` | PermissionDenied | vp, manager, product (`sidebar.tsx:53`) | none |
| Modules (dashboard target) | `/modules` | any logged-in user | n/a | everyone | none |
| Permissions (used for toggle checks) | `/settings/permissions` (`src/app/(app)/settings/permissions/page.tsx`; sidebar "Permissions") | `manage_permissions` | not in sidebar | vp (`sidebar.tsx:57`) | none |

API calls this REQ stops the UI from sending to users who would be refused (server unchanged), plus R11:

| API action | Method + URL | Permission | Error when denied |
|---|---|---|---|
| Save own work log | `POST /api/task-reports` | `create_task_report` | 403 "Insufficient role" (`task-reports.service.ts:193`, unchanged) |
| **Edit own work log (R11, if Q15 = yes)** | `PUT /api/task-reports?id=…` | `create_task_report` + ownership | **new:** 403 "Insufficient role"; unchanged: 403 "You can only edit your own reports", 404 "Report not found" |
| Case activity | `GET /api/activity-logs?action=entity&type=test_case&id=…` | `view_activity_logs` | 403 "Only roles with view-activity-log rights (VP / Manager)" (`activity-logs.service.ts:31`) |
| Activity feed | `GET /api/activity-logs?page=…&pageSize=…` | `view_activity_logs` | same (`:57`) |
| Crew Desk config / links / email check | `GET /api/integrations/crewdesk?path=config` · `?pageSize=50` · `?path=email-check` | `manage_integrations` | 403 "Only roles with the manage-integrations permission can use Crew Desk integrations" (`crewdesk.service.ts:124`) |

No `docs/03` route → permission table change is needed, because no route or key changes (`agent.md:221`). R11 changes an endpoint's rule, so `docs/04` is updated (R4.AC9).

## 5. Data

No new fields, columns, tables or migrations.
- R1–R3, R8: no data change. Tester writes are listed in R10.AC8 and recorded as group I.
- R5: read-only suite.
- R6, R7: the suites create and then remove their own stamped fixtures in `tcms_test`. The first run of each fixed suite is approved by the owner in phase 4.
- R9: deletes data **only** as approved.
- R11 (if in scope): a server rule change only; no data change.

## 6. Non-functional

- **Expected volume:** unchanged. R3 removes 1 failed request per test-case page view for developer, qa_engineer and viewer, 3 per /integrations visit without `manage_integrations`, and 1 per /activity-log visit without `view_activity_logs`.
- **Response time target:** no page is slower than today. The gates are client-side checks with no extra request. R11 adds one in-memory permission check.
- **Logging and audit:** fewer expected 403 WARN lines (R3.AC7). No new log or activity_logs types. Permission toggles write audit rows (`permissions.service.ts:74-83`), which are kept.
- **Notifications:** none added. Tester saves and the R7 task-report probe trigger the existing `daily_report_submitted` fan-out to every active report holder, including demo users. In-app rows are removed (group I, R7.AC6). Email/Telegram delivery is governed by Q17.
- **Caching:** unchanged. Permission cache 3 s (`permissions.ts:70`), stats cache 5 s (`stats.service.ts:37`).
- **Platform:** every script in R5–R9 runs with plain `node` on Windows 11.
- **Evidence:** every DoD and suite result is pasted raw (`agent.md:211`). R1–R3 UI evidence is the tester's per-role browser pass plus the automated coverage decided in Q7.

## 7. Out of scope

- B8 `self-*@tcms.test` accounts, unless the owner adds them (Q4).
- Making `verify-import.mjs` / `verify-permissions.mjs` / `verify-notifications.mjs` clean up after themselves (B16).
- The stale `canAny` comment at `src/lib/permissions.ts:144-145` (B14).
- Hard-coded test credentials in the verify scripts (B13).
- Dashboard "New Test Case" opening the create dialog (B15).
- Porting the Linux-only suites (B11).
- Changing `TCMS_ALLOW_SIGNUP` or any `.env` value.
- Fixing real violations that the fixed audit (R8) reports.
- Fixing the agent.md / CODEBASE-MAP delete-semantics contradiction, unless the owner adds it (Q6).
- Adding `verify-wiki.mjs`, `verify-permission-matrix.mjs` or `verify-ui-gates.mjs` to the DoD list (Q16).
- Any API change other than R11, and any schema or migration change.
- **If Q15 = backlog:** the owner accepts a known S2 permission gap (`PUT /api/task-reports`) for this release, recorded in `decisions.md`.

**For the manager to add to `docs/process/backlog.md`** (the product-owner may not edit it):
1. `PUT /api/permissions` response always says `source: 'override'` (`permissions.service.ts:85-90`).
2. agent.md §2 delete-semantics errors, full list from the backend review (hard-deleted cases with cascading children, module delete orphans cases/bugs, wiki hard delete, `delete_bug` held by manager).
3. Ungated links to /reviews: `review-detail.tsx:106`, `:268`; `module-review-detail.tsx:133`; `src/lib/navigation.ts:24-25`.
4. Focus Queue overflow label "view reviews" when the overflow is all bugs (`dashboard-v2.tsx:661-669`).
5. Test-case Activity card shows "No activity yet" on a failed load (`test-case-detail.tsx:69`, `:328`).
6. `sidebar.tsx:68-71` memo on stable `can`/`canAny` references.
7. `audit-standards.mjs:56`/`:78` `/g` regex with `.test()` (`lastIndex` false negatives).
8. `scripts/check-overrides.mjs:4` selects a non-existent `source` column.
9. `scripts/cleanup-import-demo.mjs` has no dry run or guard and deletes activity_logs.
10. `verify-wiki.mjs:211` tautological check.
11. B16 additions: `verify-permissions.mjs:107-122` changes the first existing bug's status/assignee; a new module review on the first submodule every run (`:54`, `:63`); `verify-notifications.mjs:171-189` creates a bug every run.
12. `docs/04-api-reference.md:216` drift, if Q22 = no.

## 8. Open questions for the owner

Owner answers 2026-10-15: see 03-review.md Owner decision.

None is answered yet. Each has a recommended answer. Q17–Q22 are new from the phase 3 review, and Q3, Q5, Q7, Q13, Q14 and Q15 were updated.

- [ ] **Q1 Build vs running server.** How should DoD item 3 (`npm run build`) run while `next dev` holds :3000 and writes `.next/`? **Recommended:** a separate git worktree of `improvements` in another folder, with `npm install` + `npm run build` there. If that needs `.env` values (copying `.env` is a secrets action), item 3 is reported NOT VERIFIED for REQ-001, and you run the build when you choose.
- [ ] **Q2 Who edits `agent.md`, `CODEBASE-MAP.md`, `docs/README.md`, `docs/04-api-reference.md` and `docs/06-page-login-and-dashboard.md`?** **Recommended:** a one-time grant to the **manager** for exactly the lines in R4 (`CODEBASE-MAP.md:114/120`, `:126`; `agent.md:208-209`; `docs/06-…:74-76`, `:93-94`; `docs/04-…:206` if Q15 = yes; `docs/04-…:216` if Q22 = yes), recorded in `decisions.md`.
- [ ] **Q3 Cleanup scope (updated).** **Recommended:** A (all QACHECK fixtures); B only if the dry run shows QA-check text in it; C (all "Imported: …" from every run, including REQ-001's); D per Q20; E left soft-deleted; **E2** (all "Verify notification …" bugs and their notifications); F only cascades of deleted rows and notifications pointing at deleted entities (activity_logs kept); G verify only; H out (Q4); **I** (REQ-001 tester rows by id); **J** (killed suite runs, if the dry run finds any).
- [ ] **Q4 B8 `self-*@tcms.test` accounts in or out?** **Recommended:** out (stays B8).
- [ ] **Q5 Cleanup method, child rows and backup (updated).** **Recommended:** option (2) only: a reviewed sdet Node script, raw SQL, dry run by default, DB guard, delete by the **approved primary-key list** with a re-count in one transaction (R9.AC2–AC2d). Options (1) API and (3) soft-only cannot meet R9.AC5/AC6 (see R9 "Why the method matters"). Hard delete for fixtures and their cascade children (listed in the dry run). Keep activity_logs. Backup: **you** take it (DB credentials must not pass through an agent), with this command shape: `mysqldump --protocol=TCP --host=127.0.0.1 --port=5500 --user=<user> -p --single-transaction --hex-blob --routines --triggers --no-tablespaces --set-gtid-purged=OFF --default-character-set=utf8mb4 --databases tcms_test --result-file=<path>`. `-p` prompts for the password; `--result-file` avoids PowerShell's UTF-16 redirection; `--hex-blob` protects `wiki_documents.file_data`. Please also confirm that `mysqldump.exe` is on your PATH and that the DB user you use has SELECT, SHOW VIEW and TRIGGER on every table (UNKNOWN to us). No restore drill unless you ask for one.
- [ ] **Q6 Contradiction** `agent.md:138-139` vs `CODEBASE-MAP.md:73-74` and the code. **Recommended:** the code is authoritative for this cleanup. Backlog item with the full error list (§7 item 2). No change in REQ-001.
- [ ] **Q7 Automated coverage for R1–R3 (updated: approve `scripts/verify-ui-gates.mjs`?).** **Recommended:** approve. A Node script with **no new npm dependency** drives the installed Chrome in headless mode over CDP. It is read-only on the default matrix: R1.AC1/AC3, the R2.AC1 table (and R2.AC6 DOM form), and the R3.AC1 tables, about 30 page loads. Safety: own temp profile, random debugging port, kill only its own pid tree (R10.AC1), login by API with exact credentials (only login rows). It does not cover toggles, writes or layout, and it does not join the DoD. Fallback if you say no: a decision that R1–R3 are covered by the tester's pass only, plus a backlog item for a UI test framework.
- [ ] **Q8 `docs/README.md:75` "63/63".** **Recommended:** leave unchanged.
- [ ] **Q9 Bug 7 target.** **Recommended:** port to the default matrix with self-provisioned stamped fixture users (created by SQL) and a fixture module, all removed afterwards. No demo login, no permanent overrides (R7.AC0–AC13).
- [ ] **Q10 More ungated dashboard links (R2.AC6–AC8).** **Recommended:** yes.
- [ ] **Q11 Text of the read-only notice N1 on /tasks.** **Recommended (updated in review):** `Your role can view work logs but cannot log work. A VP can enable "Create task reports" for your role under Permissions.` It names the matrix label (`src/types/index.ts:59`) and the sidebar entry (`sidebar.tsx:57`).
- [ ] **Q12 Activity card on /test-cases/[id] without `view_activity_logs`.** **Recommended:** hide it.
- [ ] **Q13 Tester test data (updated).** **Recommended:** one past date you approve (for example 2026-01-01). The tester first checks, as the VP and read-only, that product, qa2 and viewer have no report on it. **3 saves** in total (product, qa2, viewer-while-granted). Each save also sends `daily_report_submitted` in-app notifications to the other active report holders. All are recorded by id and go into R9 group I.
- [ ] **Q14 "No residue" for R6/R7 (updated).** **Recommended:** every row the run caused is removed, including notifications addressed to any user (found by fixture `user_id` and by `entity_type`/`entity_id` of the run's entities), and every activity_logs row authored by fixture users. No demo account is used, so no demo audit row is created.
- [ ] **Q15 Server gap `PUT /api/task-reports?id=` (updated).** **Recommended: include as R11** (S2 per WORKFLOW.md:97, one-line server change, about 1–2 h with the suite check). If you choose backlog, you accept a known S2 gap for this release, and it is recorded in `decisions.md`.
- [ ] **Q16 DoD list.** **Recommended:** none of the new or fixed suites join `agent.md` §3 in REQ-001. Promotion criteria for the retro: two approved runs each (one green, one forced failure with residue 0 and an identical matrix) and the serial-run rule written into §3.
- [ ] **Q17 (new) Email and Telegram delivery.** Every tester save and every R7 run notifies the demo report holders (admin, teamlead, product). The server also tries email and Telegram per user preference (`delivery.ts:146-173`). Messages that are sent cannot be recalled. We cannot read `.env` to check whether SMTP or Telegram is configured. **Recommended:** before phase 7 and before the first R7 run, you confirm that SMTP and Telegram are **not** configured on this machine (or you accept the messages). The tester stops if a `sent` delivery appears (R10.AC12).
- [ ] **Q18 (new) DB guard and port mapping.** `SELECT @@port` reports MySQL's own port. If MySQL runs behind a port mapping, it may not say 5500 even when the connection is correct. **Recommended:** the guard requires `DATABASE()` = `tcms_test` **and** an in-process check that the `DATABASE_URL` host is `127.0.0.1`/`localhost` with port `5500`, printing only `true`/`false`. `@@port` is printed for information. If `@@port` is not 5500, the script aborts unless you state here that MySQL runs behind a port mapping.
- [ ] **Q19 (new) R7 notification side effect.** During each R7 run, the create-task-report probe creates in-app `daily_report_submitted` notifications (with a live push) for the demo report holders, because the server notifies every active holder. They are deleted at cleanup. If you are signed in as admin, teamlead or product, you may briefly see them in the bell. **Recommended:** accept (no server change to avoid it in this REQ).
- [ ] **Q20 (new) Group D: verify-permissions module review.** (a) Keep the module review(s) and the seed case statuses; delete only the "Perm-verify case …" rows. (b) Delete the review(s) and roll the affected seed cases back. The prior status is not stored anywhere (`test-cases.repository.ts:174-181` writes no history), so the dry run would show seed definitions and earlier verdicts as evidence, and you approve a status-only UPDATE with no version bump. **Recommended: (a).** Rollback relies on guesswork, and every DoD run raises a new review anyway (backlog B16).
- [ ] **Q21 (new) Your use of :3000 during testing.** **Recommended:** you agree to (1) a short announced toggle window during which you do not sign in as qa_engineer, manager, viewer or developer; (2) an announced R3 window (UTC times) during which you do not open /test-cases/[id], /integrations or /activity-log and no suite runs; (3) a warning before `tasks.tsx` is saved, so you can save or leave an open /tasks work log.
- [ ] **Q22 (new) `docs/04-api-reference.md:216` drift.** It says the entity activity feed is "any authenticated", but the server requires `view_activity_logs` (`activity-logs.service.ts:31`). Same endpoint as R3. **Recommended:** yes, fix it under R4.AC8 with the Q2 grant (one line).

## Changelog
| Version | Date | Change | Reason |
|---|---|---|---|
| 1 | 2026-10-15 | First draft: R1–R10, routes table, Q1–Q16 | Phase 2 from `01-kickoff.md` |
| 2 | 2026-10-15 | **Conventions:** 7 demo accounts (qa2 added, used for qa writes); "full page load or fresh login" with an evidence cross-check; CDP capture accepted as network evidence; matrix read from GET only; C5 test date. **R1:** 4-row permission table with exact notices N1/N2/N3 and "one notice only"; AC1 split into report / no-report states (empty state, Export CSV disabled); AC2 chained after AC7; AC4 labels "Export" / "Export CSV"; AC5 reduced to 2 real saves; AC7 uses qa2; new AC8 (`view_all_task_reports` without `create_task_report`); browser-side error test method. **R2:** AC2 no item created; AC3 also the empty header group; AC4 create button present, no bug submitted; AC6 DOM checks (a)–(d) + positive case; AC7 code-review evidence. **R3:** AC1 five page-entry paths and 401-refresh note; AC6 a named seed case; AC7 exclusive UTC window. **R4:** AC3 pins 36; AC6 adds docs/04; new AC8 (Q22) and AC9 (R11). **R5:** exactly 36; serial rule. **R6:** PASS/FAIL counts fixed in the test plan; raw SQL, `$executeRaw`, no ORM; precondition exit 2 for non-default state; exact SQL snapshot restore verified by GET; `VERIFY_FAIL_AT` + Ctrl+C; grant through the API; `--cleanup-stamp`; concurrency guard; ID-scoped residue. **R7:** AC0 precondition replaces the `:61-66` reset; no demo login; fixture users by SQL; explicit reviewer; AC7 reworded; notification side effect (Q17/Q19); closed-signup evidence by code; exact count (165 today); toggle-probe restore checked. **R8:** `--self-test`; baseline protocol; naming count = file count check. **R9:** method reasoning; groups E2, I, J; dry run lists children; DB guard; approved PK list + re-count in a transaction; cases before module; timing after phase 10; post-R9 read-only; forbidden scripts. **R10:** AC1 Chrome pid-tree exception; AC2 `status` = `ok`; AC4 replaced by 5 hot-reload rules; new AC5–AC13 (isolated profile, no testing during saves, login hygiene, listed writes, toggle window, serial runs, DB guard, delivery check, shared residue checker). **New R11** (PUT task-report gap, conditional on Q15). Header, §2, §5, §7 corrected ("backend gates correct" now excludes R11). **§8:** Q3, Q5, Q7, Q9, Q11, Q13, Q14, Q15, Q16 updated; new Q17–Q22. | Phase 3 review (`03-review.md`, product-owner answers) |

---

```
STATUS: Phase 3 BRD review — needs owner approval
FILES WRITTEN: docs/requirements/REQ-001-qa-check-fixes/02-brd.md (v2), docs/requirements/REQ-001-qa-check-fixes/03-review.md (product-owner section only)
OPEN QUESTIONS FOR OWNER: Q1–Q22 (§8); R9 BLOCKED on Q3/Q4/Q5/Q6/Q20 + dry-run approval; R4 editing BLOCKED on Q2; R11 conditional on Q15
NOT VERIFIED: every tcms_test row (no DB access); qa2 login/password; runtime equality of reload vs login permission refresh; whether SMTP/Telegram are configured; mysqldump availability and DB-user privileges; whether MySQL runs behind a port mapping; whether a second verify-permissions module-review submit while one is open returns 200; exact executed check count of verify-wiki (47 `ok(` call sites, loops not counted); kickoff-only citations (test-cases.repository.ts:191, modules.repository.ts:146-147, verify-import.mjs:83, migration/03-verification.md:45, auth-screen.tsx location)
NEXT AGENT: manager — record the product-owner answers in the "manager — decisions" table of 03-review.md, add the 12 backlog items in 02-brd.md §7 to docs/process/backlog.md, and put Q1–Q22 to the owner for APPROVED
```
