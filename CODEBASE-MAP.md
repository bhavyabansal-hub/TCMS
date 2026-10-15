# CODEBASE-MAP.md — fast orientation for TCMS

> Compact map of the repository, written 2026-10-15 from a full read of `agent.md`,
> `docs/`, `worklog.md` and the source. **Read this before exploring; update it when
> structure changes.** Binding rules live in `agent.md` — this file only points.

## 1. What it is

Test Case Management System. Next.js 16 App Router · React 19 · TypeScript 5 ·
Tailwind v4 + shadcn/ui · Zustand 5 · TanStack React Query 5 · Prisma 6 (client only,
**raw SQL everywhere**) · **MySQL 8.4** (utf8mb4_unicode_ci, strict, UTC, native JSON) ·
JWT in httpOnly cookies · zod 4 · socket.io mini-service for realtime.
PostgreSQL retired 2026-10-14 (kept read-only as rollback source; PG-era scripts live in
`archive/postgres/` until after go-live). Production cutover is **pending IT answers**
(IT request file: to be recreated (pending); plan in `docs/migration/04-cutover-rollback.md`).

## 2. Top-level layout

```
agent.md            binding coding standards + Definition of Done   (READ FIRST)
CLAUDE.md           pointer to agent.md + this file
worklog.md          append-only engineering log (never overwrite)
docs/               README.md index, 01–18 guides, LOCAL-SETUP-WINDOWS.md, migration/ (PG→MySQL
                    dossier), deploy/, qa/, PDF guide, refactor reports, CHANGELOG
prisma/             schema.prisma (mysql) + migrations/ (the ONLY DDL path)
src/                application (see §3–§8)
mini-services/      notifications (socket.io WS relay), crewdesk-mock (test double)
scripts/            ~50 boot/verify/backup/migration scripts (see §10)
archive/            moved-out files (see archive/README.md): postgres/ = PG-era scripts +
                    schemas + old deploy guide (rollback plan until go-live); scripts/ =
                    one-off probes/repros; src/ = classic dashboard + /dashboard-preview
README.md DEPLOYMENT.md CHANGELOG.md   root docs (deploy guide = MySQL 8.4)
.zscripts/ (git-ignored) start-dev.sh Caddyfile bun.lock vercel.json   LOAD-BEARING pipeline files — never delete
(no download/ folder: the canonical zip and IT request file are pending re-creation)
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

**MySQL idioms in repositories:** `newId()` (app-side uuid) + INSERT then SELECT read-back
(no RETURNING) · `UTC_TIMESTAMP(3)` for every created_at/updated_at (never NOW()) ·
`ON DUPLICATE KEY UPDATE` (no INSERT IGNORE) · `LIKE` (case-insensitive via collation) ·
`CAST(? AS JSON)` writes, `JSON_CONTAINS` filters · `Number()` on aggregates ·
TINYINT(1) → boolean normalization (user.repository) · `Prisma.join/sql/empty` for
dynamic fragments · transactions pass `tx: SqlExecutor` (= `Prisma.TransactionClient`,
exported from test-cases.repository) · optimistic locking on test-case edits (409).

## 4. API resources (`src/app/api/<resource>/` — 4 files each)

| Resource | Endpoints (dispatch) | Permission gates (service) |
|---|---|---|
| `/api` (route.ts) | GET health `{status:'ok'}` | public |
| auth | POST `?path=login\|register\|refresh\|logout`; GET me, `?path=ws-ticket`; PUT profile, `?path=password` | public login/refresh/logout; register only if `TCMS_ALLOW_SIGNUP=true` (creates `viewer`); lockout 5 fails→60 s 429; refresh rotation + 120 s grace; password change revokes all refresh tokens |
| users | GET list, `?action=options`; POST; PUT `?id`; DELETE `?id` (soft `is_active=false`) | `manage_users` (options = any user) |
| permissions | GET matrix; PUT toggle `{role,action,enabled}` | `manage_permissions` |
| modules | GET tree `{tree,flat}`, `?id[&caseOffset]`; POST; PUT `?id`, `&action=submit-review`; DELETE `?id` (hard, cascades) | `create_module`, `edit_module`, `submit_review`; delete = creator or `edit_module` |
| test-cases | GET list/`?id`/`&action=history\|reviews`/`?action=import-template`; POST, `?action=import` (CSV ≤200 rows); PUT `?id` (versioned + history snapshot), `&action=submit-review`; DELETE `?id`, `?action=bulk-delete` (hard, ≤200) | `create_test_case`; edit = `edit_any_test_case` or author+`edit_own_test_case`; `submit_review`; delete = author or `delete_test_case` |
| reviews | GET `?action=queue`, `?id`, list; POST `?id` verdict, `&action=forward` | `perform_review` (+ assigned reviewer) |
| module-reviews | GET `?action=queue\|all`, `?id`; POST `?id&action=approve-all\|bulk-verdict\|change-reviewer` | `perform_review` |
| bugs | GET list/`?id`/`&action=links`; POST; PUT `?id`, `&action=link-tc`; DELETE `?id` (hard) | `create_bug`; update = `canAny(create_bug,assign_bug)`, reassign needs `assign_bug`; `delete_bug` |
| task-reports | GET list/`?action=my\|summary\|export`/`?id`; POST upsert (user+date); PUT `?id` (owner only) | `create_task_report`; `view_all_task_reports` for others' data |
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

**Routes** (`src/app/(app)/**/page.tsx` → thin wrappers around `src/components/views/*`;
`(app)/layout.tsx` = `AppShell` auth guard; `src/proxy.ts` redirects cookie-less page hits
to `/login?next=`):

| URL | View | Client gate |
|---|---|---|
| /login | auth-screen.tsx | public (Register tab only if `NEXT_PUBLIC_ALLOW_SIGNUP=true` at build) |
| /dashboard | dashboard-v2.tsx | any |
| /modules, /modules/[id] | modules.tsx, module-detail.tsx | actions per create/edit_module, submit_review |
| /test-cases, /test-cases/[id] | test-cases.tsx (+ test-case-import.tsx), test-case-detail.tsx | per case perms |
| /reviews, /reviews/[id], /module-reviews/[id] | reviews.tsx, review-detail.tsx, module-review-detail.tsx | perform_review |
| /bugs | bugs.tsx (dnd-kit Kanban) | create/assign/delete_bug |
| /tasks | tasks.tsx | view_all_task_reports for team view |
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
| `src/lib/server/config.ts` | central env inventory (intended sole `process.env` reader) |
| `src/lib/server/id.ts` | `newId()` = randomUUID |
| `src/lib/server/cache.ts` | TTL cache, coalesced loaders, 500 cap, prefix invalidation |
| `src/lib/server/auth-cookies.ts` | tcms-access / tcms-refresh httpOnly cookie helpers |
| `src/lib/server/ws-ticket.ts` | 60 s HMAC WS tickets |
| `src/lib/server/delivery.ts` | SMTP (nodemailer) + Telegram delivery |
| `src/lib/server/csv.ts` | RFC4180 parser, MAX_IMPORT_ROWS 200 |
| `src/lib/server/startup-guard.ts` | `TCMS_DEPLOY_ENV=production` secret/DB-URL checks, exit 1 |
| `src/lib/server/db-settings-guard.ts` | production: sql_mode/time_zone/charset checks, 5×3 s retry |
| `src/lib/server/backup-health.ts` | daily stale-backup (>26 h) alert notifications |
| `src/lib/server/crewdesk.client.ts` | only Crew Desk HTTP client |
| `src/lib/server/*.repository.ts` | shared: user, role-permission, notification, activity-log |
| `src/lib/format.ts` | colors, hex palettes, date/time formatters |
| `src/types/index.ts` / `sql-rows.ts` | domain unions/interfaces / raw row types |
| `src/instrumentation.ts` | boot: startup guard → db guard → error handlers → SIGTERM disconnect → backup monitor |

## 8. Database (`prisma/schema.prisma`, MySQL)

17 tables, CHAR(36) uuid PKs named after the entity, DATETIME(3), utf8mb4_unicode_ci
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
never `db push`): `20261015034822_init_mysql` (hand-edited collations + JSON defaults),
`20261015034940_add_perf_indexes`. DB users: `tcms_app` (DML), `tcms_migrate` (DDL),
`tcms_backup` (read-only for mysqldump).

## 9. Mini-services

- `mini-services/notifications/index.ts` (bun + socket.io): WS on `WS_PORT` 3003,
  loopback `POST /notify` on 3004 with `x-notify-secret`; ticket auth; production
  requires `WS_CORS_ORIGIN`, path `/socket.io/`.
- `mini-services/crewdesk-mock/index.ts` (bun, :3010): test double; refuses to run in production.

## 10. Scripts that matter (`scripts/`)

- **Sandbox boot (Linux):** `start-tcms.sh`, `mysql-env.sh`, `dev-tcms.mjs` (`npm run dev`),
  `boot-tcms-autostart.sh`, `migration/mysql84-boot.sh` (MySQL 8.4.6 on :5500).
- **DoD suites:** `verify-battery.sh` (67), `run-crewdesk-tests.sh` (5 phases),
  `verify-import.mjs` (33), feature verifiers (`verify-permission-matrix.mjs`,
  `verify-review-matrix.mjs`, `verify-permissions.mjs`, `verify-notifications.mjs`, `verify-wiki.mjs`…).
- **Infra verifiers:** `startup-guard-test.mjs` (17), `db-settings-guard-test.mjs` (11),
  `mysql-baseline-test.mjs` (19), `mysql-correctness-test.mjs` (15), `backup-test.mjs` (26),
  `backup-app-staleness-test.mjs` (10), `ws-auth-probe.mjs` (10), `ws-reconnect-test.mjs` (5).
- **Backups:** `backup-db-mysql.sh`, `backup-scheduler.mjs` (02:30 UTC, 14 kept), `restore-mysql.sh`.
- **Migration one-offs:** `migration/migrate-pg-to-mysql.mjs`, `convert-schema-mysql.cjs`.
- **PG-era → `archive/postgres/scripts/`** (keep until after go-live, never run on MySQL):
  backup-db, restore-db, apply-indexes, add-load-indexes, migrate-rbac, db-qa-checks,
  supabase-check, probe-rbac-state, check-tables, cleanup-probe-data, validate-db-setup,
  verify-no-corruption, verify-rbac.sh, start-dev-fresh.sh, migration/schema.pg.prisma.
- **One-offs → `archive/scripts/`** (46 unreferenced repro/probe/audit/round verifiers).
- Several scripts hard-code `/home/z/my-project/...` (sandbox-only paths).

## 11. Definition of Done (agent.md §3)

`npx tsc --noEmit` 0 errors · `npm run lint` 0 errors · battery + crewdesk + import +
feature verifier green · full status-code set checked · docs + `worklog.md` updated ·
canonical zip refreshed (none at present — `download/` no longer exists; pending).

## 12. Known deviations / tech debt (noted, NOT yet fixed)

1. Services import `db` to open `db.$transaction` (test-cases, reviews, module-reviews);
   docs/15 says transactions belong in repositories (seed/modules do it right).
2. `process.env` read outside config.ts: `auth.service.ts` (TCMS_ALLOW_SIGNUP),
   `backup-health.ts`, `db-settings-guard.ts` (startup-guard is deliberate).
3. Raw SQL outside repositories: `backup-health.ts`, `db-settings-guard.ts`.
4. `users.service.ts` imports `clearIdentityCache` from crewdesk resource internals.
5. Duplicated SET-builders in test-cases.repository (`updateTestCase` vs `updateTestCaseIfVersion`).
6. `NotificationType` defined twice (`lib/notifications.ts`, `types/index.ts`); `backup_failed` in neither.
7. No automated unit/e2e test framework, no `test` script, no CI; verification = sandbox scripts.
8. Large views: dashboard-v2 1044, tasks 905, bugs 834, integrations 792, test-cases 768,
   module-review-detail 631, modules 608 lines.
9. ESLint rules mostly disabled; `noImplicitAny` false; `reactStrictMode` false.
10. CSV export formula-injection guard only in test-cases (not bugs/tasks); bugs CSV under-quotes.
11. Lists capped at 200 silently (bugs board, picker `all-light` queries).
12. Unused deps: `react-hook-form`, `z-ai-web-dev-sdk`; `db:push --accept-data-loss` script contradicts migrate-only policy.
13. Stale docs: docs 02/13 describe pre-restructure schema; docs 12 §3–§4 historical (PG era); `api/route.ts` mentions keep-alive; comments mention old roles admin/team_lead.

## 13. Local machine state (Windows, checked 2026-10-15)

Git repo (branches `main`, `improvements`). Node 24, npm 11 and bun installed; MySQL 8.4
on 127.0.0.1:5500, schema `tcms_test` (never port 3306 — a different server).
`.env` from `.env.example` (git-ignored), `npm install` (npm 11 install scripts
approved via `allowScripts` in package.json), `npx prisma migrate deploy` applied,
demo data seeded; `npm run dev` serves http://localhost:3000. Sandbox `.sh` scripts
assume Linux (`/tmp`, `/proc`).
