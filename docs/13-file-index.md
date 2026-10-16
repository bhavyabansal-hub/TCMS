# 13 · File Index — every file, explained

> One entry per project file (line counts approximate). Grouped by directory; "→ doc"
> points at the deep-dive document. shadcn/ui primitives are grouped at the end since
> they are template stock.

---

## Root & configuration

| File | Lines | What it is |
|---|---|---|
| `package.json` | — | Scripts (`dev/build/start/lint`, `postinstall: prisma generate`, `db:*`), every dependency pin. → doc 01 §2 |
| `package-lock.json` | — | Reproducible install (`npm ci`) |
| `tsconfig.json` | — | TypeScript config (`@/*` → `src/*` path alias) |
| `next.config.ts` | — | `output: "standalone"` (required by the deploy pipeline), `ignoreBuildErrors: false` (type errors never pass) |
| `tailwind.config.ts` | — | Legacy-style theme mapping (v4 CSS-first lives in globals.css) |
| `postcss.config.mjs` | — | Tailwind v4 postcss plugin |
| `eslint.config.mjs` | — | Flat ESLint config (next/core-web-vitals) |
| `components.json` | — | shadcn/ui generator settings |
| `agent.md` | — | **Canonical coding standards + agent contract** (layered API pattern, raw SQL rule, response helpers, naming, definition of done). Read before writing any code |
| `CLAUDE.md` | — | Thin pointer to `agent.md` for AI coding assistants (kept so tooling that auto-reads it finds the standards) |
| `.gitignore` | — | Keeps `.env*`, `/db/`, build output out of Git |
| `.env.example` | — | Annotated template for every env var (DB URLs, secrets, guards, backups, email/Telegram, realtime) |
| `README.md` | — | Project overview + quick start |
| `worklog.md` | — | Append-only engineering log: every task, decision and verification result |
| `CHANGELOG.md` / `DEPLOYMENT.md` | — | User-visible changes / deployment overview |
| `docs/` | — | Study hub: docs 01–18, deploy guides, process, QA report (see `docs/README.md`) |

## prisma/

| File | Lines | What it is |
|---|---|---|
| `schema.prisma` | 324 | The 17 models, relations, MySQL JSON columns, indexes. → doc 02 |
| `migrations/` | — | Versioned MySQL migrations, applied with `npx prisma migrate deploy` (the only DDL path) |

## src/app — Next.js App Router

| File | Lines | What it is |
|---|---|---|
| `layout.tsx` | 41 | Root server layout: metadata, Geist fonts, `<Providers>`, Sonner toaster |
| `page.tsx` | 7 | Redirects `/` → `/dashboard` |
| `proxy.ts` (in `src/`) | 43 | Edge proxy gate: anonymous page requests → `/login?next=` (cookie presence) |
| `global-error.tsx` | 34 | Root error boundary (catches even layout crashes; reset/reload + digest) |
| `not-found.tsx` | — | 404 screen |
| `globals.css` | 163 | Tailwind v4 `@theme inline` tokens (oklch), light + "soft graphite" `.dark` palettes, recharts dark fixes |

## src/app/api — route folders (→ doc 04)

Every folder follows the four layers of `agent.md` §1: `route.ts` (controller) →
`<name>.validation.ts` (zod) → `<name>.service.ts` (rules, permissions) →
`<name>.repository.ts` (raw SQL only).

| Folder | Endpoints |
|---|---|
| `route.ts` (root) | `GET /api` liveness |
| `ready/` | `GET /api/ready` readiness (database `SELECT 1`, 503 when down) |
| `auth/` | register / login (per-email lock + per-IP limit) / refresh / logout / me / profile / password / ws-ticket |
| `seed/` | Idempotent demo-data seeder, only with `TCMS_ENABLE_SEED=true` |
| `stats/` | `?action=dashboard` / `?action=reports` (`view_all_task_reports`) |
| `search/` | Global search |
| `modules/` | tree / detail / create / update / delete + `?action=submit-review` (module review) |
| `test-cases/` | list / detail / history / reviews + create + versioned update + submit-review + hard delete + CSV import → doc 14 |
| `reviews/` | queue / all / detail + verdict + forward |
| `module-reviews/` | queue / all / detail + bulk verdict / approve-all / change-reviewer |
| `bugs/` | list / detail / links + create + update + link-tc + hard delete |
| `task-reports/` | my / summary / list / export / upsert-by-date / owner-only update |
| `activity-logs/` | filtered audit list + per-entity / per-user branches |
| `notifications/` | list / read-all / read-one / delete (own rows only) |
| `users/` | user management (`manage_users`; role changes VP only) + `?action=options` pickers |
| `permissions/` | the runtime permission matrix (`manage_permissions`) |
| `wiki/` | wiki documents + file upload / download |
| `integrations/crewdesk/` | Crew Desk link management → doc 18 |

## src/components — app chrome

| File | Lines | What it is |
|---|---|---|
| `providers.tsx` | 121 | `QueryInit` (React Query defaults) + `AuthGate` (session restore, retry card on transient failure, cache warm prefetch, cross-account cache wipe). → doc 05 §2 |
| `route-sync.tsx` | 25 | Bridges URL changes ↔ `useViewStore` (deep links, back/forward) |
| `app-shell.tsx` | 90 | Auth guard + sidebar + topbar + active page render |
| `auth-screen.tsx` | 189 | `/login` split screen + demo account quick-fills. → doc 06 |
| `layout/sidebar.tsx` | 165 | 12 nav items gated by permission (`perm`/`anyPerm` per item), reviews pending badge (30 s poll, permission-gated), collapse + mobile drawer |
| `layout/topbar.tsx` | 176 | Mobile menu button, global search, notification bell popover, dark-mode toggle, user menu |

## src/app/(app) — the real page routes (→ docs 06–10)

One `page.tsx` per URL: `dashboard`, `modules`, `test-cases`, `test-cases/[id]`,
`reviews`, `reviews/[id]`, `module-reviews/[id]`, `bugs`, `tasks`, `reports`,
`activity-log`, `notifications`, `settings/users`, `settings/permissions`,
`settings/profile` (+ segment `error.tsx` boundary and `loading.tsx`). Each page
mounts its view component from `src/components/views/`; the URL↔view map lives in
`src/lib/routes.ts`.

### src/components/views — the 16 view components (one per page/tab)

| File | Lines | ViewKey | One-liner |
|---|---|---|---|
| `dashboard-v2.tsx` | — | `dashboard` | QA Command Center (the /dashboard page) |
| `modules.tsx` | 511 | `modules` | Module tree browser, create/delete, submit module for review |
| `test-cases.tsx` | 411 | `test-cases` | Filterable table, create dialog (steps editor), CSV export |
| `test-case-detail.tsx` | 626 | `test-case-detail` | Read/edit modes, steps table, submit for review, PERMANENT delete (confirm), history/reviews/activity panels |
| `test-case-import.tsx` | 246 | `test-cases` (tab) | Import CSV panel: module picker, template download, upload + per-row result card → doc 14 |
| `reviews.tsx` | 253 | `reviews` | Module-review / single-case / all-reviews queues with overdue detection |
| `review-detail.tsx` | 347 | `review-detail` | Read-only case + verdict dialog (flagged fields, mandatory comment) |
| `module-review-detail.tsx` | 415 | `module-review-detail` | Bulk workspace: stats, expandable cases, per-case verdicts, Approve All |
| `bugs.tsx` | 492 | `bugs` | dnd-kit Kanban + table, create dialog, detail sheet with inline edit |
| `tasks.tsx` | 546 | `tasks` | Daily report editor (task lines, entity links), manager user-switch, CSV export |
| `reports.tsx` | 418 | `reports` | Team weekly hours + status/priority/bug charts (`view_all_task_reports`), print-to-PDF |
| `activity-log.tsx` | 463 | `activity-log` | Audit table, 6 filters, before/after diff dialog, cross-navigation |
| `notifications.tsx` | 253 | `notifications` | Inbox over the Zustand store: icons, read/unread, deep links, delete |
| `settings-users.tsx` | 522 | `settings-users` | VP console: invite dialog, inline role switch (6 roles), deactivate, filters |
| `settings-permissions.tsx` | 115 | `settings-permissions` | VP permission matrix: 16 actions x 6 roles of instant toggles (`PUT /api/permissions`) |
| `settings-profile.tsx` | 322 | `settings-profile` | Account card, profile/notification prefs, change password |

## src/components/shared — tiny building blocks

| File | Lines | What it is |
|---|---|---|
| `state.tsx` | 96 | `StateLoading / StateLoadingCards / StateSpinner / StateEmpty / StateError` |
| `pagination.tsx` | 43 | Shared Prev/Next pagination (used by test-cases) |

## src/hooks

| File | Lines | What it is |
|---|---|---|
| `use-notification-socket.ts` | 79 | socket.io client → room auth → `notification` → store; backoff reconnect; seeds 50 items. → doc 12 |
| `use-toast.ts` | 193 | shadcn toast queue (legacy — views use sonner) |
| `use-mobile.ts` | 19 | `matchMedia` breakpoint helper (template) |

## src/lib — the two backbones + helpers

| File | Lines | What it is |
|---|---|---|
| `client/api.ts` | 297 | **Frontend data layer**: session storage, `request<T>()` with 401 auto-refresh, 12 API namespaces. → doc 05 §3 |
| `client/download.ts` | 13 | Browser file-download helper shared by CSV export + template download |
| `auth.ts` | 124 | **Server auth**: JWT sign/verify, `getCurrentUser()` (cookie), bcrypt, re-exports `can()`/hierarchy from lib/permissions, `requirePermission`/`ensurePermission`. → doc 03 |
| `permissions.ts` | 120 | **Permission engine**: 6-role hierarchy, `DEFAULT_PERMISSIONS`, 60 s-TTL override cache, `can()`/`effectivePermissionsFor()`/`effectiveMatrix()` |
| `server/role-permission.repository.ts` | 65 | Raw SQL for the `role_permissions` override table (list/find/upsert/delete) |
| `api.ts` | 49 | Response helpers: `ok/paginate/badRequest/unauthorized/forbidden/notFound/getQueryParams` |
| `db.ts` | 12 | Prisma singleton (HMR-safe via globalThis in dev) |
| `activity.ts` | 79 | `logActivity()` (snapshots + diff + IP/UA, never throws) + MySQL JSON `parseJson/toJson` |
| `notifications.ts` | 106 | `createNotification()` (preference-gated insert) + WS broadcast + email/Telegram fan-out. → doc 12 |
| `serializers.ts` | 374 | 7 row normalisers guaranteeing MySQL JSON parsed exactly once (+ `TaskItem` type) |
| `format.ts` | 145 | All color maps + date/duration/text formatters (exact mappings in doc 05 §6) |
| `errors.ts` | 63 | Client `ApiError` → friendly toast message mapping; `handleMutation` |
| `server/csv.ts` | 123 | Pure RFC-4180 CSV parser + `parseCsvSteps`/`parseCsvTags` (no I/O, no business logic) → doc 14 |
| `server/delivery.ts` | 140 | Email (SMTP via nodemailer, env-gated) + Telegram (Bot API, env-gated) senders + `deliverNotification()` per-prefs dispatcher; never throws → doc 12 §6 |
| `utils.ts` | 6 | `cn()` Tailwind class merger |
| `roles.ts` | — | Role list/labels + `canAssignRoles` (VP only) and `DEFAULT_INVITE_ROLE` (`viewer`) |
| `csv-export.ts` | — | Quoted CSV export with spreadsheet formula-injection guard (cases, bugs, work logs) |
| `server/optimistic-lock.ts` | — | "Changed by someone else" check on the loaded `updatedAt` → 409 |
| `server/db-errors.ts` | — | MySQL error codes → clean 400 / 409 / 503 (no SQL text to the client) |
| `server/read-only.ts` | — | `TCMS_READ_ONLY=true`: every write answers 503 except login / refresh / logout |
| `server/login-rate-limit.ts` | — | In-memory per-IP failed sign-in limit (429) |
| `server/startup-guard.ts` / `db-settings-guard.ts` | — | Refuse to start with unsafe production settings / wrong MySQL server settings |
| `server/backup-health.ts` | — | Daily stale-backup check → in-app alert to `manage_users` holders |

## src/store & src/types

| File | Lines | What it is |
|---|---|---|
| `store/index.ts` | 142 | Zustand: `useAuthStore` (session), `useViewStore` (router replacement), `useNotificationsStore`. → doc 05 §2 |
| `types/index.ts` | 245 | All domain types & string-enum unions shared by views (`TestCase`, `ReviewRequest`, `Paginated<T>`, …) |

## scripts/ — verification suites & ops tooling

Definition-of-done suites are listed in `agent.md` §3. The suites clean up the rows they
create (`scripts/lib/suite-cleanup.mjs`) and refuse any database other than
`127.0.0.1:5500/tcms_test` (`scripts/lib/db-guard.mjs`).

| File | What it is |
|---|---|
| `dev-tcms.mjs` | `npm run dev` wrapper — MySQL-only (refuses a non-mysql URL), then `next dev` |
| `start-tcms.sh` / `boot-tcms-autostart.sh` / `mysql-env.sh` | Linux stack launcher, boot worker, and the single source of DB env wiring |
| `migration/mysql84-boot.sh` | Boots a local MySQL 8.4 test server (creates the app / migrate / backup users) |
| `create-first-vp.mjs` (+ `create-first-vp-test.mjs`) | Creates the first VP on an empty production database → doc 17 §6 |
| `backup-db-mysql.sh` / `backup-scheduler.mjs` / `restore-mysql.sh` | Nightly mysqldump, its scheduler, and the restore drill → doc 17 |
| `send-test-notification.mjs` | Checks / sends one email + Telegram test message (`--check` sends nothing) |
| `audit-standards.mjs` | Coding-standards auditor (`agent.md` §1) |
| `verify-permissions.mjs` / `verify-permission-matrix.mjs` / `verify-review-matrix.mjs` / `verify-ui-gates.mjs` | Permission behaviour, the 126-cell matrix, review access per role, UI gates per role |
| `verify-permission-toggle-e2e.mjs` / `verify-role-flows-e2e.mjs` | Browser e2e: every toggle ON/OFF per role; full role flows (UI + API + DB + notifications) |
| `verify-concurrency.mjs` / `verify-db-errors.mjs` / `verify-safety.mjs` / `verify-flagged-fields.mjs` | Optimistic locking, MySQL error mapping, safety features, flagged fields |
| `verify-import.mjs` / `verify-notifications.mjs` / `verify-wiki.mjs` / `verify-crewdesk.mjs` | CSV import, notifications + auth security, wiki, Crew Desk (mock only) |
| `verify-battery.sh` / `audit-500-hunt.sh` / `verify-security-fixes.mjs` / `verify-review-ux-round.mjs` | Older API sweeps (Linux shell) and round verifiers |
| `e2e-verify-routes-reviews-delete.mjs` | Browser e2e: routes, per-page permissions, review ownership, hard delete |
| `mysql-baseline-test.mjs` / `mysql-correctness-test.mjs` / `startup-guard-test.mjs` / `db-settings-guard-test.mjs` / `backup-test.mjs` / `backup-app-staleness-test.mjs` | Permanent verifiers for the MySQL baseline, guards and backups |
| `ws-auth-probe.mjs` / `ws-prod-path-test.mjs` / `ws-reconnect-test.mjs` | WebSocket auth, production path, reconnect |
| `loadtest.mjs` / `loadtest-s6.mjs` / `loadtest-200.mjs` / `seed-load-volume.mjs` | Load tests + volume seeding → doc 16 |
| `run-crewdesk-tests.sh` / `crewdesk-real-smoke.mjs` | Crew Desk driver (mock) / the one sanctioned real-API smoke test → doc 18 |
| `cleanup-req001-testdata.mjs` / `check-suite-residue.mjs` | Dry-run-first test-data cleanup / leftover-row check |
| `seed-open-reviews.mjs` / `cleanup-e2e-cases.mjs` / `cleanup-import-demo.mjs` / `clear-login-lock.mjs` | Demo review queues, demo cleanup, login-lock reset |
| `check-db-state.mjs` / `check-overrides.mjs` | Small read-only DB state probes |
| `scan-dead-src.mjs` / `prune-deps.mjs` / `warm-routes.mjs` | Hygiene audits / route warm-up after dev boot |
| `lib/` | Shared helpers: db-guard, suite-cleanup, suite-harness, suite-data, fixture-users, cdp-browser, first-vp, r9-candidates |

## mini-services/notifications

| File | Lines | What it is |
|---|---|---|
| `index.ts` | 118 | socket.io server on :3003 (path `/` — gateway convention) + loopback `POST /notify` on `NOTIFY_PORT` (3004); `auth`/`ping` protocol; graceful shutdown. → doc 12 |
| `package.json` | 10 | `tcms-notifications-ws`, single dep `socket.io`, `bun --hot` dev script |

## src/components/ui — 22 shadcn/ui primitives (only the ones actually used)

`alert, alert-dialog, avatar, badge, button, card, checkbox, dialog, dropdown-menu,
input, label, pagination, popover, scroll-area, select, separator, sheet, skeleton,
sonner, switch, table, tabs, textarea`

(plus `shared/permission-denied.tsx` — the common access-denied guard used by every
permission-gated view). All are standard shadcn/ui Radix wrappers customized only by
the theme tokens in `globals.css`. The never-imported template primitives (accordion,
calendar, carousel, chart, command, form, progress, radio-group, sidebar, toast,
toaster, tooltip, …) were removed in the 2026-09/10 cleanups — re-add any of them
with `npx shadcn@latest add <name>` if a future feature needs one.
