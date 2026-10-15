# REQ-001 Test Plan

BRD: `02-brd.md` v2, approved with pins P1–P8 (`03-review.md` Owner decision; `decisions.md` D10–D13).
Design: `04-design.md` (2.1 R11 status order, 3.1–3.6 frontend).
Owner answers used here: Q13 test date **2026-10-01** (never today), Q17 email and Telegram **not configured** (stop-on-`sent` stays as a tripwire), Q19 transient in-app notifications accepted, Q21 announced windows agreed.

Manual part: tester, written 2026-10-15 (phase 5). No test was run while writing it. Nothing was sent to :3000 and no DB query was run.

---

## Manual (tester)

### M0. Conventions for every manual test

| Item | Rule |
|---|---|
| URL | `http://localhost:3000` only, the URL the owner uses (lesson ws-auth-runtime-1). Every evidence line names the URL. |
| Browser | Chrome (headless or headed), own profile `--user-data-dir=<scratchpad>\chrome-req001`, random `--remote-debugging-port`, driven over CDP (C3, R10.AC5). Never the owner's profile. Only this Chrome's pid tree may be killed, by pid (`taskkill /PID <pid> /T /F`). Chrome being installed is NOT VERIFIED until S0-3. |
| curl | Cookie jar per account in the scratchpad (`<scratchpad>\jar-<role>.txt`). Every write or mutation call carries `-H "X-Requested-With: tcms"`. Login: `POST /api/auth?path=login` with `{email,password}`. Passwords are taken from `src/app/api/seed/seed.service.ts:57-81` when the command runs, and are shown as `<redacted>` in every pasted request. Cookie jars are deleted at the end (S6-5). |
| Accounts (C2) | vp `admin@tcms.com`, manager `teamlead@tcms.com`, product `product@tcms.com`, developer `developer@tcms.com`, qa_engineer `qa2@tcms.com` (all qa_engineer checks and writes), viewer `viewer@tcms.com`. `qa1@tcms.com` is never used for writes and is used only as a read-only spot check in MT-R2-01. |
| Login hygiene (R10.AC7) | Exact seed credentials only. If one login fails, stop logging in to that account (5 failures lock it for 60 s, which would also lock the owner) and report. No password or profile change. Logout is allowed. |
| Permission refresh (C4) | Full load (F5 or typed URL) or fresh login. Client-side navigation never counts. Each toggle check records which method was used and captures the `GET /api/auth` response with the toggled key present or absent. |
| Network evidence (C3) | CDP `Network` capture, filtered to `/api/`, from page load to at least 30 s later, saved as `evidence/net-<test-id>-<role>.json` (method, URL, status, timestamp). A 401 followed by a successful refresh and retry is normal (`agent.md:127-129`) and is not a failure. |
| Notice (P2) | "Notice" means only N1, N2 or N3. The load-error alert, toasts and the empty-state text are not notices. "Exactly one notice" = exactly one element whose textContent is N1, N2 or N3. |
| Exact strings | Compared as DOM `textContent`, trimmed, byte for byte. N1, N2, N3 as in `02-brd.md:82-84`. Empty state per P1: `No tasks logged for 2026-10-01.` (ISO date). |
| Hidden (R2) | Hidden = not in the DOM. A disabled or greyed button counts as visible (FAIL). |
| Fast Refresh (R10.AC6) | If a page reloads by itself during a check, that evidence is void and the check is repeated. It is not filed as a bug. A slow first compile is not a failure. |
| Evidence folder | `docs/requirements/REQ-001-qa-check-fixes/evidence/` (screenshots, network captures, snapshot JSON). Tokens, cookies and passwords are never stored there. |
| Result | PASS / FAIL / NOT VERIFIED / BLOCKED per test id in `07-test-report.md`. Nothing is marked PASS that was not run. |

### M1. Fixed test data (named before the run)

| Id | Data | Value |
|---|---|---|
| D-DATE | C5 test date | `2026-10-01` |
| D-DESC-P | product's task description (R1.AC5) | `REQ-001 MT tester ✅🚀 परीक्षण कार्य` padded with `x` to **exactly 500** UTF-16 code units (the server max, `task-reports.validation.ts:13`) |
| D-DESC-P+1 | over-max attempt | the same string with one more `x` (501 units) |
| D-DESC-Q | qa2's task description | `REQ-001 MT qa2 🧪 हिंदी परीक्षण "quotes" & <b>tag</b>` (special characters; must render as text, not HTML) |
| D-MIN | minutes | `15`, status `done` |
| D-UUID | non-existent id for R11 | a random v4 UUID generated at run time, recorded in `07-test-report.md` |
| D-BADBODY | invalid PUT body | `{"tasks":"not-an-array"}` (fails `upsertTaskReportSchema.partial()`) |
| D-CASE | seed test case for R3.AC1 and R3.AC6 | selected in S0-6 from the seed titles in `seed.service.ts:153-197`, in this order: "User can log in with valid credentials", "Payment with expired card is rejected", "Shipping address validation for international orders", "Email format validation on registration", "Refund processing for partial returns". The first one whose `GET /api/activity-logs?action=entity&type=test_case&id=<id>` (as vp) returns at least 1 row is D-CASE. The seed itself writes no activity rows (`seed.service.ts:17-18`), so this depends on later activity. If none of the five has activity, R3.AC6 is **BLOCKED** and reported to the facilitator (proposed substitute: "QACHECK tc1" before R9). No activity is created to make it pass. D-CASE is used for R3.AC1 as well, whether or not it has activity. |
| D-SEARCH | Ctrl+K search term | the first word of D-CASE's title that is unique in the search results (recorded at S0-6) |

### M2. Execution order

Read-only first. Writes only in S3 and S4. No step runs while a suite runs (R10.AC10, P8) or while `06-dev-report.md` says files are still being edited (R10.AC6).

| Stage | What | Writes | Window |
|---|---|---|---|
| S0 Preflight | S0-1 `GET /api` (R10.AC2 start). S0-2 log in all 7 accounts by curl (qa2 first; stop on failure). S0-3 start the isolated Chrome. S0-4 vp: `GET /api/users?action=options` for user ids; `GET /api/task-reports?userId=<id>&dateFrom=2026-10-01&dateTo=2026-10-01` for product, qa2 and viewer (must be empty; if not, stop and report, never overwrite). S0-5 vp: `GET /api/permissions` → 126 cells, all `source:"default"` (snapshot `perm-S0.json`). S0-6 pick D-CASE and D-SEARCH. S0-7 baseline counts in `logs/app-<UTC date>.log` of `Notification delivery attempted` with `email:sent` / `telegram:sent` (positive control: the same grep must first show the known `email:skipped` lines, `03-review.md` tester §4.7). | none (login rows only) | any time |
| S1 R3 window | Announced UTC window, no suite, owner not on those pages (Q21(2)). MT-R3-01..05. | none | exclusive, UTC start/end recorded |
| S2 Read-only UI and API | MT-R2-01..08, MT-R1-01, 03, 04a, 06a, 09, 10, MT-R11-01a, MT-R11-04 (no-write parts) | none (refused calls only) | any time |
| S3 Writes | MT-R1-05 (2 saves), MT-R1-11/12 (input edge cases on the same saves), MT-R11-01b, MT-R11-03, MT-R1-06b. Then MT-R10-04 (delivery count 60 s after the last write). | W1, W2, W4 | announced |
| S4 Toggle window | MT-R10-03 snapshot → MT-R1-07a → MT-R1-07b (W3) → MT-R1-02 + MT-R11-02 + MT-R1-04b → MT-R1-08 → MT-R2-04a/b → MT-R3-06 → snapshot | toggles T1–T6, W3 | announced, short (Q21(1)) |
| S5 Docs | MT-R4-01..09, MT-R11-05 (file reads, `git log -p`) | none | after the manager's D11 edits |
| S6 Close | S6-1 `GET /api` (R10.AC2 end). S6-2 MT-R10-04 again for S4. S6-3 final `GET /api/permissions` = `perm-S0.json`. S6-4 write group I ids to `07-test-report.md`. S6-5 log out every account, delete cookie jars and downloads, kill own Chrome by pid. | none | — |
| S7 Phase 10 (R9) | MT-R9-01 (positive control), MT-R9-02 (dry-run reconciliation) before the delete; MT-R9-03..05 read-only after the owner-approved delete | none | after the last write of any agent (R9.AC10) |

### M3. Test cases

#### R1 — `/tasks` follows `create_task_report`

| Test id | Criterion | Role | Steps | Test data | Expected | Evidence |
|---|---|---|---|---|---|---|
| MT-R1-01 | R1.AC1, R1.AC1(b), R1.AC3 | viewer | 1. Fresh login. 2. Type `/tasks`. 3. Set Date to D-DATE. 4. F5. 5. Browser back, then forward. 6. Watch network for the whole visit. | D-DATE | No "Add task" (header or empty state), no "Save report", no row remove control; exactly one notice = N1, above the log; no blank task card; empty-state textContent exactly `No tasks logged for 2026-10-01.`; no "Add your first entry" text; "Export CSV" disabled; no user picker. Same after F5 and back/forward. No `POST /api/task-reports` and no `PUT /api/task-reports?id=` in the capture. | DOM dump of the card, screenshot, `net-MT-R1-01-viewer.json` |
| (R1.AC1(a)) | R1.AC1(a) | — | Not a separate default-matrix check (P3). Covered by MT-R1-02 (viewer) and MT-R1-06a/b (other roles). | — | — | — |
| MT-R1-02 | R1.AC2, R1.AC1(a) | viewer | In S4, right after T2 is restored (viewer has no `create_task_report` again): 1. F5 on `/tasks`, capture `GET /api/auth` (key absent). 2. Open D-DATE. 3. Switch to `2026-10-02` (no report). | W3 saved by viewer on D-DATE | D-DATE: saved entries shown; every task input and Notes disabled; no Save, no Add task, no remove control; exactly one notice N1. 2026-10-02: MT-R1-01 expectations hold, with `No tasks logged for 2026-10-02.` | screenshots, DOM dump, `/api/auth` response |
| MT-R1-03 | R1.AC3 | viewer; manager under T3 | Covered inside MT-R1-01, MT-R1-02 and MT-R1-08: the network capture of each whole visit is checked for `POST /api/task-reports` and `PUT /api/task-reports?id=`. | — | 0 such requests in every capture. | the captures |
| MT-R1-04a | R1.AC4 | viewer | 1. On `/tasks`, under "Monthly report", click "Export" for 2026-10 (downloads go to `<scratchpad>\dl`). 2. curl as viewer: `GET /api/task-reports?action=export&month=2026-10&userId=<vp userId>`. | month 2026-10 | 1. `GET /api/task-reports?action=export…` → 200, a file is downloaded. 2. 200, payload `user.userId` = the viewer's own id (locked to own data, `task-reports.service.ts:114-126`), not the vp's. "Export CSV" disabled on D-DATE (no report yet). | network line, file name/size, curl request + response (ids only) |
| MT-R1-04b | R1.AC4 | viewer | After MT-R1-02 (D-DATE now has W3): check "Export CSV" on D-DATE and on 2026-10-02; click it on D-DATE. | — | Enabled on D-DATE, a CSV downloads containing the W3 task; disabled on 2026-10-02. Downloads deleted after the check. | screenshot, file row count |
| MT-R1-05 | R1.AC5 | product (W1), qa2 (W2); vp, manager, developer (no save) | **No save:** vp, manager, developer each open `/tasks` (own log, today's date shown by default, no date change): editor enabled, "Save report" and "Add task" visible. Do not click Save. **Saves:** product, then qa2: open `/tasks`, set D-DATE, "Add task", enter description (D-DESC-P for product, D-DESC-Q for qa2), 15 minutes, status done, click "Save report". qa2's click is the double-click of MT-R1-10. | D-DATE, D-DESC-P, D-DESC-Q, D-MIN | Each save: one `POST /api/task-reports` → 200, success toast, response `taskReportId` recorded (group I). Reload shows the task with the exact description (emoji, Hindi, quotes, `<b>` shown as literal text). No N1/N2/N3 for any of the 5 roles on their own log. | network line with status and `taskReportId`, screenshots |
| MT-R1-06a | R1.AC6, R1.AC1(a), R1.AC1(b) | vp, manager, product | Before writes: 1. Open `/tasks`, pick `qa1@tcms.com` in "User", date 2026-10-15 (the QA-check group B report; existence NOT VERIFIED, checked read-only first by vp `GET /api/task-reports?userId=<qa1>&dateFrom=2026-10-15&dateTo=2026-10-15`). 2. Pick viewer, date D-DATE. | — | 1. Read-only, all inputs and Notes disabled, exactly one notice N2 (unchanged text). 2. N2 shown, empty state `No tasks logged for 2026-10-01.`, no blank row, "Export CSV" disabled. If qa1 has no report on 2026-10-15, step 1 moves to MT-R1-06b. | screenshots, DOM dump |
| MT-R1-06b | R1.AC6, R1.AC1(a) | product | After W2: pick qa2, date D-DATE. | — | qa2's saved entry shown read-only, inputs disabled, exactly one notice N2, no Save. | screenshot |
| MT-R1-07a | R1.AC7, C4 cross-check | vp (toggle), qa2 | T1: vp turns `qa_engineer / create_task_report` **off** in Permissions. qa2: (a) F5 on `/tasks`, capture `GET /api/auth`; (b) log out and log in again, open `/tasks`. vp restores T1 at once (also if the check fails). | — | Both methods: `create_task_report` absent from `/api/auth`; own log read-only exactly as MT-R1-01 with N1 (today's date may hold no report → empty state with today's ISO date). The two methods give the same result; if not, file a bug and use fresh login for every later toggle check. No POST/PUT sent. | `/api/auth` responses (permissions only), screenshots, captures |
| MT-R1-07b | R1.AC7 | vp (toggle), viewer | T2: vp turns `viewer / create_task_report` **on**. Viewer F5 (capture `/api/auth`, key present), opens `/tasks`, D-DATE, adds one task (`REQ-001 MT viewer 🙂 दर्शक`, 15 min, done), clicks "Save report" once. vp restores T2 at once. | D-DATE | Editor enabled, no N1, Save visible. One `POST /api/task-reports` → 200, success toast; `taskReportId` recorded (W3, group I). | network line, screenshot |
| MT-R1-08 | R1.AC8, R1.AC3 | vp (toggle), manager | T3: vp turns `manager / create_task_report` **off**. Manager F5 (capture `/api/auth`). 1. Own log, today and D-DATE. 2. Pick product in "User", D-DATE (has W1). 3. Pick back to self. vp restores T3. | — | 1. Read-only, N1, user picker still shown. 2. Read-only, exactly one notice = N3 (`You are viewing another user's report.`), N2 text absent. 3. N1 again. Never two notices at once in any state. No POST/PUT in the capture. | screenshots, DOM dumps, capture |
| MT-R1-09 | R1 error: POST refused | viewer (default matrix) | curl as viewer: `POST /api/task-reports` with `X-Requested-With: tcms`, body `{"reportDate":"2026-10-01","tasks":[{"description":"MT refused","timeSpentMinutes":15,"status":"done"}]}`. | D-DATE | 403 `{"error":"Insufficient role"}`. No row (vp `GET /api/task-reports?userId=<viewer>&dateFrom=2026-10-01&dateTo=2026-10-01` still empty). If 200: record the id in group I and file an S2 bug. | request + response |
| MT-R1-10 | R1 error: double submit | qa2 | On W2: double-click "Save report" quickly. Then vp `GET /api/task-reports?userId=<qa2>&dateFrom=2026-10-01&dateTo=2026-10-01`. | — | Save disabled while pending; at most 2 POSTs, and the second (if any) returns 200 with the **same** `taskReportId`; exactly 1 report row for qa2 on D-DATE. Notification count recorded (1 or 2 batches). | capture, GET response |
| MT-R1-11 | R1 load error, P2 | viewer | Block `/api/task-reports*` in the tester's Chrome only (`Network.setBlockedURLs`), F5 `/tasks`. Unblock, F5. | — | "Could not load the work log" alert **and** N1 shown together (PASS per P2). After unblock, normal state. Server untouched. | screenshot, capture |
| MT-R1-12 | Input edges (template) | product, then qa2 | Before W1 (same row, no extra write): 1. Save with an empty description → expect the existing client validation toast and no POST, or a 400 with no row. 2. Save with D-DESC-P+1 (501) → expect the input to block it, or a 400 "Invalid input" toast and no row. 3. Then save D-DESC-P (500) = W1. qa2: notes with `🙂 नोट` and 0 minutes → not saved separately; part of W2. | D-DESC-P, D-DESC-P+1 | 1 and 2 create no row (vp GET still empty before step 3). A 200 that stores 501 characters is a FAIL. Step 3 stores all 500 units exactly. | captures, GET responses |
| MT-R1-13 | Back/forward, refresh | viewer, product | `/tasks` → `/dashboard` → back → forward → F5, each time on D-DATE. | — | Read-only state (viewer) and editable state (product) are the same after each step; no duplicate POST on back/forward/F5. | capture |

#### R2 — dashboard buttons

| Test id | Criterion | Role | Steps | Test data | Expected | Evidence |
|---|---|---|---|---|---|---|
| MT-R2-01 | R2.AC1, R2.AC5 | all 6 (qa2 for qa_engineer; qa1 read-only spot check) | Fresh login, type `/dashboard`, F5. Read the header button group and the Quick Actions card from the DOM. | default matrix | DOM equals the BRD table (`02-brd.md:140-150`) cell by cell: e.g. developer has no "New Test Case" (header or QA), no "Reviews", no "Reports"; viewer has only "Tasks" and "Modules". vp and manager show all 9 (R2.AC5). qa1 = qa2. | DOM dump per role (button labels list) |
| MT-R2-02 | R2.AC2 | all 6 | Click every visible dashboard button, one at a time, return to `/dashboard` between clicks. Do not submit any form. | — | Target page shows its content; never "Access restricted" / "No access". "New Test Case" → `/test-cases` with its create button present; "Report Bug" → `/bugs` with its create button present. No item created. | screenshot per click |
| MT-R2-03 | R2.AC3 | viewer | Screenshot `/dashboard` at desktop width (1440×900) and at 400×900 (CDP `Emulation.setDeviceMetricsOverride`). | — | Quick Actions shows exactly "Tasks" and "Modules", no empty or overlapping tile. The header button group element is not in the DOM and leaves no visible gap. | 2 screenshots, DOM check |
| MT-R2-04a | R2.AC4 | vp (toggle), viewer | T4: `viewer / create_bug` **on**. Viewer F5 (capture `/api/auth`). Check both "Report Bug" buttons; click one. vp restores T4. | — | Both visible; `/bugs` shows the create button. No bug submitted. | screenshots, `/api/auth` |
| MT-R2-04b | R2.AC4 | vp (toggle), developer | T5: `developer / perform_review` **on**. Developer F5. Check "Reviews" Quick Action; click it. vp restores T5. | — | "Reviews" visible; `/reviews` opens with content (no PermissionDenied). | screenshots |
| MT-R2-05 | R2.AC6 (a)–(d) | developer, qa2, viewer; positive: vp, manager, product | On `/dashboard`: inspect the "My Pending Reviews" KPI card; Tab through the KPI row; click the card; compare its number with the hero chip "pending reviews". | — | Without `perform_review`: element is not `<button>`, no `role="button"`, no `tabindex`; never focused by Tab; no `svg.lucide-chevron-right` inside; click leaves URL `/dashboard` and sends no `/api/reviews*` request; number = hero chip. Positive roles: a focusable `<button>` that opens `/reviews`. | DOM dump, capture, screenshot |
| MT-R2-06 | R2.AC7 | developer, qa2, viewer | Code review result from `06-dev-report.md` is read. Runtime: count Focus Queue items per role; only if a role has more than 8 items, check the "+ N more · view reviews" link is absent. | — | Code review shows the link gated by `perform_review`. Runtime part NOT VERIFIED unless a role has > 8 items (no fixture bugs are created). | dev-report reference, item count |
| MT-R2-07 | R2.AC8 | all 6 | Check the "View all" button on the Latest Activity card. | — | Present for vp, manager, product; absent for developer, qa2, viewer. The activity list itself is still shown for all. | DOM dump |
| MT-R2-08 | R2 error state (unchanged) | viewer | Block `/api/stats*` in the tester's Chrome only, F5 `/dashboard`; unblock, click "Retry". | — | "Failed to load dashboard data." with Retry; after unblock + Retry, the dashboard loads. | screenshots |
| MT-R2-09 | Direct URL without permission | developer, qa2, viewer | Type `/reviews` and `/reports`; F5 on each. | — | PermissionDenied on both (unchanged in-page guards, `reviews.tsx:84`, `reports.tsx:56-57`). | screenshots |

#### R3 — no requests that will be refused (run in S1, the exclusive UTC window)

| Test id | Criterion | Role | Steps | Test data | Expected | Evidence |
|---|---|---|---|---|---|---|
| MT-R3-01a | R3.AC1, R3.AC3 | developer, qa2, viewer | For D-CASE, each entry path, capture network for 30 s after load: (1) type `/test-cases/<id>`; (2) F5 on the page; (3) go to `/dashboard`, back, forward; (4a) click it in `/test-cases`; (4b) click it in `/modules/<module id>`; (4c) Ctrl+K, type D-SEARCH, open it. 18 visits. | D-CASE, D-SEARCH | No `GET /api/activity-logs?action=entity&type=test_case&id=…`; no `/api/*` response with status 403. The "Activity" card is not rendered (Q12). | `net-MT-R3-01a-<role>-<path>.json`, screenshot |
| MT-R3-01b | R3.AC1, R3.AC4 | product, developer, qa2, viewer | `/integrations` by paths (1)–(3), 30 s each. 12 visits. | — | No `GET /api/integrations/crewdesk?path=config`, `?pageSize=50`, `?path=email-check`; no 403 on the page. PermissionDenied with its current text: "Integrations are only available to roles with the manage-integrations permission. A VP can enable it for your role under Permissions." (`integrations.tsx:223`). | captures, screenshot |
| MT-R3-01c | R3.AC1, R3.AC5 | developer, qa2, viewer | `/activity-log` by paths (1)–(3), 30 s each. 9 visits. | — | No `GET /api/activity-logs?page=…`; no 403. PermissionDenied "The activity log is only available to roles with view-activity-log rights." | captures, screenshot |
| MT-R3-02 | R3.AC2, R3.AC3 | vp, manager, product (test-case, activity-log); vp, manager (integrations) | Open the same pages by typed URL. | D-CASE | Each listed request is sent and returns 200; `?path=email-check` may return 502 "Crew Desk integration is not configured"; any other status fails. Activity card shown with D-CASE's activity (as today). | captures |
| MT-R3-07 | R3.AC7 | — | After S1 ends and the owner has written "did not use :3000" (T5): grep `logs/app-<UTC date>.log` (both files if the window crosses midnight) for lines in [start, end] matching `/api/activity-logs` or `/api/integrations/crewdesk` with `-> 403`. Positive control first: the same grep without the time filter must find the known 403 lines from 2026-10-15 (QA doc line 83). | UTC start/end | 0 lines in the window. Without the owner's confirmation: NOT VERIFIED (not PASS, not FAIL). | grep command + raw output |
| MT-R3-06 | R3.AC6 | vp (toggle), qa2 | T6: `qa_engineer / view_activity_logs` **on**. qa2 F5 (capture `/api/auth`), type `/test-cases/<D-CASE id>`. vp restores T6. | D-CASE | Activity request sent → 200; the Activity card shows the same rows the vp saw in S0-6. If D-CASE has no activity: BLOCKED (M1). | capture, screenshot |

#### R4 — docs (S5, file reads only)

| Test id | Criterion | Steps | Expected |
|---|---|---|---|
| MT-R4-01 | R4.AC1 | Read `CODEBASE-MAP.md` §6; Glob every path in the routes table. | `auth-screen.tsx` given as `src/components/auth-screen.tsx`; every named path exists. |
| MT-R4-02 | R4.AC2 | Grep `agent.md`, `CODEBASE-MAP.md` for battery counts; read `docs/README.md:75`. | No count other than 67 in the two current-state docs; `docs/README.md:75` unchanged (Q8). |
| MT-R4-03 | R4.AC3 | Read `agent.md` §3 item 7. | Plain DoD item: `node scripts/verify-review-matrix.mjs` → `36 passed, 0 failed`; no "still has to be updated". |
| MT-R4-04 | R4.AC4 | Read `docs/06-page-login-and-dashboard.md` dashboard section. | Buttons listed with the R2 gates, incl. the KPI card and "View all" (Q10 = yes). |
| MT-R4-05 | R4.AC5 | Read the `/tasks` row in `CODEBASE-MAP.md` §6. | Both gates: `view_all_task_reports` (team view), `create_task_report` (own log editing). |
| MT-R4-06 | R4.AC6 | `git log -p` on the 5 doc files since `6a8e75f`. | Only the D11 lines changed (`CODEBASE-MAP.md` :78, :114, :120, :126; `agent.md` :208-209; `docs/06` :74-76, :93-94; `docs/04` :206, :216); `docs/README.md` untouched. Any other changed line = FAIL. |
| MT-R4-07 | R4.AC7 | Read `agent.md:250-253`, `CODEBASE-MAP.md:37`. | `.zscripts/` wording present and unchanged. |
| MT-R4-08 | R4.AC8 | Read `docs/04-api-reference.md` entity activity line. | States `view_activity_logs` is required. |
| MT-R4-09 | R4.AC9, R11.AC6 | Read `docs/04-api-reference.md` PUT task-report line. | `create_task_report` + ownership, lists 403 "Insufficient role". |

#### R11 — `PUT /api/task-reports?id=` (curl, via `http://localhost:3000`)

Status order from `04-design.md` 2.1: CSRF 403 → 401 → 400 missing id → 400 invalid body → 403 "Insufficient role" → 404 → 403 own-only → 200. A 400 for a bad body is **not** a bug (BE-R1). Failed attempts are not writes (P4).

| Test id | Criterion | Role | Request (all with `X-Requested-With: tcms` unless stated) | Expected |
|---|---|---|---|---|
| MT-R11-01a | R11.AC1 | viewer | `PUT /api/task-reports?id=<D-UUID>` body `{}` | 403 `{"error":"Insufficient role"}` (not 404). |
| MT-R11-01b | R11.AC1 | viewer | `PUT ?id=<W1 id>` (product's report) body `{"notes":"MT viewer edit"}`; then vp `GET ?id=<W1 id>` | 403 "Insufficient role"; W1 unchanged (notes, tasks, `totalMinutes` equal to before). |
| MT-R11-02 | R11.AC2 | viewer (after T2 restored) | `PUT ?id=<W3 id>` body `{"notes":"MT viewer own edit"}`; then viewer `GET ?id=<W3 id>` | 403 "Insufficient role"; W3 unchanged. |
| MT-R11-03 | R11.AC3 | product | (a) `PUT ?id=<W1 id>` body `{}` (keeps stored tasks and notes, `task-reports.service.ts:265-271`) = W4; (b) `PUT ?id=<W2 id>` body `{}`; (c) `PUT ?id=<D-UUID>` body `{}`; (d) `PUT ?id=<W1 id>` body D-BADBODY; (e) no cookies, `PUT ?id=<W1 id>` body `{}` | (a) 200, tasks/notes unchanged; (b) 403 "You can only edit your own reports"; (c) 404 "Report not found"; (d) 400; (e) 401. |
| MT-R11-04 | R11 status order | viewer | (a) no CSRF header, `PUT ?id=<D-UUID>` `{}`; (b) `PUT` with no `id`; (c) `PUT ?id=<D-UUID>` body D-BADBODY | (a) 403 "Missing CSRF verification header"; (b) 400 "Missing report id"; (c) 400 "Invalid input" (before the permission check; not a bug). |
| MT-R11-05 | R11.AC5 | — | `git diff` of the R11 commit. | Only `task-reports.service.ts` (one `ensurePermission` line + JSDoc); no schema, migration, cache or client file. |

#### R10 — running app and safe testing

| Test id | Criterion | Steps | Expected |
|---|---|---|---|
| MT-R10-01 | R10.AC2 | `curl -s -i http://localhost:3000/api` at S0-1 and S6-1 (and at start/end of phases 8 and 9 if the tester runs then). | 200, JSON `status` = `ok`. Raw response pasted. |
| MT-R10-02 | R10.AC1, R10.AC5, R10.AC7 | Review the tester's own command list in `07-test-report.md`; list every command the tester ran. | No start/stop/kill of node or next; only `taskkill /PID <own chrome pid> /T /F`; own profile path recorded; no failed login, no password/profile change. |
| MT-R10-03 | R10.AC9, C1 | vp `GET /api/permissions` before T1 and after T6 restore; after each restore, `GET /api/permissions` for that cell. Compare with a Node one-liner in the scratchpad (count = 126, every `source` = `default`, equal to `perm-S0.json`). Toggles only through `/settings/permissions` in the UI as vp; never by SQL; the PUT response is never used as state. | Both snapshots: 126 cells, all `source:"default"`, identical. Each cell back to default right after its check. |
| MT-R10-04 | R10.AC12, P4 | After S3 and after S4: grep the log for `Notification delivery attempted` with `email:sent` or `telegram:sent` from the first write until 60 s after the last write. Positive control: the same grep finds the `email:skipped` lines (S0-7). | 0 `sent` lines. If > 0: all writes stop and the owner is told (Q17 tripwire). |
| MT-R10-05 | R10.AC8 | Compare the writes in `07-test-report.md` with the budget (M4). | Exactly W1–W4 and T1–T6 (12 permission PUTs); no other write. |
| MT-R10-06 | R10.AC10 | Record UTC start/end of S1 and S4; facilitator confirms no suite ran; owner confirms S1 non-use (T5). | Windows recorded; confirmations present (else R3.AC7 NOT VERIFIED). |
| MT-R10-07 | R10.AC13, P5 (reconcile) | Read the sdet's `check-suite-residue.mjs` output for R6/R7 runs. Accept a "0" only after the same tool showed the known group A rows (`--pattern` group A, before R9). | Positive control non-zero and matching group A; reconciled counts recorded. Tester runs no SQL. |

#### R9 — cleanup cross-check (phase 10; read-only for the tester)

| Test id | Criterion | Steps | Expected |
|---|---|---|---|
| MT-R9-01 | P5 positive control | Read the dry-run output for group A. | It lists the QA-doc group A rows: module "QACHECK module 1792076976458", cases "QACHECK tc1/tc2/tc3", "QACHECK qa case", 1 pending module review + 1 pending case review (assigned to product), wiki "QACHECK wiki", bugs "QACHECK bug", "QACHECK dev bug". Zero rows here = the checker is not validated; stop. |
| MT-R9-02 | R9.AC3 reconciliation | Line by line, compare the dry-run list with QA doc lines 101-114 and with group I ids W1, W2, W3 (+ their `daily_report_submitted` notifications by `entity_type='task_report'`, `entity_id`). Check flags `B (owner decides)`, `D-EMPTY`, `J`, `ORPHAN-RISK`. | Every row is in a source or an approved pattern group (C, D, E2, F, J); anything else is flagged to the owner in writing before approval. Group B shown with its text for the owner. No `users`, `activity_logs`, `role_permissions` row in the delete list. Group G count = 0. |
| MT-R9-03 | R9.AC5 | ≥ 5 s after the delete: vp Ctrl+K "QACHECK", "Imported:", "Perm-verify case", "Verify notification"; `/modules`, `/bugs`, `/wiki`; product `/reviews`. | Nothing found for any deleted group; the two QACHECK reviews gone from product's queue. |
| MT-R9-04 | R9.AC8 | vp `GET /api/permissions`. | 126 cells, all `source:"default"`. |
| MT-R9-05 | R9.AC9, R9.AC11 | Each of the 7 accounts logs in and opens `/dashboard`, `/modules`, `/test-cases`, `/bugs`, `/tasks` (GET only). | No error page; all 7 active. Login rows accepted. No write after R9. |

### M4. Write budget and group I row-id log (R10.AC8, P4, lesson "list side effects")

| # | Write | Account | When | Row created / changed | Side effects | Removal |
|---|---|---|---|---|---|---|
| W1 | `POST /api/task-reports` D-DATE | product | S3, MT-R1-05 | 1 `task_reports` row, id `<W1>` | `daily_report_submitted` in-app to every other active `view_all_task_reports` holder (at least admin, teamlead; others UNKNOWN); email/Telegram attempted per preference (not configured, Q17); activity row if the upsert logs one (kept, Q5) | R9 group I by id + notifications by `entity_id` |
| W2 | `POST /api/task-reports` D-DATE (+ double-click) | qa2 | S3, MT-R1-05/10 | 1 row `<W2>`; a second POST updates the same row | as W1, recipients admin, teamlead, product; a second batch (`verb: updated`) if the double-click sends 2 POSTs | R9 group I |
| W3 | `POST /api/task-reports` D-DATE | viewer (granted by T2) | S4, MT-R1-07b | 1 row `<W3>` | as W2 | R9 group I |
| W4 | `PUT /api/task-reports?id=<W1>` body `{}` | product | S3, MT-R11-03a | W1 `updated_at` only (tasks, notes unchanged) | 1 `activity_logs` UPDATE row (`task-reports.service.ts:272-281`), kept per Q5; no notification | none needed beyond group I |
| T1–T6 | `PUT /api/permissions` on, then off, via `/settings/permissions` as vp | admin | S4 | no lasting `role_permissions` row (default-valued toggle deletes the row) | 12 audit `activity_logs` rows (kept, Q5); live matrix change for every account of that role for the duration of the check | restored immediately; verified by MT-R10-03 |

Toggle cells: T1 `qa_engineer/create_task_report` off; T2 `viewer/create_task_report` on; T3 `manager/create_task_report` off; T4 `viewer/create_bug` on; T5 `developer/perform_review` on; T6 `qa_engineer/view_activity_logs` on.

Not writes (P4): refused calls in MT-R1-09, MT-R1-12 (1, 2), MT-R11-01a/b, -02, -03(b–e), -04. Accepted side rows: refresh tokens and LOGIN activity rows from logins (R9.AC9 analogue).

**Group I log (filled in `07-test-report.md` during S3/S4, copied to the R9 inventory):**

| Write | Account | report_date | taskReportId | Notifications seen (recipient: count) | Delivery `sent` lines |
|---|---|---|---|---|---|
| W1 | product | 2026-10-01 | _(at run)_ | _(at run)_ | _(at run)_ |
| W2 | qa2 | 2026-10-01 | _(at run)_ | _(at run)_ | _(at run)_ |
| W3 | viewer | 2026-10-01 | _(at run)_ | _(at run)_ | _(at run)_ |

Notification counts are read by each recipient's own `GET /api/notifications` (admin, teamlead, product), filtered on `entityId` = the W id. Read-only.

### M5. Toggle window plan (S4, R10.AC9, Q21(1))

1. Facilitator announces the window to the owner (UTC start). The owner does not sign in as qa_engineer, manager, viewer or developer during it.
2. vp `GET /api/permissions` → `perm-S4-before.json`. Must equal `perm-S0.json` (126 cells, all default). If not, stop: nothing is toggled.
3. For each of T1 → T2 → T3 → T4 → T5 → T6: toggle in `/settings/permissions` as vp; wait ≥ 3.5 s (3 s cache, `permissions.ts:70`); the test role does a C4 refresh and captures `/api/auth`; run the check; vp restores the cell (also on FAIL); vp `GET /api/permissions` shows that cell `source:"default"`. Chained after T2's restore: MT-R1-02, MT-R11-02, MT-R1-04b.
4. vp `GET /api/permissions` → `perm-S4-after.json`. Must equal `perm-S4-before.json` (126 cells, all `source:"default"`).
5. UTC end recorded; MT-R10-04 60 s later.
6. If a restore fails or the after-snapshot differs, stop all testing and tell the facilitator at once.

### M6. Always-covered checklist (template)

| Item | Where |
|---|---|
| Each role allowed and denied | MT-R2-01, MT-R2-02, MT-R2-09, MT-R3-01a/b/c, MT-R3-02, MT-R1-05, MT-R1-01 |
| Direct URL without permission | MT-R3-01b/c (path 1), MT-R2-09 |
| Empty / long / special input (emoji, Hindi, 500/501) | MT-R1-12, D-DESC-P, D-DESC-Q, MT-R1-07b |
| Double submit | MT-R1-10 |
| Back / forward | MT-R1-01, MT-R1-13, MT-R3-01 path 3 |
| Refresh on each page | MT-R1-01, MT-R1-13, MT-R2-01, MT-R3-01 path 2, MT-R2-09 |
| Error states | MT-R1-11, MT-R2-08, MT-R1-09, MT-R11-01..04 |

---

## Automated (sdet)

Author: sdet, 2026-10-15 (phase 5). Every count below comes from reading the script in this run (HEAD `6a8e75f`). No suite, DB query or :3000 request was run. The only command run was the R8 baseline audit (A8).

### A0. Rules for every automated run

| Item | Rule |
|---|---|
| Shell | Git Bash: `node scripts/<suite> > <evidence file> 2>&1; echo "exit=$?"`. Ctrl+C tests only: a cmd console, `node scripts\<suite> > <file> 2>&1` then `echo exit=%ERRORLEVEL%` (Git Bash/mintty may hard-kill node without SIGINT, S4). Never PowerShell 5.1 `Out-File` (UTF-16). |
| Evidence | Raw output files in `evidence/` as `suite-<name>-<UTC yyyymmddThhmm>.txt`, plus the exit code. Counts in `07-test-report.md` are copied from these files only. |
| Exit codes (R6, R7, residue checker, R9 script) | `0` green · `1` any FAIL (incl. cleanup errors and forced failures) · `2` NOT RUN: DB guard, lock held, `PRECONDITION`, unknown `VERIFY_FAIL_AT`/`VERIFY_PAUSE_AT` value · `130` Ctrl+C (after cleanup). An exit-2 run prints no `PASS=` line and is reported NOT RUN, never PASS or FAIL (P6). |
| Output (R6, R7) | Line 1: `STAMP=<Date.now()>`. Line 2: `MANIFEST=<os.tmpdir()>\tcms-verify\<suite>-<stamp>.json` (fixture ids + collected entity ids, no secrets). Line 3: `GUARD @@port=<n> DATABASE()=<db> urlTargetOk=<bool>`. Last lines: `PASS=<n> FAIL=<n>` then the suite's RESULT line. |
| DB guard + lock (R10.AC11, Q18, P8) | `scripts/lib/db-guard.mjs` (`04-design.md` 2.3): first statement `SELECT @@port, DATABASE()`; proceed only if `tcms_test`, `@@port` = 5500 and `urlTargetOk=true`; then `GET_LOCK('tcms_verify', 0)` on the single connection (`connection_limit=1`). Abort branch evidence: code reading + the printed guard line (P5). |
| Writing suites (lesson 2026-10-15) | All work in `main()`; `try`/`finally`; `process.exitCode` only, no `process.exit()` inside `try`; a `SIGINT` handler runs the same cleanup once (a second Ctrl+C during cleanup is ignored with `cleanup in progress`); every cleanup step has its own try/catch and is a counted check; cleanup is keyed on fixture user ids and collected ids, titles carry the stamp only as a second key. |
| Test-only hooks | `VERIFY_FAIL_AT=<step>` throws at that step (counted as 1 FAIL `forced failure at <step>`). `VERIFY_PAUSE_AT=<step>` sleeps 20 s and prints `PAUSED <step>` (used only for CONC-2/3). Unknown value → exit 2 before the guard. No app edit. |
| Passwords | Fixture passwords generated in memory (`crypto.randomBytes`), never printed. Demo passwords are only in the existing scripts (B13, out of scope). |

### A1. R5 — `verify-review-matrix.mjs` (read-only)

Change: `:52` and `:74` → `hasPerform` only; comment `:72-73` updated; `hasSubmit` kept in the log line `:53`. Nothing else.

| Criterion | Check name (as printed) | Roles → expected | Count |
|---|---|---|---|
| R5.AC1 | `<role>: session role matches` | all 6 → true | 6 |
| R5.AC2, AC3 | `<role>: module-reviews?action=all 200\|403` | vp, manager, product 200; developer, qa_engineer, viewer 403 | 6 |
| R5.AC1 | `<role>: GET /reviews?action=queue -> 200`, `<role>: GET /module-reviews?action=queue -> 200` | all 6 → 200 | 12 |
| R5.AC2, AC3 | `<role>: GET /reviews 200\|403` | as action=all | 6 |
| R5.AC1 | `<role>: GET /permissions 200\|403` | vp 200, others 403 | 6 |
| **Total** | `REVIEW-MATRIX RESULT: 36 passed, 0 failed`, exit 0 | | **36** |

- Before the fix (control): `34 passed, 2 failed` (qa_engineer `action=all` and `/reviews`), QA doc line 92.
- R5.AC4: `git diff` shows only `:52`, `:72-74` changed; 36 `check(` executions unchanged. R5.AC5: static read: the only non-GET is the login POST (`:24`). R5.AC6: serial rule (A10).

### A2. R6 — `verify-wiki.mjs` (writes stamped fixtures)

**Base count correction (WORKFLOW rule 4, both sources reported):** BRD R6.AC1 and manager SD2 say 47 executed checks because "`:18` is the definition". Line `:18` is `const ok = (cond, msg) =>` and contains no `ok(`. `grep -n "ok(" scripts/verify-wiki.mjs` lists 48 call sites: `62 66 70 73 76 82 84 85 86 88 94 97 100 103 106 114 117 120 122 127 139 141 146 147 148 152 158 160 166 172 178 181 188 189 190 196 202 208 211 214 217 220 224 238 243 248 261 263`. None is inside a loop. **Today's executed count is 48** (sections 1–7: 43, section 8: 3, section 9: 2). R6.AC1 lets the sdet fix `<n>` by code reading, so the pinned total below uses 48. No AC changes.

| Criterion | Check(s) | Count |
|---|---|---|
| R6.AC6 | Existing sections 1–9, unchanged names and expected statuses (`:59-264`) | 48 |
| R6.AC8 | §8 `grant developer/create_wiki_doc via PUT /api/permissions as fixture VP -> 200`, `grant developer/delete_wiki_doc … -> 200` (replace the SQL at `:231-233`) | 2 |
| R6.AC8 | §8 `revoke developer/create_wiki_doc via PUT (default-restore) -> 200`, `revoke developer/delete_wiki_doc … -> 200` (replace the SQL at `:245`; `permissions.service.ts:58-60` deletes the row) | 2 |
| R6.AC4, AC5 | Cleanup steps, one check each, in this order: `cleanup: wiki_documents by fixture author_id` (one DELETE per id, authoritative sweep incl. unstamped `:180`, `:192`, `:247`) · `cleanup: role_permissions touched cells` (S2: row with `updated_by_id` = fixture VP → DELETE; no row → ok; row by anyone else → FAIL `matrix changed by another actor`, not touched) · then ≥ 3.5 s wait · `cleanup: activity_logs by fixture user_id` · `cleanup: login_attempts by fixture email` · `cleanup: users by fixture id` (refresh_tokens, notifications cascade) | 5 |
| R6.AC3 (i), C1 | `matrix: touched cells equal the pre-run GET snapshot` (GET as fixture VP, after the wait, before the users step) | 1 |
| R6.AC10 | `matrix: untouched cells unchanged` (FAIL text `matrix changed by another actor`; the suite never restores those cells) | 1 |
| R6.AC4 | `residue: users=0`, `residue: wiki_documents=0`, `residue: activity_logs=0`, `residue: notifications=0`, `residue: refresh_tokens=0` (by stamp emails / fixture ids) | 5 |
| **Total (R6.AC1)** | `PASS=64 FAIL=0`, then `RESULT: ALL WIKI API CHECKS GREEN`, exit 0 | **64** |

- Snapshot order (P6): SQL precondition on the two developer rows (no fixture yet) → fixture users by raw INSERT (`notify_email=0`, `notify_telegram=0`, BE-R2) → logins → 126-cell GET snapshot as fixture VP → sections.
- Precondition (R6.AC3 ii): either `developer/create_wiki_doc` or `developer/delete_wiki_doc` has a row → `PRECONDITION: developer/<action> has an override row (enabled=…, updated_by_id=…)`, no fixture, exit 2.
- Static (R6.AC2, AC7): `grep -nE "ON CONFLICT|NOW\(\)|INSERT IGNORE|db\.[a-z][A-Za-z]*\.(create|update|delete|upsert|find)|\\\$queryRaw\`\s*(INSERT|UPDATE|DELETE)|/tmp|execSync" scripts/verify-wiki.mjs scripts/lib/*.mjs` → 0 lines. `UTC_TIMESTAMP(3)` is the only timestamp written.

### A3. R7 — `verify-permission-matrix.mjs` (port to the default matrix)

Today: 2 signup (`:41-42`) + 1 fixtures (`:91`) + 150 probes (25 × 6, `:255-266`) + 10 round-trip (`:276-300`) + 2 hygiene (`:308-309`) = **165**.

Fixture identity (group J, S3): users `permmatrix-{vp,mgr,prod,dev,qa,viewer}-<stamp>@tcms.test` created by raw SQL; signup account `permmatrix-signup-<stamp>@tcms.test`; module `permmatrix module <stamp>` created by the fixture VP; every probe title gets ` <stamp>` appended (`:105`, `:148`, `:216` today unstamped). `<stamp>` = full `Date.now()` (13 digits, not `slice(-6)`). No demo account logs in (R7.AC10). `devOpt` (`:273`) = the fixture developer's id. The submit probe (`:115`) sends `reviewerId` = fixture manager (R7.AC11). Feasibility read in this run: `submitTestCaseForReview` only checks that the reviewer exists and is active (`test-cases.service.ts:252-254`), so assigning the review to a developer without `perform_review` works and R7.AC3's order holds.

| Criterion | Check(s) | Count |
|---|---|---|
| R7.AC5 | Open signup: `signup: register -> 200 + role=viewer`, `signup: session permissions = []`. Closed signup: `signup: register -> 403 (closed)`, `signup: no user row for the signup email` (SQL). Exactly 2 in either branch; closed branch also by code reading `auth.service.ts:167-173`. | 2 |
| R7.AC10, AC7 | `fixtures created` (6 users, module, 2 cases, wiki, bug; condition extended to the module) | 1 |
| R7.AC2 | 25 probes × 6 roles, expectations = `DEFAULT_PERMISSIONS`. Changed vs today: none of the 150 `expect` rows assume developer/qa_engineer `perform_review` (the 25 rows at `:98-252` already encode defaults; reviewed row by row in phase 6 against `permissions.ts:37-63`). `edit module` targets the fixture module (R7.AC7). | 150 |
| R7.AC13 | `toggle probe: every restore PUT -> 200 and viewer/create_bug reads source default (GET)` — executed once, right after the toggle probe's 6 roles | 1 |
| R7.AC3 | Round-trip, new order: `review submitted to fixture developer` · `developer verdict without perform_review (default) -> 403` · `VP grant developer/perform_review -> 200` · `developer session now carries perform_review` · `developer verdict after grant -> 200` · `VP revoke developer/perform_review (default-restore) -> 200`; viewer `create_test_case` grant/use/revoke/deny unchanged (4) | 10 |
| R7.AC3, AC4 | Hygiene: `viewer/create_test_case back to default source` (kept) · `developer/perform_review reads source default, enabled false` (replaces `:309`) | 2 |
| R7.AC4, R6.AC10 | `matrix: touched cells equal the pre-run GET snapshot` (viewer/create_bug, viewer/create_test_case, developer/perform_review) · `matrix: untouched cells unchanged` | 2 |
| R7.AC6, AC8 | Cleanup steps (design 2.3 order), one check each: `notifications by entity_type/entity_id of collected ids` · `bugs` · `test_cases` (before the module) · `review_requests/module_review_requests by fixture reviewer/requester` · `wiki_documents` · `modules` (FAILs without deleting if any case or bug still points at it — SET NULL trap) · `role_permissions touched cells` (S2 rule) · `activity_logs by fixture user_id` · `login_attempts by fixture email` · `users by fixture id (incl. signup account)` | 10 |
| R7.AC6 | `residue: <table>=0` for users, modules, test_cases, test_case_history, review_requests, review_events, module_review_requests, bugs, bug_test_case_links, wiki_documents, task_reports, role_permissions, activity_logs, refresh_tokens, notifications (by fixture `user_id` **and** by entity ids in the manifest) | 15 |
| **Total (R7.AC1, AC9)** | `PASS=193 FAIL=0` and `RESULT: 193 passed, 0 failed`, exit 0 | **193** |

- Added vs 165: +1 toggle restore, +2 matrix, +10 cleanup, +15 residue = +28. Removed: none. Changed: `:309` assertion (R7.AC3), round-trip order (same 6 checks), signup closed-branch pair. Matrix checks stay 150 (R7.AC9).
- Precondition (R7.AC0, P6): `SELECT COUNT(*) FROM role_permissions` before any fixture; > 0 → `PRECONDITION: <n> override row(s): <role/action list>`, exit 2, no write. Replaces `:61-66`.
- Collected ids: cases, review_requests, module reviews, bugs, task_reports, wiki docs, modules are read **by SQL from the fixture ids** at the start of cleanup (and written to the manifest), not only from responses.
- Static (R7.AC2b): same grep as A2 → 0 lines; plus `grep -n "admin@tcms.com\|@tcms.com'" scripts/verify-permission-matrix.mjs` → 0 lines (R7.AC10).

### A4. R11.AC4 — `verify-permissions.mjs`

Today: 31 executed checks (32 only when no bug exists, `:110-114`); QA doc line 90 `31 passed, 0 failed`.

| Criterion | Check name | Expected | Count |
|---|---|---|---|
| R11.AC4, AC1 | `viewer PUT /task-reports?id=<random uuid> body {} -> 403 Insufficient role` | 403, `error` = `Insufficient role` | 1 |
| R11.AC4, AC3 | `qa PUT /task-reports?id=<random uuid> body {} -> 404 Report not found (holder passes the gate)` | 404 | 1 |
| **New total** | `PERMISSION-BEHAVIOR RESULT: 33 passed, 0 failed` (34 if `:113` runs) | | **33** |

- Uses the existing `viewer` and `qa` (qa1) sessions; `crypto.randomUUID()`; `X-Requested-With: tcms` (already in `api()`). Writes nothing (`{}` is valid, `04-design.md` 2.1).
- Control run before the R11 server line: expect `32 passed, 1 failed` (viewer gets 404). After: `33 passed, 0 failed`. Both raw outputs pasted (`04-design.md` §6).

### A5. R8 — `audit-standards.mjs`

| Criterion | Test | Expected |
|---|---|---|
| R8.AC5, AC6 | **Baseline (done in this run, A8):** `evidence/r8-audit-baseline.txt` + `.meta.txt` | `193 violation(s) across 193 TS files`, all 193 `[naming]`, 0 other findings, exit 1. AC6 holds: 193 = 193. |
| R8.AC5 | Fix `:89` → `path.basename(file)` as the **first** edit of phase 6, before any `src/` edit; rerun at once on the same tree (HEAD `6a8e75f`, `git status --porcelain src` empty) → `evidence/r8-audit-after.txt` + exit code | `STANDARDS AUDIT: 0 violations across 193 TS files`, exit 0 (all 193 base names are kebab-case: `find src -name "*.ts*" -printf "%f\n"` segment check returned no non-kebab segment). If any `src/` file changed first, the comparison is void and is reported NOT VERIFIED. |
| R8.AC5 | Compare: `grep "✗" <file> \| grep -v "\[naming\]" \| sort` for both files, `diff` → empty; `sed -nE 's/.*across ([0-9]+) TS files.*/\1/p'` → 193 in both | empty diff; 193 = 193 |
| R8.AC1, AC2 | In the after file and in the end-of-phase-6 DoD run: every `[naming]` line quotes a base name only and the name is truly non-kebab | 0 `[naming]` lines expected on the current tree |
| R8.AC3 + S5 | `node scripts/audit-standards.mjs --self-test` runs the same predicate (`namingViolation`, `path.win32.basename`) on 12 samples (phase 6 added 3 full absolute paths): fail `BadName.ts`, `bad_name.service.ts`, `src\components\views\BadName.tsx`, `src/components/views/BadName.tsx`, `C:\dev\tcms\src\components\views\BadName.tsx` (each must report the base name only); pass `test-cases.service.ts`, `page.tsx`, `src\app\api\test-cases\test-cases.service.ts`, `src/app/api/test-cases/test-cases.service.ts`, `src\app\(app)\activity-log\page.tsx`, `C:\dev\tcms\src\app\(app)\module-reviews\[id]\page.tsx`, `/home/ci/tcms/src/app/(app)/module-reviews/[id]/page.tsx` | `PASS=12 FAIL=0`, exit 0; no file under `src/` |
| R8.AC4 | Raw after-output pasted in `06-dev-report.md`; any non-naming finding goes to the manager for the backlog (B12 follow-up), not fixed here | — |

### A6. Q7 — `scripts/verify-ui-gates.mjs` (R1–R3, read-only, new)

Chrome over CDP (`C:\Program Files\Google\Chrome\Application\chrome.exe`, existence NOT VERIFIED until the first run), headless, `--user-data-dir=<os.tmpdir()>\tcms-ui-gates-<stamp>`, random `--remote-debugging-port`; login by `POST /api/auth?path=login` (demo accounts, qa1 for qa_engineer: login rows only) then `Network.setCookie`; captures `Network.requestWillBeSent` / `responseReceived`. Precondition: vp `GET /api/permissions` = 126 cells all `source:"default"`, else exit 2. Exit 0/1/2/130 as A0. Cleanup in `finally` + SIGINT: `taskkill /PID <spawned pid> /T /F` only (never by image name), then prove no `chrome.exe` command line contains the profile dir, then delete the dir.

| Criterion | Block | Checks | Count |
|---|---|---|---|
| R1.AC1 (b), AC3, P1, P2 | viewer, typed `/tasks` (today's date in the Date field) | no "Add task"; no "Save report"; no task row card (no remove control); exactly one notice and it equals N1 byte for byte; empty state = `No tasks logged for ${<Date input value>}.`; no "Add your first entry"; "Export CSV" disabled; no "User" picker; 0 `POST`/`PUT /api/task-reports` in the capture; 0 `/api/*` 403 | 10 |
| R1.AC5 (positive control for the selectors) | product, qa1 on `/tasks` | "Save report" visible; "Add task" visible; no N1/N2/N3 — each role | 6 |
| R2.AC1, AC5 | 6 roles, `/dashboard` | 9 buttons present/absent exactly per `02-brd.md:140-150` (54); Quick Actions tile count = vp 6, manager 6, product 6, developer 3, qa 4, viewer 2 (6) | 60 |
| R2.AC8 | 6 roles | Latest Activity "View all" present for vp/manager/product, absent otherwise | 6 |
| R2.AC6 (a)–(d) | developer, qa1, viewer | KPI "My Pending Reviews": not `<button>`, no `role="button"`, no `tabindex`; no `svg.lucide-chevron-right`; click → URL `/dashboard` and 0 `/api/reviews*` requests; value = hero chip "pending reviews" | 12 |
| R2.AC6 positive | vp, manager, product | KPI card is a `<button>`; click opens `/reviews` | 6 |
| R3.AC1 (paths 1, 2), R3.AC3 | developer, qa1, viewer on `/test-cases/<first case from vp GET /api/test-cases?pageSize=1>`; typed URL and full reload, 30 s each | per visit: 0 `GET /api/activity-logs?action=entity…`; 0 `/api/*` 403 (12); Activity card not rendered (3) | 15 |
| R3.AC1, R3.AC4 | product, developer, qa1, viewer on `/integrations`, paths 1–2 | per visit: 0 of the 3 Crew Desk requests; 0 403 (16); PermissionDenied text equals `integrations.tsx:216-225` at HEAD (4) | 20 |
| R3.AC1, R3.AC5 | developer, qa1, viewer on `/activity-log`, paths 1–2 | per visit: 0 feed request; 0 403 (12); PermissionDenied text `The activity log is only available to roles with view-activity-log rights.` (3) | 15 |
| R3.AC2 (positive control for the capture) | vp | entity activity request 200; Activity card rendered; Crew Desk config 200; links 200; email-check 200 or 502 `Crew Desk integration is not configured`; activity feed 200 | 6 |
| Harness | — | matrix still 126 default at the end (vp GET); spawned pid tree gone; profile dir removed | 3 |
| **Total** | `PASS=159 FAIL=0`, exit 0 | | **159** |

- Not automated (tester only, M3): R3.AC1 paths 3–4 (back/forward, list clicks, Ctrl+K), R1.AC1(a)/AC2/AC4/AC6–AC8, R2.AC2–AC4, R2.AC7 runtime, R3.AC6, R3.AC7, all toggles and writes, layout, production mode.
- Detection proof: if the script exists before the frontend edits, one run on the unfixed views must FAIL at least R1 viewer checks 1, 2, 4, 5, 7, the developer/viewer "New Test Case"/"Reviews"/"Reports" cells and the R3 request checks, while all positive-control checks PASS. If it is not ready before the edits, this is NOT VERIFIED and the positive controls are the only proof that the selectors work.
- About 32 page loads, ~12–15 min (20 visits × 30 s). Not in the DoD (Q16) and not in `verify-battery.sh` (Linux-only, boots the stack, `verify-battery.sh:5`).

### A7. Residue checker `scripts/check-suite-residue.mjs` (R10.AC13, P5) — read-only

Modes: `--suite=wiki|matrix --stamp=<n> [--manifest=<path>]` (per-table count + PKs keyed on the exact fixture emails, fixture ids and manifest entity ids; R6.AC4 5 tables + `login_attempts` + `role_permissions` by `updated_by_id`; R7.AC6 15 tables) · `--pattern=A|B|C|D|E2|I|J` (R9 groups, same SELECTs as `04-design.md` 2.2) · `--table-counts` (R9.AC1). SELECT only, DB guard + lock. Prints `RESIDUE <table>=<n>` lines and `RESIDUE TOTAL=<n>`; exit 0 if total 0, 1 if > 0, 2 guard/lock.

| Id | Positive control (a "0" counts only after its control showed non-zero, P5) | Expected |
|---|---|---|
| RES-P1 | `--pattern=A` before R9 | non-zero: module "QACHECK module 1792076976458", 4 cases, 2 pending reviews, wiki "QACHECK wiki", 2 bugs (QA doc 101-114). 0 → checker not validated, stop. |
| RES-P2 | `--suite=wiki --stamp=<n>` after `VERIFY_FAIL_AT=mid-cleanup-docs` (A9) | users > 0 and wiki_documents > 0; after `--cleanup-stamp=<n>` → `RESIDUE TOTAL=0` |
| RES-P3 | `--suite=matrix --stamp=<n>` after `VERIFY_FAIL_AT=mid-cleanup-content` (A9) | users, modules, test_cases > 0; after `--cleanup-stamp=<n>` → `RESIDUE TOTAL=0` |
| RES-1 | `--suite=wiki --stamp=<green run>` | `RESIDUE TOTAL=0` (R6.AC4) |
| RES-2 | `--suite=matrix --stamp=<green run>` | `RESIDUE TOTAL=0` (R7.AC6, R7.AC7) |
| RES-3 | `--pattern=J` | lists any `wiki-%-%@tcms.test` / `permmatrix-%-%@tcms.test` user (expected 0 after green runs; feeds the R9 dry run) |

### A8. R8 baseline (captured in this run, before any `src/` or audit edit)

```
date_utc=2026-10-15T18:00:22Z
head=6a8e75fb70efaa79be5f6d0c48733123484e4f3e
git_status_porcelain_src_and_audit_script=<empty>
node=v24.22.0
command=node scripts/audit-standards.mjs > r8-audit-baseline.txt 2>&1 (Git Bash)
exit=1
STANDARDS AUDIT: 193 violation(s) across 193 TS files
naming findings = 193, non-naming findings = 0
```
Files: `evidence/r8-audit-baseline.txt` (194 lines), `evidence/r8-audit-baseline.meta.txt`. Pre-check: `audit-standards.mjs` imports only `readFileSync`, `readdirSync`, `path`, `url`; no write, network or DB call.

### A9. Forced failure, Ctrl+C and recovery (R6.AC5, AC9, R7.AC8, P7, S4)

Each run is followed by `check-suite-residue.mjs` for its stamp and by the matrix compare (residue `role_permissions` = 0 rows; vp `GET /api/permissions` 126 default). Expected counts assume the product is green; a deviation is first checked as a harness bug (lesson mysql-baseline-1).

| Id | Command | Expected |
|---|---|---|
| FF-W1 | `VERIFY_FAIL_AT=after-fixtures node scripts/verify-wiki.mjs` | `PASS=12 FAIL=1` (5 cleanup + 2 matrix + 5 residue), exit 1, RES = 0 |
| FF-W2 | `VERIFY_FAIL_AT=after-grant …` (after both grant PUTs) | `PASS=57 FAIL=1` (43 + 2 + 12); the role_permissions step deletes the 2 fixture-VP rows; matrix identical; exit 1, RES = 0 |
| FF-W3 | `VERIFY_FAIL_AT=mid-cleanup-docs …` (throws after the first doc DELETE) | exit 1; FAIL on the docs step, the users step (RESTRICT FK, `migration.sql:399`) and residue users / wiki_documents / refresh_tokens; RES-P2 non-zero; then `node scripts/verify-wiki.mjs --cleanup-stamp=<n>` → exit 0, RES = 0 (P7) |
| FF-W4 | `VERIFY_FAIL_AT=bogus …` | exit 2 before the guard, no `PASS=` line |
| FF-W5 | Ctrl+C in a cmd console when `== 5.` is printed | `INTERRUPTED (SIGINT)`, cleanup checks run, FAIL ≥ 1, exit 130, RES = 0, matrix identical |
| FF-M1 | `VERIFY_FAIL_AT=after-fixtures node scripts/verify-permission-matrix.mjs` | `PASS=30 FAIL=1` (3 + 10 + 2 + 15), exit 1, RES = 0 |
| FF-M2 | `VERIFY_FAIL_AT=after-grant …` (after `VP grant developer/perform_review -> 200`) | `PASS=184 FAIL=1` (3 + 150 + 1 + 3 + 27); developer/perform_review row restored; exit 1, RES = 0 |
| FF-M3 | `VERIFY_FAIL_AT=mid-cleanup-content …` (throws after the first test_case DELETE) | exit 1; the modules step refuses (cases remain); RES-P3 non-zero; then `--cleanup-stamp=<n>` → exit 0, RES = 0 |
| FF-M4 | `VERIFY_FAIL_AT=bogus …` | exit 2, no `PASS=` line |
| FF-M5 | Ctrl+C in a cmd console during `=== MATRIX PROBES ===` | as FF-W5 |
| REC-1 | `--cleanup-stamp=<n>` while another run holds the lock | exit 2 `lock held`, nothing deleted (S3) |
| REC-2 | `--cleanup-stamp=<n>` for a stamp with no rows | every step 0 rows, exit 0 |
| REC-3 | Code reading: recovery selects users by exact `<prefix>-<role>-<stamp>@tcms.test` (no wider LIKE), deletes a `role_permissions` row only when `updated_by_id` is one of that stamp's fixture ids, and does not run `:261`/`:263` | stated in `06-dev-report.md` |

### A10. Serial-run rule and lock (R10.AC10, P8)

- **Lock-holding scripts** (take `GET_LOCK('tcms_verify', 0)` after the guard, exit 2 if held): `verify-wiki`, `verify-permission-matrix`, their `--cleanup-stamp` mode, `check-suite-residue`, `cleanup-req001-testdata` (R9).
- **HTTP-only suites** (cannot hold the lock; procedural): `verify-permissions`, `verify-review-matrix`, `verify-import`, `verify-notifications`, `verify-ui-gates`. The facilitator runs every listed script one at a time and records UTC start/end per run in `07-test-report.md`. None runs inside the tester's S1 (R3) or S4 (toggle) window or the sdet window W-SD.
- **Matrix actors** (never overlap): `verify-permissions` (developer/perform_review `:144`, `:156`), `verify-permission-matrix`, `verify-wiki`, the tester's S4, W-SD. `verify-review-matrix` and `verify-ui-gates` read the matrix from the login snapshot and are also serial.

### A11. Concurrency and precondition checks (sdet window W-SD)

W-SD is one announced window after the tester's S4, run by the sdet, with the same owner rule as S4 (owner does not sign in as developer or viewer). The only matrix writes are the PUTs below, made with curl as `admin@tcms.com` through `PUT /api/permissions`, each restored at once and verified by GET (C1).

| Id | Criterion | Steps | Expected |
|---|---|---|---|
| CONC-1 | P8 lock | Start `VERIFY_PAUSE_AT=after-fixtures node scripts/verify-wiki.mjs`; during `PAUSED`, run `check-suite-residue.mjs --pattern=J` | the checker exits 2 `lock held`; the suite then finishes green (`PASS=64 FAIL=0`) |
| PRE-1 | R6.AC3 (ii), R7.AC0 | PUT `developer/create_wiki_doc` on; `check-suite-residue --table-counts` prints the row (`enabled`, `updated_by_id`, `updated_at`); run `verify-wiki` then `verify-permission-matrix`; print the row again; PUT it off; GET 126 default | both suites: `PRECONDITION: …`, exit 2, no `PASS=` line, no fixture user (RES-3 = 0); the row byte-identical before and after both runs |
| CONC-2 | R6.AC10 | `VERIFY_PAUSE_AT=section-5 node scripts/verify-wiki.mjs`; during `PAUSED`, PUT `viewer/create_wiki_doc` on | suite: FAIL `matrix changed by another actor` on the untouched-cell check, the cell **not** restored by the suite, exit 1, RES = 0; then sdet PUTs it off; GET 126 default |
| CONC-3 | S2 | `VERIFY_PAUSE_AT=after-grant VERIFY_FAIL_AT=after-grant node scripts/verify-wiki.mjs` (at the same step the pause runs first, then the throw, so no in-run revoke happens); during `PAUSED`, PUT `developer/create_wiki_doc` enabled=true as demo admin (row now `updated_by_id` = admin) | cleanup: `developer/delete_wiki_doc` (fixture-VP row) deleted; `developer/create_wiki_doc` (admin row) **not** touched, role_permissions step FAIL `matrix changed by another actor`; exit 1; users RES = 0; then sdet PUTs it off; GET 126 default |

Concurrency for R11: none new (`04-design.md` 2.1). Two users acting at once on the matrix are covered by CONC-2/3.

### A12. Traceability (every sdet-owned criterion)

| Criterion | Script | Check name / id | Type |
|---|---|---|---|
| R5.AC1–AC4 | verify-review-matrix.mjs | A1 (36 checks) | permission / regression |
| R5.AC5 | — | static read, A1 | regression |
| R5.AC6 | — | A10 | concurrency |
| R6.AC1, AC6 | verify-wiki.mjs | 48 existing + 16 new, `PASS=64 FAIL=0` | API / permission |
| R6.AC2, AC7 | grep | A2 static | regression |
| R6.AC3 (i) | verify-wiki.mjs | `matrix: touched cells equal…` | permission |
| R6.AC3 (ii) | verify-wiki.mjs | PRE-1 | permission |
| R6.AC4 | verify-wiki.mjs + check-suite-residue | 5 residue checks, RES-1, RES-P2 | regression (data) |
| R6.AC5 | verify-wiki.mjs | FF-W1…W5 | regression (cleanup) |
| R6.AC8 | verify-wiki.mjs | 4 PUT checks | permission |
| R6.AC9 | verify-wiki.mjs | FF-W3, REC-1…3 | regression (cleanup) |
| R6.AC10 | verify-wiki.mjs | `matrix: untouched cells unchanged`, CONC-2 | concurrency |
| R7.AC0 | verify-permission-matrix.mjs | PRE-1 | permission |
| R7.AC1, AC2, AC9 | verify-permission-matrix.mjs | `PASS=193 FAIL=0` (150 matrix) | permission |
| R7.AC2b, AC10 | grep | A3 static | regression |
| R7.AC3 | verify-permission-matrix.mjs | round-trip 10 + hygiene 2 | permission |
| R7.AC4 | verify-permission-matrix.mjs | 2 matrix checks | permission / concurrency |
| R7.AC5 | verify-permission-matrix.mjs | 2 signup checks + code reading | permission |
| R7.AC6, AC7 | verify-permission-matrix.mjs + check-suite-residue | 15 residue, RES-2, RES-P3 | regression (data) |
| R7.AC8 | verify-permission-matrix.mjs | FF-M1…M5, REC-1…3 | regression (cleanup) |
| R7.AC11 | verify-permission-matrix.mjs | submit probe `reviewerId` (code reading) + residue notifications = 0 | API |
| R7.AC12 | — | owner Q17/Q19 answered (03-review); tester MT-R10-04 after each R7 run | regression |
| R7.AC13 | verify-permission-matrix.mjs | `toggle probe: every restore…` | permission |
| R8.AC1–AC6 | audit-standards.mjs | A5, A8 | regression |
| R9 script behaviour (AC2, AC2a–d, AC4) | cleanup-req001-testdata.mjs + check-suite-residue | dry run writes nothing (`--table-counts` equal before/after the dry run); RES-P1; guard line; delete run PASS per table; RES for every approved PK = 0 (phase 10, after the owner's go) | regression (data) |
| R10.AC10, AC11, AC13 | all lock scripts | A0, A10, CONC-1, guard line | concurrency |
| R11.AC4 | verify-permissions.mjs | A4 (2 checks, 33 total) | permission |
| R1.AC1, AC3; R2.AC1, AC5, AC6, AC8; R3.AC1–AC5 | verify-ui-gates.mjs | A6 (159 checks) | permission (UI) |

**Cannot be automated here** (tester or code reading): R1.AC2, AC4, AC6–AC8; R2.AC2–AC4, AC7 runtime; R3.AC6, AC7; R4 (docs); R7.AC5 closed branch; R9.AC3 (owner approval), AC5 (UI search); R10.AC1–AC9, AC12.

## Regression suites that must stay green

DoD per `agent.md` §3. Run serially (A10) at the end of phase 6, in phase 7, after every phase 9 fix and in the phase 10 release review. Each output is saved raw (A0) and pasted.

| # | Suite | Command | Expected |
|---|---|---|---|
| 1 | TypeScript | `npx tsc --noEmit` | 0 errors |
| 2 | ESLint | `npx eslint .` | 0 errors (warnings listed, not blocking) |
| 3 | Build (Q1) | In a separate git worktree outside the project folder, never in `C:\dev\tcms` (the owner's `next dev` writes `.next/` there): `git -C C:/dev/tcms worktree add --detach C:/dev/tcms-build-req001 <commit under test>`; `cd C:/dev/tcms-build-req001 && npm ci && npm run build > <evidence>/dod-build-<utc>.txt 2>&1; echo exit=$?`; then `git -C C:/dev/tcms worktree remove C:/dev/tcms-build-req001`. `.env` is never copied. Only committed changes are in the worktree. | exit 0 and "Compiled successfully". If it fails for a missing env value, or the REQ changes are not committed: NOT VERIFIED (owner runs the build), never PASS |
| 4 | Import | `node scripts/verify-import.mjs` | `<n> passed, 0 failed` (last known 33, QA doc line 89). Creates group C rows every run |
| 5 | Permissions | `node scripts/verify-permissions.mjs` | `PERMISSION-BEHAVIOR RESULT: 33 passed, 0 failed` after R11 (A4). Creates group D rows every run |
| 6 | Notifications | `node scripts/verify-notifications.mjs` | `NOTIF-AUTH RESULT: <n> passed, 0 failed` (last known 29, QA doc line 91). Creates group E/E2 rows every run |
| 7 | Review matrix | `node scripts/verify-review-matrix.mjs` | exactly `REVIEW-MATRIX RESULT: 36 passed, 0 failed` (A1) |
| — | Standards audit (report only) | `node scripts/audit-standards.mjs > <file> 2>&1; echo exit=$?` | after the R8 fix: `0 violations across <N> TS files` expected; any finding is checked by hand and each confirmed violation becomes a bug file |
| — | Linux-only | `scripts/verify-battery.sh`, `run-crewdesk-tests.sh` (also forbidden by R10.AC1), `audit-500-hunt.sh`, `backup-test.mjs`, `backup-app-staleness-test.mjs`, `db-settings-guard-test.mjs`, `mysql-baseline-test.mjs`, `mysql-correctness-test.mjs`, `startup-guard-test.mjs`, `ws-prod-path-test.mjs`, `ws-reconnect-test.mjs` | **NOT RUN ON WINDOWS** (B11, not blocking) |

REQ-001 suites, not in the DoD (Q16), run in phase 7 and again in phase 9 if their area changed:

| Suite | Command | Expected |
|---|---|---|
| Wiki (R6) | `node scripts/verify-wiki.mjs` | `PASS=64 FAIL=0`, `RESULT: ALL WIKI API CHECKS GREEN`, exit 0; RES-1 = 0 |
| Permission matrix (R7) | `node scripts/verify-permission-matrix.mjs` | `PASS=193 FAIL=0`, `RESULT: 193 passed, 0 failed`, exit 0; RES-2 = 0 |
| UI gates (Q7) | `node scripts/verify-ui-gates.mjs` | `PASS=159 FAIL=0`, exit 0 |
| Audit self-test (R8) | `node scripts/audit-standards.mjs --self-test` | `PASS=12 FAIL=0`, exit 0 |
| Forced failure / recovery | A9 | as listed |
| Residue | A7 | as listed |

Every DoD run of items 4–6 re-creates R9 groups C, D, E/E2, so R9 runs after the last of them (R9.AC10, S7).

## Data setup and cleanup

- **Tester (manual):** setup is read-only (S0-4: no report on 2026-10-01 for product, qa2, viewer). Writes and their removal: M4. Cleanup by the tester: cookie jars, downloads and the Chrome profile in the scratchpad are deleted at S6-5; DB rows are removed only by R9 (group I), never by the tester.
- **sdet:**
  - **R5, R11.AC4, verify-ui-gates:** no data. Side rows: refresh tokens and LOGIN activity of demo logins (accepted, as R9.AC9). verify-ui-gates deletes its own Chrome profile under `os.tmpdir()`; it kills only its spawned pid tree.
  - **R6 / R7 fixtures:** created by raw SQL `INSERT` (`04-design.md` 2.3: `UTC_TIMESTAMP(3)`, `notify_email=0`, `notify_telegram=0`, in-memory passwords) after the guard, lock and precondition. Removed in `finally` and on SIGINT in the FK order of 2.3, by fixture ids and SQL-collected entity ids (never by title alone). Demo recipients' notifications are removed by `entity_type`/`entity_id` (Q14, Q19). The manifest file under `os.tmpdir()\tcms-verify\` holds ids only and is deleted after a green residue check.
  - **Group J patterns (R9 inventory):** `wiki-%-%@tcms.test` (R6: `wiki-{vp,mgr,prod,qa,dev,viewer}-<stamp>`), `permmatrix-%-%@tcms.test` (R7: `permmatrix-{vp,mgr,prod,dev,qa,viewer}-<stamp>` and `permmatrix-signup-<stamp>`). The R9 script only lists them; recovery is the suite's `--cleanup-stamp=<n>`.
  - **Permission matrix:** the suites touch only their listed cells (R6: developer/create_wiki_doc, developer/delete_wiki_doc; R7: viewer/create_bug, viewer/create_test_case, developer/perform_review), through `PUT /api/permissions` in-run and a fixture-VP-scoped SQL `DELETE` in cleanup. W-SD writes only the cells in A11 and restores each at once. End state every time: `role_permissions` has 0 rows and GET shows 126 default.
  - **DoD side effects:** items 4–6 add R9 groups C, D, E/E2 each run (B16); counted in the R9 dry run, not cleaned by the suites.
  - **Evidence files** (no tokens, cookies or passwords): `evidence/r8-audit-*.txt`, `evidence/suite-*.txt`, `evidence/dod-*.txt`.

---

```
STATUS: Phase 5 Test plan (manual part) — done
FILES WRITTEN: docs/requirements/REQ-001-qa-check-fixes/05-test-plan.md (new; manual section, M0–M6; sdet sections left as placeholders)
RESULTS: PASS 0 / FAIL 0 / BLOCKED 0 (no testing in phase 5)
BUGS FILED: none
NOT VERIFIED: qa2 login (checked first at S0-2); Chrome installed; whether any seed case has test_case activity (D-CASE, S0-6; else R3.AC6 BLOCKED); qa1 group B report for 2026-10-15 exists (MT-R1-06a fallback to 06b); other active view_all_task_reports holders (notification recipients); whether the upsert writes an activity row; UI max-length behaviour of the description field
NEXT AGENT: sdet — write the Automated, Regression and sdet data sections of 05-test-plan.md (exact counts R6.AC1/R7.AC9/R11.AC4, R7 fixture email pattern for group J, P5 positive control)
```

```
STATUS: Phase 5 Test plan (automated part) — done
FILES WRITTEN: docs/requirements/REQ-001-qa-check-fixes/05-test-plan.md (Automated, Regression and sdet Data sections only); evidence/r8-audit-baseline.txt, evidence/r8-audit-baseline.meta.txt
PINNED COUNTS: verify-review-matrix 36; verify-wiki 64 (base 48, not 47); verify-permission-matrix 193 (from 165); verify-permissions 33 (from 31); verify-ui-gates 159; audit --self-test 12 (was 9, phase 6 added 3 samples); fixed audit 0 violations across 193 files on HEAD 6a8e75f
NOT VERIFIED: Chrome path at runtime; Prisma loading DATABASE_URL in plain node (guard fails closed); whether the worktree build needs .env; verify-import / verify-notifications current counts (last known 33 / 29); W-SD needs an announced window
NEXT AGENT: sdet (phase 6) — fix audit-standards.mjs:89 + --self-test FIRST, before any src/ edit, and capture r8-audit-after on the same tree
```
