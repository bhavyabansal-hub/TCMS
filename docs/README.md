# TCMS Documentation — Architecture & Complete Working Guide

Welcome! This folder is the **study hub** of the TCMS (Test Case Management System)
project: every layer, every endpoint, every page and every file documented. Start with
`01` and read in order for a full understanding, or jump straight to what you need.

## Study path (docs 01–18)

| # | Document | What it covers |
|---|---|---|
| 01 | [Overview & Architecture](./01-overview-and-architecture.md) | What TCMS is, tech stack, system diagram, request lifecycle, boot sequence, directory map, env vars, conventions |
| 02 | [Database Schema](./02-database-schema.md) | All 17 tables, every column, relations & cascade rules, JSON column design, status lifecycles, deletion semantics |
| 03 | [Authentication & Permissions](./03-authentication-and-permissions.md) | JWT session mechanics, token refresh dance, roles, full permission matrix, endpoint protection map, security notes |
| 04 | [API Reference](./04-api-reference.md) | Every endpoint: params, validation, business rules, side effects (audit + notifications), response shapes, quirks |
| 05 | [Frontend Architecture](./05-frontend-architecture.md) | Zustand stores, React Query key inventory, the fetch layer, error/toast system, shared components, theming |
| 06 | [Pages: Login & Dashboard](./06-page-login-and-dashboard.md) | AuthScreen (login/register) and the QA Command Center dashboard (`dashboard-v2.tsx`) |
| 07 | [Pages: Modules & Test Cases](./07-page-modules-and-test-cases.md) | Module tree, test-case table + create dialog, case detail with versioning |
| 08 | [Pages: Review Workflow](./08-page-reviews-workflow.md) | The review state machine, queue views, verdict dialogs, module bulk review + auto-completion |
| 09 | [Pages: Bugs, Tasks, Reports](./09-page-bugs-tasks-and-reports.md) | Kanban drag & drop, daily work log editor, team analytics |
| 10 | [Pages: Activity, Users, Notifications, Profile](./10-page-activity-users-notifications-profile.md) | Audit trail UI, notification center, user management (role changes VP only), self-service settings |
| 11 | [End-to-End Flows](./11-end-to-end-flows.md) | 8 complete click-to-database stories + the 7 cross-flow invariants |
| 12 | [Realtime & Deployment](./12-realtime-and-deployment.md) | WebSocket mini-service protocol, production topology (nginx + one app + MySQL 8.4), local Windows topology, ops quick reference |
| 13 | [File Index](./13-file-index.md) | Every file in the project explained in one or two lines |
| 14 | [Import Test Cases (CSV)](./14-import-test-cases.md) | The bulk-import feature: user flow, CSV format contract, API endpoints, per-layer code path, row-level error reporting |
| 15 | [Coding Standards & LLD](./15-standards-and-lld.md) | The enforced layering contract (controller→validation→service→repository), raw-SQL rules, LLD principle map, caching/load-management, logging, page route & permission map |
| 16 | [Single-Instance & Scaling](./16-single-instance-and-scaling.md) | Why one instance is the honest baseline, what breaks at scale, the measured load-test envelope, and the scale-up levers |
| 17 | [Operations Runbook](./17-operations-runbook.md) | Daily ops: boot/health, mysqldump backup + restore drills, log triage, incident first-aid, TEST-schema certification for IT, first VP (`create-first-vp.mjs`, §6) |
| 18 | [Crew Desk Integration](./18-crewdesk-integration.md) | Shared-service-account comment posting, auth modes, 1355-designated-ticket rule, guard probes, mock/test/live modes |

## Getting started & deployment

| File | What it is |
|---|---|
| [`LOCAL-SETUP-WINDOWS.md`](./LOCAL-SETUP-WINDOWS.md) | Running TCMS locally on Windows: MySQL 8.4 on 127.0.0.1:5500, `.env`, `allowScripts`, migrations, seed, `npm run dev` |
| [`../DEPLOYMENT.md`](../DEPLOYMENT.md) | MySQL 8.4 deployment overview (local Windows + company IT production) |
| [`deploy/PRODUCTION-CHECKLIST.md`](./deploy/PRODUCTION-CHECKLIST.md) | **Production install, one page:** every `.env` key, systemd units for both processes, backups cron, go-live steps |
| [`deploy/it-request-mysql.md`](./deploy/it-request-mysql.md) | What IT must provide: MySQL 8.4 settings, 3 users + exact grants, TLS, app server, nginx (WebSocket), firewall, single instance, backups |
| [`deploy/reverse-proxy-websocket.md`](./deploy/reverse-proxy-websocket.md) | Reverse-proxy recipes (nginx / Apache / IIS) + firewall rules for the realtime socket service |

## Team process (6-agent team)

The roles are defined in `../.claude/agents/` (manager, product-owner, developer-backend,
developer-frontend, tester, sdet) and started with the slash commands in `../.claude/commands/` (small jobs: `/quick-fix`, see `process/WORKFLOW.md` §3a).
Project rules and the Definition of Done live only in [`../agent.md`](../agent.md).

| File | What it is |
|---|---|
| [`process/HOW-TO-INSTALL.md`](./process/HOW-TO-INSTALL.md) | How the agent team was installed and how to start a requirement, fix a bug or run a retro |
| [`process/WORKFLOW.md`](./process/WORKFLOW.md) | The binding team workflow: requirement folder, phases 0–11 with gates, ground rules, bug severity, stop conditions |
| [`process/coding-standards.md`](./process/coding-standards.md) | The owner's coding standards in their original wording; points to `agent.md` for the concrete rules |
| [`process/decisions.md`](./process/decisions.md) | Owner-approved decision log (D1–D13) that overrides older docs |
| [`process/backlog.md`](./process/backlog.md) | Open work not yet in an approved requirement (B1–B29) |
| [`process/lessons/README.md`](./process/lessons/README.md) | Format and rules for each role's lessons file |
| [`process/lessons/manager.md`](./process/lessons/manager.md) | Lessons for the manager |
| [`process/lessons/product-owner.md`](./process/lessons/product-owner.md) | Lessons for the product owner |
| [`process/lessons/developer-backend.md`](./process/lessons/developer-backend.md) | Lessons for the backend developer |
| [`process/lessons/developer-frontend.md`](./process/lessons/developer-frontend.md) | Lessons for the frontend developer |
| [`process/lessons/tester.md`](./process/lessons/tester.md) | Lessons for the tester |
| [`process/lessons/sdet.md`](./process/lessons/sdet.md) | Lessons for the SDET |
| [`process/templates/kickoff.md`](./process/templates/kickoff.md) | Template: kickoff (phase 1) |
| [`process/templates/brd.md`](./process/templates/brd.md) | Template: BRD (phase 2) |
| [`process/templates/review.md`](./process/templates/review.md) | Template: BRD review meeting (phase 3) |
| [`process/templates/design.md`](./process/templates/design.md) | Template: low-level design (phase 5) |
| [`process/templates/test-plan.md`](./process/templates/test-plan.md) | Template: test plan (phase 5) |
| [`process/templates/bug.md`](./process/templates/bug.md) | Template: bug report (phases 7–9) |
| [`process/templates/release.md`](./process/templates/release.md) | Template: release review (phase 10) |
| [`process/templates/retro.md`](./process/templates/retro.md) | Template: retrospective (phase 11) |

Requirement folders are created under `requirements/REQ-<NNN>-<slug>/` by `/new-requirement`.

## Project log

| File | What it is |
|---|---|
| [`CHANGELOG.md`](./CHANGELOG.md) | Reverse-chronological summary of every user-visible and architectural change (start here to catch up) |
| `../worklog.md` | Append-only task-by-task engineering log (Task IDs, verification results) |

## QA and requirements

| File | What it is |
|---|---|
| [`qa/DEEP-TEST-2026-10-16.md`](./qa/DEEP-TEST-2026-10-16.md) | Latest deep test (2026-10-16): role × page × API checks and the bugs fixed after it |
| [`requirements/REQ-001-qa-check-fixes/`](./requirements/REQ-001-qa-check-fixes/) | REQ-001 record: kickoff, BRD, review, design, test plan, dev report |

## Where do the coding standards live?

The **canonical, mandatory coding standards** are in [`../agent.md`](../agent.md) —
every new line of code in this repository must follow them (layered
Controller → Validation → Service → Repository, raw SQL only, standard response
helpers, naming conventions, verification battery). Any AI or human contributor should
read `agent.md` **before** writing code, and `CLAUDE.md` at the project root is a
pointer to it. [`15-standards-and-lld.md`](./15-standards-and-lld.md) is the verified,
codebase-accurate map of how those standards are applied today.

## Reader's tips

- If you read only three files, make them `01` (the map), `11` (the flows — how
  everything connects) and `04` (the precise behavior of the backend).
- Studying one specific area? Backend → `02`+`04`; permissions → `03`; a single
  screen → `06`–`10`; "how does X actually happen end to end" → `11`.
