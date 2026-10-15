# REQ-001 Kickoff — QA-check fixes (7 bugs + B12 + QACHECK test-data cleanup)

Date: 2026-10-15 · Facilitator: manager

## Owner's request (verbatim)
> Fix all 7 issues in docs/qa/QA-CHECK-2026-10-15.md, plus backlog B12 (audit-standards.mjs Windows path bug), and clean up the QACHECK test data left in tcms_test. The app is already running on http://localhost:3000 in another window, so do not start or stop it.

## Goal
1. The 7 bugs in `docs/qa/QA-CHECK-2026-10-15.md:128-156` are fixed (UI hides what a role
   cannot use and stops firing requests it knows will 403; docs match the repo; the three
   verify scripts run correctly on MySQL/Windows against the default matrix and leave no
   residue).
2. `node scripts/audit-standards.mjs` reports real findings on Windows instead of one
   false "not kebab-case" per file (B12).
3. The QA-check test data in `tcms_test` is removed **exactly as the owner approves** (scope
   and method are open owner decisions below; nothing is deleted before that).
4. `agent.md` §3 DoD passes, with item 3 (`npm run build`) handled per the owner's decision
   on the running-server constraint.

Note: WORKFLOW.md:98-99 puts S3/S4 bugs at "owner decides / backlog". The owner has
explicitly asked for all 7 in this request, so all 7 are in scope.

## In scope
| # | Item | QA severity | Current-code status (re-verified this run) |
|---|---|---|---|
| 1 | Viewer sees work-log editor on /tasks | S3 | **HOLDS.** `src/components/views/tasks.tsx:182` `isReadOnly = canViewAllReports && effectiveUserId !== user?.userId`; no `create_task_report` check anywhere in the file (grep: only `view_all_task_reports` at :102). |
| 2 | Dashboard buttons not permission-gated | S4 | **HOLDS.** Header "New Test Case" `dashboard-v2.tsx:280-285` and "Report Bug" `:286-292` ungated ("Reports" is already gated at `:293`). Quick Actions `:682-687` all ungated: "New Test Case", "Report Bug", "Reviews", "Reports" need gates; "Tasks" (:685) and "Modules" (:686) are any-user routes. |
| 3 | Needless 403 calls | S4 | **HOLDS.** `test-case-detail.tsx:69-73` activity query `enabled: !!id` only. `integrations.tsx:68`, `:69-72`, `:73-77` (crewdesk config, links, email-check) run before the gate at `:216`; `:67` (modules tree) is an any-user call and is fine. `activity-log.tsx:88-92` runs before the gate at `:97`; `:69-73` (users options) is any-user and fine. |
| 4 | Doc drift | S4 | **PARTLY RESOLVED** since the QA run (QA ran at 2480b80; commits f46cbcc, f88f07c, 6a8e75f came after). (a) Battery 63 vs 67: `agent.md` §3 (`agent.md:196-214`) and `CODEBASE-MAP.md` §10 (`:209-225`) no longer carry a battery count, so this drift is gone; the only "63" left is `docs/README.md:75` describing `docs/migration/03-verification.md:45` (63/63 at migration time), while the latest worklog runs show 67 (`worklog.md:1547`, `:1566`). (b) `auth-screen.tsx`: **HOLDS.** `CODEBASE-MAP.md:114` says views are `src/components/views/*` and `:120` lists `auth-screen.tsx`, but the file is `src/components/auth-screen.tsx` (glob). (c) `.zscripts/`: **RESOLVED.** `agent.md:250-253` and `CODEBASE-MAP.md:37` now say it is git-ignored and exists only on the pipeline host; glob confirms it is absent here. |
| 5 | `verify-review-matrix.mjs` out of date | S3 | **HOLDS.** `scripts/verify-review-matrix.mjs:52` and `:74` expect `perform OR submit`; the services gate on `perform_review` only (`src/app/api/reviews/reviews.service.ts:58-62`, `src/app/api/module-reviews/module-reviews.service.ts:105`). UI agrees with the services (`sidebar.tsx:49,76`, `reviews.tsx:84`). The stale comment at `src/lib/permissions.ts:144-145` ("Reviews = perform_review OR submit_review") goes to the backlog (B14). |
| 6 | `verify-wiki.mjs` uses PostgreSQL `ON CONFLICT` | S3 | **HOLDS.** `scripts/verify-wiki.mjs:231-233` uses `ON CONFLICT ... DO UPDATE` and `NOW()` (D7 requires `UTC_TIMESTAMP(3)`). Cleanup is at `:251-271` with no try/finally, so a throw at :231 leaves the 6 `wiki-*-<stamp>@tcms.test` users (`:21-26`, created with an ORM call at `:30`). Also, `:245` deletes developer `create_wiki_doc`/`delete_wiki_doc` override rows without restoring earlier values. |
| 7 | `verify-permission-matrix.mjs` needs missing data and leaves an override | S3 | **HOLDS.** It needs `qamarathon.*@tcms.dev` users (`:45-49`) and a "QA Marathon Alpha" module (`:69-70`, which throws if missing). `:284` re-grants developer `perform_review`, and `:309` **asserts** the override remains. Its expectations assume the seed overrides dev/qa `perform_review` (`:5-6`), but the defaults give developer no `perform_review` (`src/lib/permissions.ts:56`). It also depends on self-signup (`:40`), and its fixtures (cases, bugs, wiki docs, the signup viewer) are never cleaned up (no cleanup before `:311-312`). |
| B12 | `audit-standards.mjs` Windows path split | Medium (backlog) | **HOLDS.** `scripts/audit-standards.mjs:89` `file.split('/').pop()`. The paths come from `path.join` (`:18`), which uses `\` on Windows, so the basename is the full path. |
| C | QACHECK test-data cleanup in `tcms_test` | — | Scope and method are **owner decisions** (see "Data safety" below). |

## Out of scope (backlog)
- B8 `self-*@tcms.test` accounts. This is out unless the owner adds it (open question Q4).
- Making `verify-import.mjs` / `verify-permissions.mjs` clean up after themselves. Today they
  leave rows on every run (`verify-import.mjs:83` prefix "Imported: <stamp>",
  `verify-permissions.mjs:56` "Perm-verify case …"; grep finds no delete or cleanup in either).
  This goes to backlog B16.
- The stale `canAny` comment at `src/lib/permissions.ts:144-145` (B14).
- Hard-coded test credentials in verify scripts (B13).
- The dashboard "New Test Case" action only navigates to the list and does not open a create
  dialog (`dashboard-v2.tsx:281`, `:682`). This is a behaviour change (B15).
- Porting the Linux-only suites (B11). Changing `TCMS_ALLOW_SIGNUP` in `.env` (secrets rule).

## Affected areas (verified — only paths actually opened)
| Area | Path | Why |
|---|---|---|
| Tasks view | `src/components/views/tasks.tsx:100-182` | Bug 1: `isReadOnly` |
| Dashboard | `src/components/views/dashboard-v2.tsx:128-142, 279-302, 676-689` | Bug 2: gates (`can` already in scope at :128) |
| Test-case detail | `src/components/views/test-case-detail.tsx:69-73` | Bug 3 |
| Integrations | `src/components/views/integrations.tsx:67-77, 215-224` | Bug 3 |
| Activity log | `src/components/views/activity-log.tsx:69-99` | Bug 3 |
| Sidebar / reviews (reference only) | `src/components/layout/sidebar.tsx:49,53,76`; `src/components/views/reviews.tsx:84` | Gate keys to reuse in bug 2 |
| Permission defaults (reference) | `src/lib/permissions.ts:40-59, 144-148` | Expected gates; stale comment |
| Review services (reference) | `src/app/api/reviews/reviews.service.ts:48-62`; `src/app/api/module-reviews/module-reviews.service.ts:49-57, 99-105` | Bug 5 ground truth |
| Review-matrix suite | `scripts/verify-review-matrix.mjs:50-80` | Bug 5 |
| Wiki suite | `scripts/verify-wiki.mjs:12-33, 227-275` | Bug 6 |
| Permission-matrix suite | `scripts/verify-permission-matrix.mjs:1-75, 194-312` | Bug 7 |
| Standards audit | `scripts/audit-standards.mjs:15-24, 87-91` | B12 |
| DoD contract | `agent.md:196-214` (item 7 at `:208-209` names QA bug 5) | Wording must change once bug 5 is fixed |
| Docs | `CODEBASE-MAP.md:37, 114, 120, 209-214`; `docs/README.md:75`; `docs/migration/03-verification.md:45` | Bug 4 |
| Delete semantics (cleanup) | `src/app/api/test-cases/test-cases.repository.ts:191`; `src/app/api/modules/modules.repository.ts:146-147` | Hard deletes (see contradiction below) |
| Other suites (cleanup inventory) | `scripts/verify-import.mjs:83`; `scripts/verify-permissions.mjs:56`; `scripts/verify-notifications.mjs:191-193` | Identifying the rows they leave behind |
| Dev server | `package.json:6-8`; `scripts/dev-tcms.mjs:107`; `next.config.ts:23` | :3000 runs `next dev` (via `npm run dev`); build/serve constraint |

No API, schema or migration change is expected. The backend gates are already correct per
QA §B ("Server-side enforcement", `QA-CHECK-2026-10-15.md:67-80`).

## Document contradiction found (WORKFLOW rule 4 — reported, not resolved)
- `agent.md:138` says "Test cases → `status: 'deprecated'`" (soft delete), and `agent.md:139`
  says "module/case deletes restricted by relations".
- `CODEBASE-MAP.md:73-74` says module delete is "hard, cascades" and test-case delete is "hard".
- The code matches CODEBASE-MAP: `test-cases.repository.ts:191` `DELETE FROM test_cases`;
  `modules.repository.ts:146-147` `DELETE FROM crew_desk_links` + `DELETE FROM modules`.
- This bears directly on cleanup: "delete via API" means a **hard** delete today. The owner must
  say which document is authoritative (Q6). Fixing the agent.md wording is outside REQ-001
  unless the owner adds it.

## Data safety — QACHECK cleanup (WORKFLOW.md:82 rule 9: "Never delete data … Ask first.")
**Nothing is deleted until the owner approves the exact inventory and method in `03-review.md`.**
Candidate rows, taken from `QA-CHECK-2026-10-15.md:101-114`. None of these were verified in the
DB in this run.

| Group | Rows (per QA doc) | How identifiable | Owner decision needed |
|---|---|---|---|
| A. QACHECK fixtures | module "QACHECK module 1792076976458"; cases QACHECK tc1/tc2/tc3 + "QACHECK qa case"; 1 pending module review + 1 pending case review (assigned to product); wiki "QACHECK wiki"; bugs "QACHECK bug" (in_progress) + "QACHECK dev bug" | "QACHECK" prefix | Include? Hard delete or soft (`deprecated`)? Child rows (history, review events, bug links, notifications to product) too? |
| B. QA's task report for 2026-10-15 | 1 `task_reports` row of the **real demo QA account** | user + date | Include? It belongs to a demo user, not a fixture user |
| C. verify-import side-effects | 3 cases "Imported: <stamp> …" in seed module "Authentication - Login" | prefix (`verify-import.mjs:83`) | Include? Only today's, or every earlier run's too? |
| D. verify-permissions side-effects | "Perm-verify case <ts>", a temporary bug, a **module-review submission on a seed submodule** | prefix (`verify-permissions.mjs:56`); bug/review UNKNOWN | Include? Reverting the seed submodule's review state is a state rollback, not just a delete |
| E. verify-notifications temp user | 1 user, already soft-deleted (`is_active=false`, `verify-notifications.mjs:191-193`) | UNKNOWN email pattern | Leave soft-deleted, or hard delete (FK children)? |
| F. Side effects | refresh tokens, activity_logs, notifications from logins/actions | user/entity id | Include? Deleting activity_logs removes audit history |
| G. Permission overrides | developer `perform_review` grant was reverted; QA saw all 126 cells `default` after (`QA-CHECK:35`) | `role_permissions` | Probably nothing to do. Verify only |
| H. B8 `self-*@tcms.test` | UNKNOWN count | email pattern | In or out of REQ-001? |

Method options for the owner: (1) through the API as VP/admin. This writes audit rows and is
hard delete for cases, modules and bugs per the code above. (2) Raw SQL in a reviewed sdet
script that **defaults to dry-run**, prints the exact row list and counts, and deletes only with
an explicit flag after the owner approves the printed list. (3) Soft only: cases set to
`deprecated`, users deactivated, nothing hard-deleted.

Timing: `verify-import` and `verify-permissions` add rows on **every** DoD run (phases 6, 7
and 9 of this REQ). Recommendation: run the cleanup once, last, after the final DoD run. Then
decide whether rows created by REQ-001's own runs are in scope (Q3).

Precondition: a fresh `tcms_test` backup before any delete. The backup scripts are Linux `.sh`
(`CODEBASE-MAP.md:218`), so it is UNKNOWN how to take one on Windows (Q5).

## Risks
| Risk | Impact | Mitigation |
|---|---|---|
| App on :3000 is `next dev` (`scripts/dev-tcms.mjs:107`) and must not be started or stopped. `npm run build` (`package.json:7`) writes `.next/` while dev also uses `.next/`. Whether Next 16 isolates the two is **UNKNOWN** (not verified). | DoD item 3 may corrupt the running dev server's output or fail; restarting is forbidden | Owner decision Q1. Until then DoD item 3 is NOT VERIFIED |
| Frontend edits hot-reload into the owner's running app as soon as they are saved | A half-finished edit breaks the owner's window | Edit file by file; run tsc before saving the next file; tester checks in the browser after each bug |
| Live UI check without restarting | Only HMR/reload is available. No production-mode check | Tester uses a browser reload on :3000 per role. Production-mode behaviour stays NOT VERIFIED unless Q1 allows a build |
| No UI test framework (`CODEBASE-MAP.md:241`). DoD needs "new behaviour covered by an automated test" (`agent.md:220`) | Bugs 1–3 may have no automated coverage | Q7: sdet proposes an API-level or scripted-browser check, or the owner records a decision |
| Fixing bugs 5 and 7 changes existing assertions (`verify-review-matrix.mjs:52,74`; `verify-permission-matrix.mjs:309`). sdet must never weaken a check (`.claude/agents/sdet.md:45-47`) | Could look like weakening tests | The BRD must state the target rule (perform_review only; default matrix, no residual override) and the owner approves it |
| Running fixed `verify-wiki` / `verify-permission-matrix` writes and deletes data in tcms_test (users, overrides, docs) | Collateral loss, e.g. `verify-wiki.mjs:245` deletes override rows unconditionally | Fixed suites must capture and restore prior override state, clean up in try/finally, and touch only their own stamped fixtures. The first run is owner-approved |
| `verify-permission-matrix.mjs:40` needs `TCMS_ALLOW_SIGNUP=true` (true locally per `QA-CHECK:158`) | The suite breaks when signup is closed | BRD decides whether the suite provisions its own viewer instead |
| Nobody is allowed to edit `agent.md`, `CODEBASE-MAP.md` or `docs/README.md` (checked: `.claude/agents/*.md` "Allowed to edit") | Bug 4 and the agent.md §3 item 7 wording cannot be done by any agent | Q2 |
| `worklog.md` has no entries after `db-settings-guard-1` (`worklog.md:1554`), but commits fc9e381…6a8e75f followed (git log) | Planning context is missing from the log | Reported to owner. Not REQ-001 work |

## Open questions for the owner
- [ ] **Q1 Build vs running server.** How should DoD item 3 (`npm run build`) run while `next dev` holds :3000? Options: (a) the owner runs the build at a moment they choose; (b) build in a separate copy or worktree of the repo; (c) accept item 3 as NOT VERIFIED for this REQ. Changing `next.config.ts` `distDir` would be a config change outside scope.
- [ ] **Q2 Who edits `agent.md`, `CODEBASE-MAP.md`, `docs/README.md`?** These are needed for bug 4b (auth-screen path), the agent.md §3 item 7 wording (`agent.md:208-209` "once the suite is updated … bug 5") after bug 5 is fixed, and optionally the `docs/README.md:75` 63/67 note. No agent role is allowed to edit them. Options: the owner edits them, or the owner gives a one-time grant to a named role.
- [ ] **Q3 Cleanup scope.** Which of groups A–G above? Only rows from the 2026-10-15 QA check, or also earlier suite leftovers ("Imported:", "Perm-verify", qamarathon)? Are rows created by REQ-001's own DoD runs included?
- [ ] **Q4 B8** (`self-*@tcms.test`): in or out of REQ-001?
- [ ] **Q5 Cleanup method and safety.** API (hard delete for cases, modules and bugs), SQL script with dry-run, or soft only? Test cases: `deprecated` or hard delete? Activity logs / notifications / refresh tokens: delete or keep? Backup first: how on Windows, and by whom?
- [ ] **Q6 Contradiction.** `agent.md:138-139` (soft delete for cases, restricted module delete) vs `CODEBASE-MAP.md:73-74` and the code (hard delete). Which document is authoritative? Should the wrong one be fixed (in this REQ or in the backlog)?
- [ ] **Q7 Automated coverage for the UI bugs 1–3.** Accept a scripted check (e.g. API-level permission assertions plus a manual browser pass), or record a decision that UI gating is tester-verified only?
- [ ] **Q8 Bug 4a.** Leave the historical "63/63" in `docs/README.md:75` (accurate for the migration snapshot) or annotate it with the current 67?
- [ ] **Q9 Bug 7 target.** Port `verify-permission-matrix.mjs` to the 7 demo users and the default matrix with self-provisioned and self-cleaned fixtures, or provision the qamarathon data it expects? (Recommendation: port it. No permanent overrides.)

## Assignments
| Role | Task | Phase |
|---|---|---|
| product-owner | Write the BRD: ACs per bug 1–7, B12 and the cleanup (cleanup ACs are written against the owner's answers to Q3–Q6). Bug 2 gate map: New Test Case → `create_test_case`, Report Bug → `create_bug`, Reviews → `perform_review`, Reports → `view_all_task_reports` (to be confirmed in the BRD) | 2 |
| all six | Review the BRD (APPROVE or CHANGES) | 3 |
| owner | Answer Q1–Q9; write APPROVED in `03-review.md` | 4 |
| developer-frontend | Bugs 1, 2, 3 in `tasks.tsx`, `dashboard-v2.tsx`, `test-case-detail.tsx`, `integrations.tsx`, `activity-log.tsx` (`useAuthStore.can`, `enabled:` gates; no API change) | 5–6 |
| developer-backend | Confirm in the design that no backend change is needed (task-report and activity-log gates stay as they are). Review the frontend design | 5 |
| sdet | Bug 5 (`verify-review-matrix.mjs`), bug 6 (`verify-wiki.mjs`: MySQL upsert, `UTC_TIMESTAMP(3)`, try/finally, restore prior overrides), bug 7 (`verify-permission-matrix.mjs` per Q9), B12 (`audit-standards.mjs:89`, use `path.basename`), the cleanup script with dry-run default if Q5 picks SQL, and automated coverage per Q7 | 5–7 |
| tester | Per-role browser pass on the running :3000 (no restart) for bugs 1–3. Check the bug 4 doc edits. Verify the cleanup dry-run list against the QA doc §C, then verify it is gone after the approved run | 5, 7 |
| owner / granted role | Bug 4 doc edits and `agent.md` §3 item 7 wording (per Q2) | 6 |
| manager | Backlog B13–B16 added. Record owner decisions in `decisions.md` after approval | 1, 3 |

## STATUS
```
STATUS: Phase 1 Kickoff — needs owner approval
FILES WRITTEN: docs/requirements/REQ-001-qa-check-fixes/01-kickoff.md, docs/process/backlog.md (B13–B16)
OPEN QUESTIONS FOR OWNER: Q1–Q9 above (build vs running dev server; who edits agent.md/CODEBASE-MAP/docs README; cleanup scope; B8; cleanup method/backup; agent.md vs CODEBASE-MAP delete-semantics contradiction; automated coverage for UI bugs; 63/67 note; bug 7 target)
NOT VERIFIED: actual rows present in tcms_test (no DB access this run); whether Next 16 `next build` conflicts with the running `next dev` .next folder; the verify-notifications temp-user email pattern and verify-permissions bug/module-review identifiers; existence/count of self-*@tcms.test (B8) and qamarathon accounts; which real violations audit-standards reports once B12 is fixed; QA-doc runtime results (taken from the QA doc, not re-run)
NEXT AGENT: product-owner — write docs/requirements/REQ-001-qa-check-fixes/02-brd.md from this kickoff: acceptance criteria for bugs 1–7, B12 and the cleanup (cleanup criteria marked BLOCKED until the owner answers Q3–Q6), with a route + permission line for /tasks, /dashboard, /test-cases/[id], /integrations and /activity-log
```
