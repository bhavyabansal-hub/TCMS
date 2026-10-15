# 13 · File Index — every file, explained

> One entry per project file (line counts approximate). Grouped by directory; "→ doc"
> points at the deep-dive document. shadcn/ui primitives are grouped at the end since
> they are template stock.

---

## Root & configuration

| File | Lines | What it is |
|---|---|---|
| `package.json` | — | Scripts (`dev/build/start/lint`, `postinstall: prisma generate`, `db:*`), every dependency pin. → doc 01 §2 |
| `package-lock.json` | — | Reproducible install for Vercel |
| `tsconfig.json` | — | TypeScript config (`@/*` → `src/*` path alias) |
| `next.config.ts` | — | `output: "standalone"` (required by the deploy pipeline), `ignoreBuildErrors: false` (type errors never pass) |
| `vercel.json` | — | Vercel Cron schedule: daily `GET /api/keep-alive` (anti-pause ping for free-tier databases). → doc 12 §3 |
| `tailwind.config.ts` | — | Legacy-style theme mapping (v4 CSS-first lives in globals.css) |
| `postcss.config.mjs` | — | Tailwind v4 postcss plugin |
| `eslint.config.mjs` | — | Flat ESLint config (next/core-web-vitals) |
| `components.json` | — | shadcn/ui generator settings |
| `agent.md` | — | **Canonical coding standards + agent contract** (layered API pattern, raw SQL rule, response helpers, naming, definition of done). Read before writing any code |
| `CLAUDE.md` | — | Thin pointer to `agent.md` for AI coding assistants (kept so tooling that auto-reads it finds the standards) |
| `.gitignore` | — | Keeps `.env*`, `/db/`, build output out of Git |
| `.env.example` | — | Documented template for the 3 env vars |
| `README.md` | — | Project overview + quick start |
| `worklog.md` | — | Append-only engineering log: every task, decision and verification result |
| `docs/` | — | Study hub: docs 01–14, compiled PDF guide, deployment + refactor reports (see `docs/README.md`) |

## prisma/

| File | Lines | What it is |
|---|---|---|
| `schema.prisma` | 324 | The 14 models, relations, MySQL JSON columns, indexes. → doc 02 |
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

## src/app/api — 13 route handlers (→ doc 04)

| File | Lines | Endpoints |
|---|---|---|
| `route.ts` | 4 | `GET /api` health check |
| `auth/route.ts` | 199 | register / login / refresh / logout / me / profile / password |
| `seed/route.ts` | 287 | Idempotent demo-data seeder (GET+POST; GET added for browser seeding) |
| `keep-alive/route.ts` | REMOVED 2026-10-14 with the MySQL migration (MySQL has no free-tier pause; health is `GET /api`) |
| `stats/route.ts` | 67 | `?action=dashboard` (6 parallel aggregates) / `?action=reports` (lead/admin) |
| `modules/route.ts` | 332 | tree/detail/create/update/delete + `?action=submit-review` (module review orchestration) |
| `test-cases/route.ts` | 84 | list/detail/history/reviews + create + versioned update + `?action=submit-review` + soft delete + **`?action=import-template` / `?action=import` (CSV bulk import)** → doc 14 |
| `reviews/route.ts` | 227 | queue / all / detail + **verdict** (status machine + module aggregation) |
| `module-reviews/route.ts` | 191 | queue / all / detail + `?action=approve-all` |
| `bugs/route.ts` | 243 | list/detail/links + create + update (resolvedAt stamping) + link-tc + admin-only hard delete |
| `task-reports/route.ts` | 227 | my / summary / list / upsert-by-date / owner-only update |
| `activity-logs/route.ts` | 75 | filtered audit list + per-entity / per-user branches |
| `notifications/route.ts` | 63 | list / read-all / read-one / delete (all user-scoped) |
| `users/route.ts` | 146 | admin-only CRUD (invite, role, activate, soft delete) |

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
| `dashboard-v2.tsx` | — | `dashboard` | QA Command Center (live /dashboard); the classic `dashboard.tsx` is archived in `archive/src/` |
| `modules.tsx` | 511 | `modules` | Module tree browser, create/delete, submit module for review |
| `test-cases.tsx` | 411 | `test-cases` | Filterable table, create dialog (steps editor), CSV export |
| `test-case-detail.tsx` | 626 | `test-case-detail` | Read/edit modes, steps table, submit for review, PERMANENT delete (confirm), history/reviews/activity panels |
| `test-case-import.tsx` | 246 | `test-cases` (tab) | Import CSV panel: module picker, template download, upload + per-row result card → doc 14 |
| `reviews.tsx` | 253 | `reviews` | Module-review / single-case / all-reviews queues with overdue detection |
| `review-detail.tsx` | 347 | `review-detail` | Read-only case + verdict dialog (flagged fields, mandatory comment) |
| `module-review-detail.tsx` | 415 | `module-review-detail` | Bulk workspace: stats, expandable cases, per-case verdicts, Approve All |
| `bugs.tsx` | 492 | `bugs` | dnd-kit Kanban + table, create dialog, detail sheet with inline edit |
| `tasks.tsx` | 546 | `tasks` | Daily report editor (task lines, entity links), manager user-switch, CSV export |
| `reports.tsx` | 418 | `reports` | Team weekly hours + status/priority/bug charts (lead/admin), print-to-PDF |
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

## src/store & src/types

| File | Lines | What it is |
|---|---|---|
| `store/index.ts` | 142 | Zustand: `useAuthStore` (session), `useViewStore` (router replacement), `useNotificationsStore`. → doc 05 §2 |
| `types/index.ts` | 245 | All domain types & string-enum unions shared by views (`TestCase`, `ReviewRequest`, `Paginated<T>`, …) |

## scripts/ — verification battery & ops tooling

| File | What it is |
|---|---|
| `start-tcms.sh` | Idempotent stack launcher: MySQL 8.4 wiring via `scripts/mysql-env.sh` (repair-only .env self-heal) + WS mini-service (:3003) + Crew Desk mock (:3010) + Next.js (:3000, production build by default — `TCMS_DEV=1` for dev); PG :5499 stays bootable as READ-ONLY drill source |
| `dev-with-pg.mjs` | `npm run dev` wrapper — boots/awaits the sandbox DB, then `next dev` |
| `verify-battery.sh` | 23 checks — end-to-end API sweep (health, seed, auth, CRUD, reviews, bugs, reports, notifications, stats, leak scan) |
| `verify-rbac.sh` | Archived (PG-era, uses psql): `archive/postgres/scripts/` |
| `verify-permissions.mjs` | 29 checks — matrix defaults, override toggle round-trip, cache invalidation |
| `verify-review-matrix.mjs` | 36 checks — review endpoints per role (participation gating included) |
| `verify-import.mjs` | 32 checks — CSV template + import happy path, per-row errors, auth/permission/validation failures → doc 14 |
| `verify-notifications.mjs` | 28 checks — Bearer auth, password-change validation + refresh-token revocation + security notification, channel prefs persistence, ownership scoping, bug-assign delivery |
| `migrate-rbac.mjs` | Archived (PG-era): `archive/postgres/scripts/` |
| `seed-open-reviews.mjs` | Seeds demo review queues for manual testing |
| `cleanup-e2e-cases.mjs` / `cleanup-import-demo.mjs` | Remove test/demo artifacts after verification runs |
| `clear-login-lock.mjs` | Reset the brute-force lock counter for a demo account |
| `check-db-state.mjs` / `check-overrides.mjs` (`probe-rbac-state.mjs` archived in `archive/postgres/scripts/`) | Small read-only DB state probes used while debugging |
| `pg-sandbox/` | Embedded PostgreSQL sandbox (git-ignored; exists only on the Linux sandbox, not in this repo); READ-ONLY rollback source — the app never connects to it |
| `scan-dead-src.mjs` / `prune-deps.mjs` | Hygiene audits: unused src files / unused npm dependencies |

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
