# TCMS documentation

Everything about the TCMS (Test Case Management System) as it is today: MySQL 8.4,
six roles with a runtime permission matrix, Windows local setup, Linux + nginx production.

**Start here:** [`CODING-STANDARDS.md`](./CODING-STANDARDS.md) (the one rules file) →
[`architecture/HLD.md`](./architecture/HLD.md) (big picture) →
[`CODEBASE-MAP.md`](./CODEBASE-MAP.md) (where the code lives).

## Top level

| File | What it is |
|---|---|
| [`CODING-STANDARDS.md`](./CODING-STANDARDS.md) | The owner's standards word for word + the concrete TCMS rules, Definition of Done, workflow, environment |
| [`CODEBASE-MAP.md`](./CODEBASE-MAP.md) | Compact map of the repository: folders, request pipeline, key files, scripts, tech debt |
| [`CHANGELOG.md`](./CHANGELOG.md) | User-visible and architectural changes, newest first |
| [`worklog.md`](./worklog.md) | Append-only engineering log, one entry per task |

## architecture/ — how the system is built

| File | What it covers |
|---|---|
| [`HLD.md`](./architecture/HLD.md) | Components, request flow, boot sequence, deployment topology, fallbacks, scaling path, load-test results |
| [`LLD.md`](./architecture/LLD.md) | The four layers, design patterns (singleton, repository, cache-aside, optimistic lock, …), caching, logging, page → permission map |
| [`database.md`](./architecture/database.md) | All 17 tables: columns, relations, cascades, JSON columns, deletion rules |
| [`api-reference.md`](./architecture/api-reference.md) | Every endpoint: parameters, rules, side effects, responses, quirks |
| [`auth-and-permissions.md`](./architecture/auth-and-permissions.md) | Cookie sessions, refresh, CSRF, roles, the 126-cell matrix, endpoint protection map |
| [`frontend.md`](./architecture/frontend.md) | Zustand stores, React Query keys, fetch layer, error/toast system, shared components |
| [`realtime-and-notifications.md`](./architecture/realtime-and-notifications.md) | Notification delivery: DB row, WebSocket mini-service, email / Telegram |
| [`crewdesk-integration.md`](./architecture/crewdesk-integration.md) | Crew Desk comment posting, auth modes, the 1355 test-ticket rule, mock/test/live |

## guides/ — how each page and flow works

| File | What it covers |
|---|---|
| [`login-and-dashboard.md`](./guides/login-and-dashboard.md) | Sign-in / register and the QA Command Center dashboard |
| [`modules-and-test-cases.md`](./guides/modules-and-test-cases.md) | Module tree, test-case list and detail, versioning, deep-link filters |
| [`reviews-workflow.md`](./guides/reviews-workflow.md) | Review state machine, queues, verdicts, module bulk review |
| [`bugs-tasks-and-reports.md`](./guides/bugs-tasks-and-reports.md) | Bug Kanban, daily work log, team reports |
| [`activity-users-notifications-profile.md`](./guides/activity-users-notifications-profile.md) | Activity log, notifications, user management, profile |
| [`end-to-end-flows.md`](./guides/end-to-end-flows.md) | Click-to-database stories and the cross-flow invariants |
| [`import-test-cases.md`](./guides/import-test-cases.md) | CSV/XLSX bulk import |

## deploy/ — running it

| File | What it covers |
|---|---|
| [`local-setup-windows.md`](./deploy/local-setup-windows.md) | Local setup on Windows: MySQL 8.4 on 127.0.0.1:5500, `.env`, migrations, seed, `npm run dev` |
| [`DEPLOYMENT.md`](./deploy/DEPLOYMENT.md) | Deployment overview (local + company IT production) and env reference |
| [`PRODUCTION-CHECKLIST.md`](./deploy/PRODUCTION-CHECKLIST.md) | Production install on one page: env keys, systemd units, backups cron, go-live steps |
| [`it-request-mysql.md`](./deploy/it-request-mysql.md) | What IT must provide: MySQL settings, users + grants, TLS, app server, nginx, firewall |
| [`reverse-proxy-websocket.md`](./deploy/reverse-proxy-websocket.md) | Reverse-proxy recipes (nginx / Apache / IIS) for the realtime socket service |
| [`operations-runbook.md`](./deploy/operations-runbook.md) | Backup + restore drills, rollback, error logging, tests, first VP, ops quick reference |

## process/ — how the team works

| File | What it is |
|---|---|
| [`WORKFLOW.md`](./process/WORKFLOW.md) | Fast lane by default; the full 6-agent process only on `/new-requirement` |
| [`HOW-TO-INSTALL.md`](./process/HOW-TO-INSTALL.md) | How the agent team is installed and started |
| [`decisions.md`](./process/decisions.md) | Owner decisions (D1–D13) that override older text |
| [`backlog.md`](./process/backlog.md) | Open work not yet in a requirement |
| [`lessons/`](./process/lessons/README.md) | Lessons per role |
| [`templates/`](./process/templates/) | Kickoff, BRD, review, design, test plan, bug, release, retro |

Requirement folders are created under `process/requirements/REQ-<NNN>-<slug>/` by `/new-requirement`.

## qa/

| File | What it is |
|---|---|
| [`DEEP-TEST-2026-10-16.md`](./qa/DEEP-TEST-2026-10-16.md) | Latest deep test: role × page × API checks and the bugs fixed after it |
