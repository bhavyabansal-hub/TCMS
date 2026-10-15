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
| 06 | [Pages: Login & Dashboard](./06-page-login-and-dashboard.md) | AuthScreen (login/register) and the dashboard (live view: `dashboard-v2.tsx`; the classic view is archived) |
| 07 | [Pages: Modules & Test Cases](./07-page-modules-and-test-cases.md) | Module tree, test-case table + create dialog, case detail with versioning |
| 08 | [Pages: Review Workflow](./08-page-reviews-workflow.md) | The review state machine, queue views, verdict dialogs, module bulk review + auto-completion |
| 09 | [Pages: Bugs, Tasks, Reports](./09-page-bugs-tasks-and-reports.md) | Kanban drag & drop, daily work log editor, team analytics |
| 10 | [Pages: Activity, Users, Notifications, Profile](./10-page-activity-users-notifications-profile.md) | Audit trail UI, notification center, admin console, self-service settings |
| 11 | [End-to-End Flows](./11-end-to-end-flows.md) | 8 complete click-to-database stories + the 7 cross-flow invariants |
| 12 | [Realtime & Deployment](./12-realtime-and-deployment.md) | WebSocket mini-service protocol, ops quick reference (§3–§4 topology sections are historical, PostgreSQL era) |
| 13 | [File Index](./13-file-index.md) | Every file in the project explained in one or two lines |
| 14 | [Import Test Cases (CSV)](./14-import-test-cases.md) | The bulk-import feature: user flow, CSV format contract, API endpoints, per-layer code path, row-level error reporting |
| 15 | [Coding Standards & LLD](./15-standards-and-lld.md) | The enforced layering contract (controller→validation→service→repository), raw-SQL rules, LLD principle map, caching/load-management, logging, page route & permission map |
| 16 | [Single-Instance & Scaling](./16-single-instance-and-scaling.md) | Why one instance is the honest baseline, what breaks at scale, the measured load-test envelope, and the scale-up levers |
| 17 | [Operations Runbook](./17-operations-runbook.md) | Daily ops: boot/health, mysqldump backup + restore drills, log triage, incident first-aid, TEST-schema certification for IT |
| 18 | [Crew Desk Integration](./18-crewdesk-integration.md) | Shared-service-account comment posting, auth modes, 1355-designated-ticket rule, guard probes, mock/test/live modes |

## Getting started & deployment

| File | What it is |
|---|---|
| [`LOCAL-SETUP-WINDOWS.md`](./LOCAL-SETUP-WINDOWS.md) | Running TCMS locally on Windows: MySQL 8.4 on 127.0.0.1:5500, `.env`, `allowScripts`, migrations, seed, `npm run dev` |
| [`../DEPLOYMENT.md`](../DEPLOYMENT.md) | Current MySQL 8.4 deployment guide (sandbox + company IT cutover) |
| [`deploy/reverse-proxy-websocket.md`](./deploy/reverse-proxy-websocket.md) | Reverse-proxy recipes (nginx / Apache / IIS) + firewall rules for the realtime socket service |

## Migration dossier (PostgreSQL → MySQL 8.4, 2026-10-14)

| File | What it covers |
|---|---|
| [`migration/01-pg-audit.md`](./migration/01-pg-audit.md) | The PG-specific SQL inventory that had to change (RETURNING, ILIKE, ON CONFLICT, casts, JSONB, intervals) |
| [`migration/02-schema-conversion.md`](./migration/02-schema-conversion.md) | Prisma schema swap, explicit native types, collation fixups, JSON defaults |
| [`migration/03-verification.md`](./migration/03-verification.md) | Every verification number: battery 63/63, import 33/33, 250-row probe, 200-VU load test, backup/restore drill |
| [`migration/04-cutover-rollback.md`](./migration/04-cutover-rollback.md) | The production cutover plan + rollback plan (PG kept read-only as insurance) |

## Project log

| File | What it is |
|---|---|
| [`CHANGELOG.md`](./CHANGELOG.md) | Reverse-chronological summary of every user-visible and architectural change (start here to catch up) |
| `../worklog.md` | Append-only task-by-task engineering log (Task IDs, verification results) |

## Other material in this folder

| File | What it is |
|---|---|
| [`TCMS-ARCHITECTURE-GUIDE.pdf`](./TCMS-ARCHITECTURE-GUIDE.pdf) | The full guide compiled as a printable PDF (offline reading) |
| [`REFACTORING-REPORT.md`](./REFACTORING-REPORT.md) | Full 2026-09 restructure report: 4-layer API + raw-SQL migration, table/PK rename mapping, verification results |
| [`CODE-QUALITY-ROADMAP.md`](./CODE-QUALITY-ROADMAP.md) | Engineering improvement notes from development |
| [`REFACTOR-CHARTER.md`](./REFACTOR-CHARTER.md) | The charter that drove the 4-layer restructure (goals, rules, guardrails) |
| [`qa/TCMS-MASTER-QA-PROMPT.md`](./qa/TCMS-MASTER-QA-PROMPT.md) | Full-system deep-verification QA prompt (every page, role and endpoint) |
| [`qa/TCMS-TEST-REPORT-2026-10-09.md`](./qa/TCMS-TEST-REPORT-2026-10-09.md) | 2026-10-09 QA marathon report: 210 sheet-imported cases, five-role verdicts, DB deep checks |

## Archived (outside docs/)

| File | What it is |
|---|---|
| [`../archive/postgres/docs/DEPLOYMENT-GUIDE.md`](../archive/postgres/docs/DEPLOYMENT-GUIDE.md) | **HISTORICAL** — the old Vercel + Neon/Supabase (PostgreSQL) deployment path; do not follow |
| [`../archive/README.md`](../archive/README.md) | What was moved to `archive/` and why (PG-era scripts in `archive/postgres/` are the rollback plan until go-live) |

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
