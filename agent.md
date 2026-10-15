# agent.md — Coding Standards & Engineering Contract for TCMS

**This file is binding.** Every task in this repository — new feature, bug fix,
refactor, or cleanup — MUST follow the standards below. AI agents and human
contributors alike: read this file before writing code, and re-read the relevant
section before reviewing. If a change cannot follow a standard, stop and discuss —
do not silently deviate.

**Project:** TCMS (Test Case Management System) — nested module tree, versioned test
cases with step tables, peer-review workflow, bug Kanban, daily task reports, 6-role
RBAC user management, notifications, full audit log.

**Stack:** Next.js 16 (App Router) · React 19 · TypeScript 5 · Tailwind v4 + shadcn/ui ·
Zustand 5 · TanStack React Query 5 · Prisma 6 (client only — all queries are raw SQL) ·
MySQL 8.4 (utf8mb4, strict mode, native JSON columns) · JWT auth (jsonwebtoken +
bcryptjs) · zod validation · optional socket.io mini-service for realtime notifications.
PostgreSQL is retired (2026-10-14 migration) and kept READ-ONLY as rollback source.

**Deep-dive documentation:** `docs/README.md` (study hub, docs 01–14 + PDF guide).

---

## 1. The 14 mandatory coding standards

1. **Consistent naming conventions** — files `kebab-case`; functions/variables
   `camelCase`, verb-first (`listTestCases`, `createBug`, `approveReviewCycle`);
   types/components `PascalCase`; constants `SCREAMING_SNAKE`; booleans read as
   predicates (`isX`, `hasX`, `canX`). DB tables/columns `snake_case`; primary keys are
   named after their entity (`user_id`, `module_id`, `test_case_id`) — never a generic
   `id`.
2. **Names define purpose** — every function/class/component name states the one thing
   it does. If a name needs "and", split the function.
3. **Small, focused units** — one responsibility per function/component. Controllers
   target ≈30–60 lines. Extract when a unit grows past its single idea.
4. **Decoupled, modular features** — each API resource is self-contained in its own
   folder with its own 4 layers; features never reach into each other's internals.
   Cross-resource reads go through that resource's repository/service functions.
5. **DRY** — shared logic is extracted to `src/lib/*`, never copy-pasted. Single
   sources of truth: domain types/enums → `src/types/index.ts`, row serialization →
   `src/lib/serializers.ts`, JSONB reads → `parseJson()` (`src/lib/activity.ts`),
   client HTTP → `src/lib/client/api.ts`, download helper → `src/lib/client/download.ts`,
   CSV parsing → `src/lib/server/csv.ts`.
6. **All DB queries are raw SQL** — every query runs through
   `db.$queryRaw` / `db.$executeRaw` (tagged templates) inside repository files.
   Parameterized tagged templates only:

   ```ts
   // ✅ values become bind parameters — safe
   const rows = await db.$queryRaw<TestCaseRow[]>`
     SELECT test_case_id, title, version FROM test_cases
     WHERE module_id = ${moduleId} AND status <> 'deprecated'`

   // ❌ NEVER — string concat / interpolated user input
   await db.$executeRawUnsafe(`SELECT * FROM test_cases WHERE id = '${id}'`)
   ```

   Dynamic fragments use `Prisma.sql` / `Prisma.join` (`IN (${Prisma.join(ids)})`).
   Search/filter uses `LIKE` (utf8mb4_unicode_ci collation makes it case-insensitive).
   Every UPDATE sets `updated_at = NOW(3)` (Prisma's `@updatedAt` does not apply to
   raw SQL). MySQL has no `RETURNING`: INSERT/UPDATE then SELECT by an app-side
   uuid (`newId()` from `src/lib/server/id.ts`). Aggregates arrive as driver
   bigints — wrap in `Number()` at the repository boundary; booleans are
   TINYINT(1) 1/0 — normalize to real booleans where a consumer compares
   strictly. JSON containment filters use `JSON_CONTAINS(col, CAST(? AS JSON))`;
   JSON writes use `CAST(? AS JSON)`. DDL lives in `prisma/schema.prisma`
   (mysql provider, explicit native types) and is applied ONLY via versioned
   migrations (`prisma/migrations/`, `npx prisma migrate deploy` as the
   DDL-only migrate user) — no db push, no generated setup.sql (deleted
   2026-10-15, task mysql-baseline-1).
   ORM model calls (`db.testCase.create(...)`, etc.) are **forbidden** in application code.
7. **Standard response objects** — responses are built only from
   `src/lib/api.ts`: `ok(data)`, `paginate(...)`, `badRequest(msg, details?)`,
   `unauthorized()`, `forbidden()`, `notFound()`, plus `withApi()` for handler
   wrapping. `ok()` returns the service-shaped payload as-is (single objects
   unwrapped — e.g. login returns the session object with a top-level
   `accessToken`); list endpoints wrap rows with `paginate()` →
   `{ data, page, pageSize, total, totalPages }`. Error shape: always
   `{ error: string, details? }` — meaningful messages, no stack traces,
   never leak `passwordHash` (use `publicUser` shapes from
   `src/lib/serializers.ts`).
8. **Controller → Validation → Service → Repository** — every request flows through
   all four layers, in that order, never skipping one:

   ```
   src/app/api/test-cases/
   ├── route.ts                     # Controller  — HTTP in/out only
   ├── test-cases.validation.ts     # Validation  — zod, one dedicated validator per action
   ├── test-cases.service.ts        # Service     — business logic + orchestration
   └── test-cases.repository.ts     # Repository  — raw-SQL data access, nothing else
   ```

9. **Controllers stay thin** — a controller only: parses the incoming request, invokes
   that action's dedicated validator, invokes that action's dedicated service function,
   maps the result to a response helper. No business rules, no SQL, no data shaping.
10. **Services own business logic** — permission checks (`ensurePermission` /
    `can(role, action)`), ownership checks, soft-delete semantics, version bumps +
    `TestCaseHistory` snapshots, review state machine, activity/notification writes.
    Services never import `NextResponse`/`NextRequest`, never write SQL, and throw
    typed errors (`ApiError`) with meaningful messages.
11. **Repositories are data-access only** — rows/counts in and out; no business
    conditionals, no HTTP concepts. They import the Prisma singleton (`src/lib/db.ts`)
    and speak raw SQL.
12. **Validation before service** — zod schemas run before any business logic so bad
    input never reaches it. Failures return `badRequest(...)` with field-level messages
    (use zod `flatten()`), never raw zod dumps.
13. **Graceful layered error handling** — each layer handles errors at its own level:
    repositories let DB errors propagate; services translate them into typed
    `ApiError`s (400/401/403/404/409) with human messages; controllers map those to the
    standard helpers; `withApi` catches anything unexpected → `500` without leaking
    internals. Client side: `handleApiError(err, fallback)` → toast.
14. **One dedicated validation + service method per controller action** — no
    mega-functions shared across actions. One action = one controller branch + one
    validator + one service function (a service may delegate to another action's
    service when the semantics are truly identical — e.g. CSV import reusing
    `createTestCase` per row — but the action still owns its dedicated entry point).

---

## 2. Non-negotiable domain conventions (breaking these = bugs)

- **Auth flow.** Access JWT (15 min) + refresh JWT (7 days, `RefreshToken` table).
  Client sends `Authorization: Bearer <token>`; token mirrored into cookie
  `tcms-access` for server-side `getCurrentUser()`. On 401: single-flight refresh
  (`POST /api/auth?path=refresh`), retry once. Every route gates through
  `getCurrentUser()` + `can()`/`ensurePermission()`.
- **Login brute-force guard.** 5 failed attempts per email → 429 lock for 60 s
  (`login_attempts` table; success clears the counter). Never bypass.
- **RBAC is matrix-driven.** 6 roles: `viewer < qa_engineer < developer < product <
  manager < vp`. `DEFAULT_PERMISSIONS` (`src/lib/permissions.ts`) + per-cell overrides
  in the `role_permissions` table, toggled at runtime by VP via `/api/permissions`.
  Frontend gates with `useAuthStore.can(action)`; backend re-checks with
  `ensurePermission()` — the UI gate is UX, the backend gate is the law.
- **Soft deletes.** Test cases → `status: 'deprecated'`; users → `isActive: false`;
  module/case deletes restricted by relations; only bugs hard-delete (admin only).
- **Versioning.** Every test-case update bumps `version` and writes a `TestCaseHistory`
  snapshot. Preserve in any edit path.
- **Reviews are cycles.** `ReviewRequest.cycle` + `ReviewEvent` rows drive
  `draft → in_review → approved | needs_revision`. Never bypass the state machine.
- **JSON columns.** Read through `parseJson()` (accepts native objects + legacy
  strings); serialize rows exactly once via `src/lib/serializers.ts`; write
  objects, never pre-stringified JSON (repository casts with `CAST(? AS JSON)`).
- **String enums.** Statuses/priorities/roles are plain strings mirrored in
  `src/types/index.ts`; keep DB defaults, zod schemas, types and UI maps in sync.
- **Frontend state discipline.** Zustand = session/view/notifications only; React Query
  = all server data (staleTime 30 s, retry 1, no refetchOnWindowFocus; dashboard +
  review queues poll 30 s). Reuse the documented query-key inventory (`docs/05 §4`).
  No optimistic updates: mutate → await → invalidate.
- **Feedback.** Success → `toast.success`; errors → `handleApiError`. New client calls
  belong in `src/lib/client/api.ts` namespaced objects — no ad-hoc `fetch` in views.
- **Session tokens.** `getCurrentUser()` accepts BOTH `Authorization: Bearer`
  (primary — what the SPA sends) and the mirrored `tcms-access` cookie
  (fallback). Changing a password revokes ALL of the user's refresh tokens
  (log out everywhere) and emits a `password_changed` notification.
- **Notification channels.** `createNotification()` fans out in-app (DB row,
  gated by `notify_inapp`) + WS broadcast + email/Telegram via
  `src/lib/server/delivery.ts` (gated per user prefs + env: `SMTP_HOST...`,
  `TELEGRAM_BOT_TOKEN`). Delivery never throws and never blocks the caller;
  unconfigured channels are skipped with a log line. The WS broadcast posts
  to the loopback `NOTIFY_PORT` (default 3004) because the public 3003
  listener is engine.io-attached with path `/` (gateway convention) and
  cannot serve plain HTTP.
- **Realtime is optional.** `mini-services/notifications` (socket.io, :3003)
  degrades to refresh-visible delivery when absent — the DB row shows on the
  client's next list fetch (page load / socket reconnect / tab re-visible;
  there are NO polling timers). Never hard-depend on it.

## 3. Definition of done (every task)

A task is **not done** until all of these pass:

1. `npx tsc --noEmit` → 0 errors.
2. `npm run lint` → 0 errors.
3. Verification battery green (server running — `scripts/verify-battery.sh`
   self-boots the MySQL sandbox stack):
   `scripts/verify-battery.sh` (63) · `scripts/run-crewdesk-tests.sh` (5) ·
   `scripts/verify-import.mjs` (33) · plus the feature-specific verifier
   (e.g. `scripts/verify-permission-matrix.mjs`, 165).
4. New/changed endpoints verified for the full status-code set (200/400/401/403/404)
   including the no-permission and no-session cases.
5. Docs updated when behavior changes (`docs/` + this file if conventions evolve) and
   `worklog.md` appended (append-only — never overwrite).
6. The canonical zip `download/tcms-postgresql.zip` refreshed with every changed
   file (the legacy `scripts/tcms-package/` mirror was removed 2026-10-14).

## 4. Task workflow

1. **Plan first:** read `worklog.md` tail + relevant `docs/` section, then state the
   plan (files, layers, endpoints, permissions, verification) before coding.
2. **Permissions:** pick the narrowest existing permission action for a new capability —
   add a new action key only when no existing one matches, and then update the matrix
   docs (`docs/03`) + frontend gates together.
3. **Build backend-first** (validation → service → repository → thin controller),
   then the client call in `lib/client/api.ts`, then the view.
4. **Verify** per §3, including a live browser pass when UI changed.
5. **Log** the task in `worklog.md` (what/why/verification/results).

## 5. Known quirks (documented on purpose — do not "fix" silently)

- Report-view date inputs are cosmetic (client filters lightly); pagination differs per
  view.
- Pages live under `src/app/(app)/` with real routes (`/dashboard`, `/reviews`,
  `/test-cases`, …); the root `/` redirects into the shell. Deep-link filters are
  part of the URL contract (`docs/07`) — never break them silently.
- Platform files that look foreign are load-bearing: `start-dev.sh` + `.zscripts/*` +
  `Caddyfile` + `bun.lock` (bun runtime) + `vercel.json` (crons now empty; keep the
  file for the pipeline) belong to the deployment pipeline — do not delete or rename
  them.
