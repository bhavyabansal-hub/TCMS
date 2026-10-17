# TCMS Coding Standards — the one rules file

**Binding for every change** (feature, bug fix, refactor, cleanup), for AI agents and people.
§1 is the owner's wording, word for word. §2–§8 are the concrete TCMS rules that put §1 into
practice. If a change cannot follow a rule, stop and ask — never deviate silently.

**Stack:** Next.js 16 (App Router) · React 19 · TypeScript 5 · Tailwind v4 + shadcn/ui ·
Zustand 5 · TanStack React Query 5 · Prisma 6 (client only — all queries are raw SQL) ·
MySQL 8.4 (utf8mb4, strict mode, native JSON) · JWT in httpOnly cookies · zod 4 ·
optional socket.io mini-service. MySQL is the only database (decision D1); production
starts empty + `scripts/create-first-vp.mjs` (D2).

---

## 1. The owner's coding standards (word for word)

- Follow consistent naming conventions for files, variables, and functions.
- Every function/class name should define its purpose clearly.
- Keep functions and components small and focused on a single responsibility.
- Every feature should be decoupled and modular, promoting reusability and maintainability.
- USE DRY (Don't Repeat Yourself) principles to avoid code duplication.
- All DB Queries must be raw SQL queries.
- Use Standard helper response objects for API responses to maintain consistency.
- Use Controller->validation->service->repository pattern to organize the flow of data and business logic consistently.
- The controller will just handle the incoming request, invoke the appropriate validation and service methods, and return the response.
- The service layer contains the core business logic and orchestrates calls to the repository layer.
- The repository layer is responsible for direct data access, such as database queries, and should not contain business logic.
- Validation should be performed before reaching the service layer to ensure data integrity and prevent unnecessary processing.
- Any errors or exceptions should be handled gracefully at the appropriate layer, with meaningful messages returned to the client.
- Each controller function must have their own dedicated validation and service methods to ensure separation of concerns and maintainability.
- Proper routes for every page and same wise its permissions.
- Keep the docs folder updated with every new requirement and change; maintain proper logs and worklogs.
- Use basic and best LLD principles to make the application stable and fast.
- Use proper caching, load management and the singleton pattern.

---

## 2. Code rules (how §1 is applied in TCMS)

1. **Naming** — files `kebab-case`; functions/variables `camelCase`, verb-first
   (`listTestCases`, `createBug`); types/components `PascalCase`; constants
   `SCREAMING_SNAKE`; booleans read as predicates (`isX`, `hasX`, `canX`). DB tables and
   columns `snake_case`; primary keys are named after their entity (`user_id`,
   `module_id`, `test_case_id`) — never a generic `id`.
2. **Names define purpose** — a name states the one thing a unit does. If it needs "and", split it.
3. **Small units** — one responsibility per function/component; controllers ≈30–60 lines.
4. **Modular features** — each API resource is one folder with its own four layers
   (`src/app/api/<resource>/`). Features never reach into each other's internals; a
   cross-resource read goes through that resource's repository or service function.
5. **DRY** — shared logic lives in `src/lib/*`. Single sources: domain types/enums →
   `src/types/index.ts`; row serialization → `src/lib/serializers.ts`; JSON reads →
   `parseJson()` (`src/lib/activity.ts`); client HTTP → `src/lib/client/api.ts`; CSV
   parsing → `src/lib/server/csv.ts`; CSV export → `src/lib/csv-export.ts`; roles →
   `src/lib/roles.ts`; env → `src/lib/server/config.ts` (the only file that reads `process.env`).
6. **Raw SQL only** — every query is a tagged template (`db.$queryRaw` / `db.$executeRaw`)
   inside a repository file; values are always bound parameters:

   ```ts
   // ✅ values become bind parameters — safe
   const rows = await db.$queryRaw<TestCaseRow[]>`
     SELECT test_case_id, title, version FROM test_cases WHERE module_id = ${moduleId}`

   // ❌ NEVER — string concat / interpolated user input / *Unsafe
   await db.$executeRawUnsafe(`SELECT * FROM test_cases WHERE id = '${id}'`)
   ```

   Dynamic fragments use `Prisma.sql` / `Prisma.join`. Search uses `LIKE`
   (`utf8mb4_unicode_ci` makes it case-insensitive). ORM model calls
   (`db.testCase.create(...)`) are forbidden in application code.
7. **Standard responses** — only the helpers in `src/lib/api.ts`: `ok(data)`,
   `paginate(...)` → `{ data, page, pageSize, total, totalPages }`, `ApiError`
   (`badRequest` / `unauthorized` / `forbidden` / `notFound` / `conflict`), all inside
   `withApi()`. Error shape is always `{ error, details? }`: meaningful message, no stack,
   no SQL text, never a password hash (use the `publicUser` shapes).
8. **Controller → Validation → Service → Repository**, in that order, never skipping one:

   ```
   src/app/api/test-cases/
   ├── route.ts                     # Controller  — HTTP in/out only
   ├── test-cases.validation.ts     # Validation  — zod, one validator per action
   ├── test-cases.service.ts        # Service     — business rules + orchestration
   └── test-cases.repository.ts     # Repository  — raw SQL, nothing else
   ```

9. **Thin controllers** — parse the request, call that action's validator, call that
   action's service function, return a response helper. No rules, no SQL, no shaping.
10. **Services own the rules** — permission checks (`ensurePermission` / `can()`),
    ownership checks, version bumps + history snapshots, the review state machine,
    activity and notification writes. Services never import `NextRequest`/`NextResponse`,
    never write SQL, and throw `ApiError` with meaningful messages.
11. **Repositories are data access only** — rows and counts in and out; no business
    conditionals, no HTTP. They import the `db` singleton and accept an optional
    transaction client. Transactions are opened in repositories (unit of work).
12. **Validation before the service** — zod runs first; failures return 400 with
    field-level messages (`flatten()`), never raw zod dumps. Update schemas re-declare
    defaulted fields as `.optional()` so a partial update never resets unsent fields.
13. **Errors per layer** — repositories let DB errors propagate; `withApi` maps MySQL
    errors through `src/lib/server/db-errors.ts` (duplicate → 409, FK → 400, DB down →
    503, …) and anything unexpected → 500 without internals. Client: `handleApiError(err, fallback)` → toast.
14. **One validator + one service function per controller action** — no mega-functions.
15. **API changes are additive** — never remove or rename a response field in the same release
    that stops using it: browser tabs still run the previous client (owner bug 2026-10-17,
    `/modules` crashed when `tree` left `GET /api/modules`). Add the new field, switch the
    client, mark the old one `@deprecated`, remove it in a later release (backlog). Client code
    reads optional API data defensively (`data?.list?.length`).

---

## 3. Domain conventions (breaking these = bugs)

- **Session.** Access JWT (15 min) in the httpOnly cookie `tcms-access`, refresh JWT
  (7 days, `refresh_tokens` table) in `tcms-refresh` (path `/api/auth`). The SPA sends
  `X-Requested-With: tcms` on every call (CSRF marker). On 401: one single-flight refresh,
  then retry once. Changing a password revokes every refresh token of the user.
- **Sign-in protection.** 5 failed attempts per email → 60 s lock (`login_attempts`);
  plus a per-IP failed sign-in limit (429). Never bypass.
- **RBAC is matrix-driven.** Roles `viewer < qa_engineer < developer < product < manager
  < vp`. `DEFAULT_PERMISSIONS` (`src/lib/permissions.ts`) + per-cell overrides in
  `role_permissions`, toggled at runtime by the VP. 21 actions × 6 roles = 126 cells. Only
  a VP sets or changes roles, never their own (`canAssignRoles`). UI gates are UX; the
  service check is the law.
- **Deletes.** Test cases, bugs and wiki documents are hard-deleted; a module delete
  cascades submodules and module reviews and sets `module_id` NULL on cases and bugs;
  users are deactivated (`is_active = false`), never deleted (decision D12).
- **Versioning.** Every test-case update bumps `version` and writes a `test_case_history` snapshot.
- **Reviews are cycles.** `review_requests.cycle` + `review_events` drive
  `draft → in_review → approved | needs_revision`; one open review per case (a resubmit
  closes the old one); cases in review or approved cannot be submitted again.
- **Concurrent edits.** Saves send the loaded `expectedUpdatedAt`; a stale save answers
  409 "This item was changed by someone else — reload" (`src/lib/server/optimistic-lock.ts`).
- **JSON columns.** Read through `parseJson()`, serialize once via `src/lib/serializers.ts`,
  write objects with `CAST(? AS JSON)`.
- **String enums.** Statuses/priorities/roles are strings mirrored in `src/types/index.ts`;
  keep DB defaults, zod schemas, types and UI maps in sync.
- **Frontend state.** Zustand = session, view, notifications only; React Query = all server
  data. No optimistic updates: mutate → await → invalidate only the affected keys.
  Success → `toast.success`; errors → `handleApiError`. New client calls go into
  `src/lib/client/api.ts` — no ad-hoc `fetch` in views.
- **Notifications.** `createNotification()` writes the DB row, then fans out (WS broadcast
  and email/Telegram) without ever blocking or failing the request. The WS service is
  optional: without it delivery is refresh-visible.

---

## 4. Routes, performance, caching, logging, schema

- **Route + permission per page.** Every page is a real route under `src/app/(app)/...`.
  A page that needs a permission checks `useAuthStore.can(action)` and renders
  `PermissionDenied` without it; the sidebar shows the link only with the permission; the
  page's API calls `ensurePermission`. The page → permission map is in
  [`architecture/LLD.md`](./architecture/LLD.md) §6 and the endpoint map in
  [`architecture/auth-and-permissions.md`](./architecture/auth-and-permissions.md) §6 —
  update both when routes or permissions change. A page never calls an API it is sure
  to get 403 from: check the permission first.
- **Singletons.** One Prisma client per process (`src/lib/db.ts`), one cache store
  (`src/lib/server/cache.ts`), one logger (`src/lib/logger.ts`), one config module
  (`src/lib/server/config.ts`). Never instantiate a second one.
- **Pool.** Bounded through `DATABASE_URL` (`connection_limit`, `pool_timeout`).
- **Caching (cache-aside).** Cache only read-heavy, shareable data through `withCache(key,
  ttl, loader)`; every write path that changes it calls `invalidateCache(prefix)`. Never
  cache per-user secrets or failed loads. Client: React Query with a sensible
  `staleTime`; reference data uses the longer `REFERENCE_STALE_TIME_MS`.
- **Load.** Lists are paginated with a server-side cap; independent queries run in
  parallel (`Promise.all`); no N+1 loops; a new filter/sort column gets an index through
  a migration.
- **Logging.** Only `src/lib/logger.ts` (console + `logs/app-*.log` + `logs/error-*.log`,
  rotated, `LOG_RETENTION_DAYS`). Log business events with ids, never secrets.
  `prisma:query` lines only with `TCMS_LOG_SQL=true`. Every write is also an
  `activity_logs` row through `logActivity()`. Node-only boot code lives in
  `src/instrumentation-node.ts` (loaded only in the Node runtime).
- **Time.** Every raw-SQL write sets `created_at` / `updated_at` with `UTC_TIMESTAMP(3)` —
  never `NOW()` (decision D7). No `INSERT IGNORE`; duplicates use `ON DUPLICATE KEY UPDATE`.
  MySQL has no `RETURNING`: INSERT with an app-side id (`newId()`), then SELECT.
  Aggregates arrive as bigints → `Number()`; TINYINT(1) → real booleans.
- **Schema changes.** Edit `prisma/schema.prisma` **together with** a new migration in
  `prisma/migrations/`; apply with `npx prisma migrate deploy`, never `db push` (D4).
  Collation `utf8mb4_unicode_ci`; `utf8mb4_bin` for secret columns.

---

## 5. Definition of done (every task) — the single source

**Must pass on the owner's Windows machine:**

1. `npx tsc --noEmit` → 0 errors.
2. `npx eslint .` → 0 errors.
3. `npm run build` → succeeds (in a separate folder copy when the dev server is running).
4. `node scripts/verify-import.mjs` → 0 failed.
5. `node scripts/verify-permissions.mjs` → 0 failed.
6. `node scripts/verify-notifications.mjs` → 0 failed.
7. `node scripts/verify-review-matrix.mjs` → `36 passed, 0 failed`.

Also run `node scripts/audit-standards.mjs` (report only). UI changes: also
`verify-ui-gates.mjs`; page data or API changes: also `verify-page-apis.mjs` (against a
production build in a folder copy, `TCMS_BASE_URL`). Linux-only suites (`scripts/*.sh`, infra `*-test.mjs`) are reported
as **NOT RUN ON WINDOWS** (backlog B11).

**And for every change:** endpoints checked for 200/400/401/403/404 (incl. no session, no
permission); new behaviour covered by an automated test; route/permission maps updated;
affected docs updated; one entry appended to [`docs/worklog.md`](./worklog.md) (append-only:
what, why, files, test results, NOT VERIFIED); [`CHANGELOG.md`](./CHANGELOG.md) for
user-visible changes.

---

## 6. Task workflow and commits

1. Follow the WORKING METHOD in [`CLAUDE.md`](../CLAUDE.md) (read first, `TASK-CHECKLIST.txt`, docs + worklog after).
2. Pick the narrowest existing permission for a new capability; add a new action only
   when none fits, then update the matrix docs and the frontend gates together.
3. Build backend-first (validation → service → repository → thin controller), then the
   client call in `src/lib/client/api.ts`, then the view.
4. Verify per §5 (a browser pass when UI changed).
5. Commit small, one logical change per commit, message starting with `REQ-<NNN>`,
   `BUG-<NNN>`, `FIX:`, `PERF:` or `MAINT:`. Never rewrite history (D9). Never push — the
   owner pushes. Commit only code, scripts and ONE summary report per task; raw test
   output and evidence files stay out of git.

---

## 7. Known quirks (documented on purpose — do not "fix" silently)

- Report-view date inputs are cosmetic; pagination differs per view.
- Deep-link filters on `/test-cases` (`?moduleId=&status=&priority=&q=`) are part of the
  URL contract ([`guides/modules-and-test-cases.md`](./guides/modules-and-test-cases.md)).
- `output: "standalone"` in `next.config.ts` stays (production runs `.next/standalone/server.js`).
  The WS service keeps its own `mini-services/notifications/bun.lock`.

---

## 8. Environment rules (every session)

- **Database:** only MySQL 8.4 at `127.0.0.1:5500`, schema `tcms_test`. **Never connect to
  port 3306** (a different company server) or any other database.
- **Windows:** the owner's machine is Windows 11 ([`deploy/local-setup-windows.md`](./deploy/local-setup-windows.md)).
  New scripts are cross-platform Node (`fileURLToPath`, `path.join`); no `/tmp`, `/proc`,
  `ss`. Existing `.sh` scripts are Linux-only.
- **The dev server** on :3000 (`npm run dev`) is the owner's — never stop it; editing
  `next.config.ts` restarts it.
- **Secrets:** never read, print or edit `.env` values; never put passwords in docs or logs.
