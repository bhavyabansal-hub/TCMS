# docs/CODEBASE-MAP.md — fast orientation for TCMS

> Compact map of the repository, written 2026-10-15 from a full read of `docs/CODING-STANDARDS.md`,
> `docs/`, `docs/worklog.md` and the source. **Read this before exploring; update it when
> structure changes.** Binding rules live in `docs/CODING-STANDARDS.md` — this file only points.

## 1. What it is

Test Case Management System. Next.js 16 App Router · React 19 · TypeScript 5 ·
Tailwind v4 + shadcn/ui · Zustand 5 · TanStack React Query 5 · Prisma 6 (client only,
**raw SQL everywhere**) · **MySQL 8.4** (utf8mb4_unicode_ci, strict, UTC, native JSON) ·
JWT in httpOnly cookies · zod 4 · socket.io mini-service for realtime.
MySQL is the only database (decision D1). Production is a fresh start: empty MySQL +
`scripts/create-first-vp.mjs` (decision D2).
Production go-live is **pending IT answers** ([`docs/deploy/it-request-mysql.md`](./deploy/it-request-mysql.md);
steps in [`docs/deploy/PRODUCTION-CHECKLIST.md`](./deploy/PRODUCTION-CHECKLIST.md)).

## 2. Top-level layout

```
README.md           project overview + quick start
CLAUDE.md           WORKING METHOD + pointer to docs/CODING-STANDARDS.md (READ FIRST)
.claude/            agents/ (6 team roles), commands/ (/quick-fix default, /new-requirement,
                    /build-requirement, /fix-bug, /retro), settings.json (permission rules)
docs/               README.md index · CODING-STANDARDS.md (the one rules file) · CODEBASE-MAP.md
                    (this file) · CHANGELOG.md · worklog.md (append-only)
  architecture/     HLD, LLD, database, api-reference, auth-and-permissions, frontend,
                    realtime-and-notifications, crewdesk-integration
  guides/           page guides, end-to-end flows, CSV import
  deploy/           local-setup-windows, DEPLOYMENT, PRODUCTION-CHECKLIST, IT request,
                    reverse proxy, operations-runbook
  process/          WORKFLOW, decisions, backlog, lessons/, templates/, requirements/ (per REQ)
  qa/               latest deep test
prisma/             schema.prisma (mysql) + migrations/ (the ONLY DDL path)
src/                application (see §3–§8)
mini-services/      notifications (socket.io WS relay), crewdesk-mock (test double)
scripts/            ~65 boot/verify/backup scripts + lib/ helpers (see §10)
```

## 3. Request pipeline (every API call)

```
route.ts (Controller)  → withApi(req, …)  [CSRF assertSameOrigin, request log, no-store]
  → requireUser()       (src/lib/auth.ts — Bearer first, then tcms-access cookie; DB re-check 30 s cache)
  → validate*()         (<res>.validation.ts — zod, throws ApiError.badRequest w/ flatten())
  → service fn          (<res>.service.ts — ensurePermission/can/canAny, ownership, state
                         machines, logActivity, createNotification; throws ApiError)
  → repository fn       (<res>.repository.ts — db.$queryRaw/$executeRaw tagged templates only)
  → serializers.ts      (rows → API JSON, JSON columns parsed exactly once)
  → ok(data) | paginate(data,total,page,pageSize)   (src/lib/api.ts)
Errors: { error, details? }; ApiError→status, ZodError→400, anything else→500.
```

Dispatch is by query params: `?id=`, `?action=`, auth/crewdesk use `?path=`.

**MySQL idioms in repositories:** `insertReturningId()` (INSERT + `LAST_INSERT_ID()` on one
connection) then SELECT read-back (no RETURNING); ids are digit strings everywhere · `UTC_TIMESTAMP(3)` for every created_at/updated_at (never NOW()) ·
`ON DUPLICATE KEY UPDATE` (no INSERT IGNORE) · `LIKE` (case-insensitive via collation) ·
`CAST(? AS JSON)` writes, `JSON_CONTAINS` filters · `Number()` on aggregates ·
TINYINT(1) → boolean normalization (user.repository) · `Prisma.join/sql/empty` for
dynamic fragments · transactions pass `tx: SqlExecutor` (= `Prisma.TransactionClient`,
exported from test-cases.repository) · optimistic locking: guarded UPDATE `WHERE updated_at = <client's
expectedUpdatedAt>` on test cases (+ version), bugs, modules, review verdict/forward, module bulk
verdict → 409 `ApiError.staleEdit()`; the guarded parent UPDATE runs before child inserts (no 1213).
MySQL errors → clean 400/409/503 in `withApi` via `src/lib/server/db-errors.ts` (never SQL text).

## 4. API resources (`src/app/api/<resource>/` — 4 files each)

| Resource | Endpoints (dispatch) | Permission gates (service) |
|---|---|---|
| `/api` (route.ts) | GET liveness `{status:'ok'}` | public |
| `/api/ready` | GET readiness: DB ping ≤ 3 s → 200 `{status:'ready',database:'ok',readOnly}` / 503 | public |
| auth | POST `?path=login\|register\|refresh\|logout`; GET me, `?path=ws-ticket`; PUT profile, `?path=password` | public login/refresh/logout; register only if `TCMS_ALLOW_SIGNUP=true` (creates `viewer`); lockout 5 fails→60 s 429; refresh rotation + 120 s grace; password change revokes all refresh tokens |
| users | GET list, `?action=options`; POST; PUT `?id`; DELETE `?id` (soft `is_active=false`) | `manage_users` (options = any user) |
| permissions | GET matrix; PUT toggle `{role,action,enabled}` | `manage_permissions` |
| modules | GET `{tree (deprecated), flat}` (client builds the tree from flat), `?id[&caseOffset]`; POST; PUT `?id`, `&action=submit-review`; DELETE `?id` (hard, cascades) | `create_module`, `edit_module`, `submit_review`; delete = creator or `edit_module` |
| test-cases | GET list/`?id`/`&action=history\|reviews`/`?action=import-template`; POST, `?action=import` (CSV ≤200 rows); PUT `?id` (versioned + history snapshot), `&action=submit-review`; DELETE `?id`, `?action=bulk-delete` (hard, ≤200) | `create_test_case`; edit = `edit_any_test_case` or author+`edit_own_test_case`; `submit_review`; delete = author or `delete_test_case` |
| reviews | GET `?action=queue`, `?id`, list; POST `?id` verdict, `&action=forward` | `perform_review` (+ assigned reviewer) |
| module-reviews | GET `?action=queue\|all`, `?id`; POST `?id&action=approve-all\|bulk-verdict\|change-reviewer` | `perform_review` |
| bugs | GET list/`?id`/`&action=links`; POST; PUT `?id`, `&action=link-tc`; DELETE `?id` (hard) | `create_bug`; update = `canAny(create_bug,assign_bug)`, reassign needs `assign_bug`; `delete_bug` |
| task-reports | GET list/`?action=my\|summary\|export`/`?id`; POST upsert (user+date); PUT `?id` (`create_task_report` + owner only) | `create_task_report`; `view_all_task_reports` for others' data |
| notifications | GET mine; POST `?action=read-all`; PATCH `?id`; DELETE `?id` | self-scoped only |
| activity-logs | GET list, `?action=entity&type&id`, `?action=user&id` | `view_activity_logs` (all branches) |
| stats | GET `?action=dashboard` (5 s cache), `?action=reports` | any user / `view_all_task_reports`; recent activity needs `view_activity_logs` |
| search | GET `?q&limit` (modules, cases, bugs, wiki) | any user |
| wiki | GET list/`?id`/`&action=download`; POST written, `?action=upload` (multipart, 10 MB); PUT `?id`, `&action=upload`; DELETE `?id` | `create_wiki_doc`, `edit_own/any_wiki_doc`, `delete_wiki_doc` |
| integrations/crewdesk | GET `?path=config\|email-check\|comment\|preview-comment`, list; POST create, `?path=lookup\|retry` (+ `crewdesk.identity.ts`) | `manage_integrations` on everything; modes manual/test(ticket 1355 only)/live |
| seed | GET/POST demo data | 403 unless `TCMS_ENABLE_SEED=true`; no-op if users exist |

Cross-domain reads go service → other resource's repository (test-cases ↔ modules ↔
reviews ↔ module-reviews; `src/lib/server/user.repository.ts` shared).

## 5. RBAC (`src/lib/permissions.ts`, keys in `src/types/index.ts PERMISSION_ACTIONS`)

Roles: `viewer(0) < qa_engineer(1) < developer(2) < product(3) < manager(4) < vp(5)`.
21 actions: create_module, edit_module, create_test_case, edit_own_test_case,
edit_any_test_case, delete_test_case, submit_review, perform_review, create_bug,
delete_bug, assign_bug, create_task_report, view_all_task_reports, view_activity_logs,
manage_integrations, manage_users, manage_permissions, create_wiki_doc,
edit_own_wiki_doc, edit_any_wiki_doc, delete_wiki_doc.

| Role | Defaults |
|---|---|
| vp | all 21 |
| manager | all except manage_permissions |
| product | modules create/edit, create + edit_own cases, submit + perform review, create_bug, task report, view_all_task_reports, view_activity_logs, wiki create/edit_own |
| developer | create_bug, create_task_report |
| qa_engineer | create + edit_own cases, submit_review, create_bug, task report, wiki create/edit_own |
| viewer | none (read-only) |

Overrides: `role_permissions` table (only deviations), in-memory 3 s TTL cache.
Principle (owner): granted → visible AND works; not granted → hidden AND 403.
UI gates via `useAuthStore.can/canAny` only — never compare role strings.

## 6. Frontend

**Routes** (`src/app/(app)/**/page.tsx` → thin wrappers around `src/components/views/*`, except `/login` → `src/components/auth-screen.tsx`;
`(app)/layout.tsx` = `AppShell` auth guard; `src/proxy.ts` redirects cookie-less page hits
to `/login?next=`):

| URL | View | Client gate |
|---|---|---|
| /login | `src/components/auth-screen.tsx` | public (Register tab only if `NEXT_PUBLIC_ALLOW_SIGNUP=true` at build) |
| /dashboard | dashboard-v2.tsx | any |
| /modules, /modules/[id] | modules.tsx, module-detail.tsx | actions per create/edit_module, submit_review |
| /test-cases, /test-cases/[id] | test-cases.tsx (+ test-case-import.tsx), test-case-detail.tsx | per case perms |
| /reviews, /reviews/[id], /module-reviews/[id] | reviews.tsx, review-detail.tsx, module-review-detail.tsx | perform_review |
| /bugs | bugs.tsx (dnd-kit Kanban) | create/assign/delete_bug |
| /tasks | tasks.tsx | view_all_task_reports for team view; create_task_report to edit your own log (read-only notice otherwise) |
| /reports | reports.tsx | view_all_task_reports |
| /activity-log | activity-log.tsx | view_activity_logs |
| /notifications | notifications.tsx | any |
| /wiki, /wiki/[id] | wiki.tsx, wiki-doc-detail.tsx | wiki perms |
| /integrations | integrations.tsx | manage_integrations |
| /settings/users \| permissions \| profile | settings-*.tsx | manage_users / manage_permissions / any |

**State:** `src/store/index.ts` — `useAuthStore` (user, permissions, can/canAny,
initialize/login/register/logout), `useNotificationsStore` (≤50 items), `useViewStore`
(current view ↔ URL). `src/lib/routes.ts` = ViewKey↔path single source of truth
(`pathForView`, `viewFromPath`, `safeNextPath`); `src/components/route-sync.tsx` bridges.
**Server data:** React Query only (staleTime 30 s, retry 1, no focus refetch; reference
data 5 min; dashboard + sidebar review queues poll 30 s). No optimistic updates.
`src/lib/client/invalidate.ts invalidateAfterMutation(qc, ...domains)`.
**HTTP:** `src/lib/client/api.ts` — namespaces authApi, permissionsApi, usersApi,
modulesApi, testCasesApi, reviewsApi, moduleReviewsApi, bugsApi, taskReportsApi,
notificationsApi, activityLogsApi, statsApi, crewdeskApi, wikiApi, searchApi, seedApi.
Sends `X-Requested-With: tcms`; single-flight refresh on 401; hard fail → `/login?next=`.
**Shared UI:** `components/shared/` (state, pagination, badges, page-header,
detail-field, permission-denied, query-error, rich-text-editor, global-search Ctrl+K),
`components/layout/` (sidebar, topbar), `components/ui/` (22 shadcn primitives).
**Feedback:** `toast.success` / `handleApiError` (`src/lib/errors.ts`).
**Realtime:** `src/hooks/use-notification-socket.ts` (HMAC ticket per attempt, refetch on
reconnect + tab visible, no polling timers).

## 7. Key lib files

| File | Role |
|---|---|
| `src/lib/api.ts` | ApiError, ok, paginate, withApi, assertSameOrigin, getQueryParams, getPagination, extractRequestMeta |
| `src/lib/auth.ts` | bcrypt, JWT sign/verify (15 m / 7 d), getCurrentUser, requireUser, ensurePermission |
| `src/lib/permissions.ts` | DEFAULT_PERMISSIONS, override cache, can/canAny, effectivePermissions* |
| `src/lib/serializers.ts` | the only row→JSON mappers (`serialize*`) |
| `src/lib/activity.ts` | logActivity (diff, never throws, invalidates `stats:` cache), parseJson |
| `src/lib/notifications.ts` | createNotification → DB row + WS POST :3004 + email/Telegram (never throws) |
| `src/lib/db.ts` | Prisma singleton |
| `src/lib/logger.ts` | console + `logs/app|error-YYYY-MM-DD.log` + optional Telegram log bot |
| `src/lib/server/config.ts` | reads every setting from `.env` (no built-in URLs or keys; only `startup-guard.ts` also reads env, before config loads) |
| `src/lib/server/id-field.ts` | `idField()` / `optionalIdField()` — digit-string row ids in every validator |
| `src/lib/server/insert.ts` | `insertReturningId()` — INSERT + `LAST_INSERT_ID()` in one transaction, returns the key as a digit string |
| `src/lib/db.ts` | Prisma singleton + the id hook: numeric `id` / `*_id` row values become digit strings |
| `src/lib/server/cache.ts` | TTL cache, coalesced loaders, 500 cap, prefix invalidation |
| `src/lib/server/auth-cookies.ts` | tcms-access / tcms-refresh httpOnly cookie helpers |
| `src/lib/server/ws-ticket.ts` | 60 s HMAC WS tickets |
| `src/lib/server/delivery.ts` | SMTP (nodemailer) + Telegram delivery |
| `src/lib/server/csv.ts` | RFC4180 parser, MAX_IMPORT_ROWS 200 |
| `src/lib/server/optimistic-lock.ts` | `expectedUpdatedAtField` (zod) + `resolveExpectedUpdatedAt` for guarded updates (409) |
| `src/lib/server/db-errors.ts` | pure MySQL/Prisma error → `{status,message,kind}` mapper used by `withApi` |
| `src/lib/server/read-only.ts` | `TCMS_READ_ONLY` rule: writes → 503 except login/refresh/logout |
| `src/lib/server/login-rate-limit.ts` | per-IP failed sign-in limit (in memory, last X-Forwarded-For entry) |
| `src/lib/csv-export.ts` | `csvCell`/`toCsv`: RFC-4180 quoting + formula-injection guard (all CSV exports) |
| `src/lib/server/startup-guard.ts` | `assertRequiredSettings()` (every mode: names each missing required `.env` key, exit 1) + `TCMS_DEPLOY_ENV=production` secret/DB-URL checks |
| `src/lib/server/db-settings-guard.ts` | production: sql_mode/time_zone/charset checks, 5×3 s retry |
| `src/lib/server/backup-health.ts` | daily stale-backup (>26 h) alert notifications |
| `src/lib/server/crewdesk.client.ts` | only Crew Desk HTTP client |
| `src/lib/server/*.repository.ts` | shared: user, role-permission, notification, activity-log |
| `src/lib/format.ts` | colors, hex palettes, date/time formatters |
| `src/types/index.ts` / `sql-rows.ts` | domain unions/interfaces / raw row types |
| `src/instrumentation.ts` → `src/instrumentation-node.ts` | boot (Node runtime only): startup guard → db guard → error handlers → SIGTERM disconnect → backup monitor |

## 8. Database (`prisma/schema.prisma`, MySQL)

17 tables, `INT UNSIGNED AUTO_INCREMENT` keys named after the entity (FKs `INT UNSIGNED`; ids travel
as digit strings), DATETIME(3), utf8mb4_unicode_ci
(utf8mb4_bin on `users.password_hash`, `refresh_tokens.token`).
users · refresh_tokens · modules (self-tree via parent_id + materialized `path`/`depth`) ·
role_permissions (PK role+action) · login_attempts (PK email) · test_cases (JSON tags,
steps, attachments; version) · test_case_history (JSON snapshot) · module_review_requests ·
review_requests (cycle, module_review_id) · review_events (JSON flagged_fields) · bugs ·
bug_test_case_links (PK bug+tc) · task_reports (unique user+date, JSON tasks) ·
notifications · activity_logs (JSON before/after/diff) · crew_desk_links (no FKs) ·
wiki_documents (MEDIUMTEXT content, LONGBLOB file_data, JSON tags).
Statuses: case `draft→in_review→approved|needs_revision` (+active, deprecated);
review `pending→in_progress→completed`; verdict `approved|failed|needs_revision`;
bug `open|in_progress|resolved|closed|wont_fix`.

**Migrations** (only DDL path — `npx prisma migrate deploy` as the DDL user via DIRECT_URL;
never `db push`): ONE baseline `20261017120000_baseline_numeric_ids` (all 17 tables + indexes;
hand-edited collations + JSON defaults; production never ran an earlier migration). DB users: `tcms_app` (DML), `tcms_migrate` (DDL),
`tcms_backup` (read-only for mysqldump).

## 9. Mini-services

- `mini-services/notifications/index.ts` (bun + socket.io): WS on `WS_PORT` 3003,
  loopback `POST /notify` on 3004 with `x-notify-secret`; ticket auth; production
  requires `WS_CORS_ORIGIN`, path `/socket.io/`.
- `mini-services/crewdesk-mock/index.ts` (bun, :3010): test double; refuses to run in production.

## 10. Scripts that matter (`scripts/`)

- **Sandbox boot (Linux):** `start-tcms.sh`, `mysql-env.sh`, `dev-tcms.mjs` (`npm run dev`),
  `boot-tcms-autostart.sh`, `migration/mysql84-boot.sh` (MySQL 8.4.6 on :5500).
- **DoD suites:** see `docs/CODING-STANDARDS.md` §5 (Windows: verify-import, verify-permissions,
  verify-notifications, verify-review-matrix). Linux-only: `verify-battery.sh`,
  `run-crewdesk-tests.sh` (5 phases). `audit-standards.mjs` (report only). Other feature verifiers (`verify-permission-matrix.mjs`,
  `verify-review-matrix.mjs`, `verify-permissions.mjs`, `verify-notifications.mjs`, `verify-wiki.mjs`…).
- **Production-readiness verifiers (2026-10-16, all self-cleaning):** `verify-concurrency.mjs` (409 races),
  `verify-db-errors.mjs` (MySQL error mapping), `verify-flagged-fields.mjs` (B4), `verify-safety.mjs`
  (headers, /api/ready, read-only, CSV, per-IP limit), `create-first-vp-test.mjs`, `verify-ui-gates.mjs`.
  Shared cleanup: `scripts/lib/suite-cleanup.mjs` (ID-scoped, DB guard + lock) — the DoD suites remove
  the rows they create (B16). R9 dry run: `cleanup-req001-testdata.mjs` (dry run by default).
- **Performance (2026-10-17):** `verify-page-apis.mjs` (per page × role: API calls, duplicates,
  401/403 calls, loading phases, p95 — run against a production build) and `loadtest-1000.mjs`
  (realistic 1000 users + stress, p50/p95, DB connection peak). Results: `docs/architecture/HLD.md` §7.
- **One command (2026-10-19):** `npm run verify:all` → `scripts/verify-all.mjs` (static checks + 15 suites,
  serial, memory check, per-suite time limit, results table, logs in `<tmp>/tcms-verify-all/`).
- **Security (2026-10-17):** `verify-security.mjs` (13 sections: IDOR every role × endpoint, sessions, open redirect,
  SQL injection, XSS in Chrome, CSRF/CORS, CSV, headers, error leaks, bundle/log secrets, mass assignment, limits,
  Crew Desk) — report `docs/qa/SECURITY-TEST-2026-10-17.md`. `clean-env.mjs` tidies `.env` into the `.env.example` layout (required keys + keys in use only; names only).
- **Ops scripts:** `create-first-vp.mjs` (first VP in production, `docs/deploy/operations-runbook.md` §6),
  `send-test-notification.mjs` (one test email / Telegram message, `--check`).
- **Infra verifiers:** `startup-guard-test.mjs` (17), `db-settings-guard-test.mjs` (11),
  `mysql-baseline-test.mjs` (19), `mysql-correctness-test.mjs` (15), `backup-test.mjs` (26),
  `backup-app-staleness-test.mjs` (10), `ws-auth-probe.mjs` (10), `ws-reconnect-test.mjs` (5).
- **Backups:** `backup-db-mysql.sh`, `backup-scheduler.mjs` (02:30 UTC, 14 kept), `restore-mysql.sh`.
- **Local MySQL:** `migration/mysql84-boot.sh` boots the local MySQL 8.4 test server.
- Several scripts hard-code `/home/z/my-project/...` (sandbox-only paths).

## 11. Definition of Done (`docs/CODING-STANDARDS.md` §5)

See `docs/CODING-STANDARDS.md` §5 — the single source (not repeated here).

## 12. Known deviations / tech debt (noted, NOT yet fixed)

1. Services import `db` to open `db.$transaction` (test-cases, reviews, module-reviews);
   `docs/architecture/LLD.md` says transactions belong in repositories (seed/modules do it right).
2. ~~`process.env` read outside config.ts~~ — fixed 2026-10-17 (startup-guard reads env on purpose, before config loads).
3. Raw SQL outside repositories: `backup-health.ts`, `db-settings-guard.ts`.
4. `users.service.ts` imports `clearIdentityCache` from crewdesk resource internals.
5. Duplicated SET-builders in test-cases.repository (`updateTestCase` vs `updateTestCaseIfVersion`).
6. `NotificationType` defined twice (`lib/notifications.ts`, `types/index.ts`); `backup_failed` in neither.
7. No automated unit/e2e test framework, no `test` script, no CI; verification = sandbox scripts.
8. Large views: dashboard-v2 1044, tasks 905, bugs 834, integrations 792, test-cases 768,
   module-review-detail 631, modules 608 lines.
9. ESLint rules mostly disabled; `noImplicitAny` false; `reactStrictMode` false.
10. ~~CSV export guard only in test-cases~~ — fixed 2026-10-16 (`src/lib/csv-export.ts` everywhere).
    New: HSTS is sent by every build (`next.config.ts`); browsers apply it over HTTPS only, nginx also sets it.
    `FLAGGABLE_FIELDS` is duplicated in `review-detail.tsx` and `module-review-detail.tsx`.
11. Lists capped at 200 silently (bugs board, picker `all-light` queries).
12. Unused deps: `react-hook-form`, `z-ai-web-dev-sdk`; `db:push --accept-data-loss` script contradicts migrate-only policy.
13. Code comments still mention keep-alive (`api/route.ts`) and old roles admin/team_lead; the docs were brought up to date 2026-10-16.

## 13. Local machine state (Windows, checked 2026-10-15)

Git repo (branches `main`, `improvements`). Node 24, npm 11 and bun installed; MySQL 8.4
on 127.0.0.1:5500, schema `tcms_test` (never port 3306 — a different server).
`.env` from `.env.example` (git-ignored), `npm install` (npm 11 install scripts
approved via `allowScripts` in package.json), `npx prisma migrate deploy` applied,
demo data seeded; `npm run dev` serves http://localhost:3000. Sandbox `.sh` scripts
assume Linux (`/tmp`, `/proc`).
