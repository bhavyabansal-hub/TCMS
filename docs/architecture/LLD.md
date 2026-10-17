# LLD — Low-Level Design

> How the code is built: the four layers, the design patterns in use, caching, logging and
> the page → permission map. The rules themselves are in
> [`../CODING-STANDARDS.md`](../CODING-STANDARDS.md); the big picture is in [`HLD.md`](./HLD.md).

## 1. The four layers (per API resource)

```
src/app/api/<resource>/route.ts              CONTROLLER — parse request, pick the action
                                              (?id= / ?action=), call its validator, call its
                                              service, return a helper response. No rules, no SQL.
src/app/api/<resource>/<resource>.validation.ts  VALIDATION — one zod-backed validate*() per
                                              action; throws ApiError.badRequest with field
                                              errors before any service runs.
src/app/api/<resource>/<resource>.service.ts     SERVICE — business rules, permissions
                                              (requirePermission / ensurePermission), audit,
                                              notifications, orchestration. No SQL.
src/app/api/<resource>/<resource>.repository.ts  REPOSITORY — parameterized raw SQL only
                                              (db.$queryRaw / $executeRaw, Prisma.sql/join).
src/lib/api.ts         withApi() funnel (CSRF, read-only switch, request log, MySQL error
                       mapping) + ok()/paginate() + ApiError factories — the only way a
                       route produces a response.
src/lib/db.ts          the Prisma singleton — the only instantiation site.
src/lib/server/config.ts  the only file that reads process.env.
```

Rules that keep the pipeline clean:

1. The controller decides, never computes — query-param dispatch ends there.
2. Validation runs before the service, so services can trust their input.
3. Each action has its own validator + service function; shared zod schemas are composed.
4. Dependencies point down: services may import another resource's repository; a
   repository never imports a service; nothing but `src/lib/db.ts` creates a client.
5. Transactions are opened in repositories (unit of work); repository functions accept an
   optional `Prisma.TransactionClient`.
6. One response funnel: success = payload (or the `paginate()` envelope); errors =
   `{ error, details? }` from a thrown `ApiError` caught by `withApi()`.

`scripts/audit-standards.mjs` checks these rules on every run (0 violations expected).

## 2. Raw SQL

- Tagged templates only — values are bound parameters; dynamic IN-lists use `Prisma.join`,
  optional filters compose with `Prisma.sql` / `Prisma.empty`. `*Unsafe` is forbidden.
- Columns are `snake_case`; each query declares its row interface next to it.
- Writes stamp `UTC_TIMESTAMP(3)`; no `RETURNING` in MySQL → `insertReturningId()` (INSERT +
  `LAST_INSERT_ID()` on one connection) then SELECT.
- Ids: keys are `INT UNSIGNED AUTO_INCREMENT`; one hook in `src/lib/db.ts` turns numeric `id` /
  `*_id` row values into digit strings, so ids compare equal across rows, URLs, sessions and bodies.
- Schema changes only through `prisma/migrations/` (`npx prisma migrate deploy`).

## 3. Design patterns in use

| Pattern | Where | Why |
|---|---|---|
| **Singleton** | `src/lib/db.ts` (Prisma client on `globalThis` in dev), `src/lib/server/cache.ts` (one store), `src/lib/logger.ts` (one logger), `src/lib/server/config.ts` (one env inventory), the WS service (one process) | One connection pool, one cache, one log stream per process |
| **Repository** | every `<resource>.repository.ts` | Data access in one place, raw SQL, no business rules |
| **Service layer / facade** | every `<resource>.service.ts` | Business rules and orchestration behind one function per action |
| **Cache-aside (read-through) + coalescing** | `withCache(key, ttl, loader)` in `src/lib/server/cache.ts`; used for dashboard aggregates (`stats.service.ts`); the permission matrix keeps its own 3 s cache (`src/lib/permissions.ts`) | Read-heavy shared data from memory; concurrent misses share one loader; `invalidateCache(prefix)` on every write (e.g. `logActivity` clears `stats:`) |
| **Optimistic lock** | `src/lib/server/optimistic-lock.ts`; guarded `UPDATE … WHERE updated_at = ?` in the bug, module, test-case, review and module-review repositories | Two people editing the same row: the second save gets 409 instead of overwriting |
| **Unit of work** | `db.$transaction` opened in repositories (e.g. review submit closes the old review and inserts the new one atomically) | All-or-nothing multi-row changes |
| **Strategy (data-driven RBAC)** | `DEFAULT_PERMISSIONS` + `role_permissions` overrides | Adding a capability is data, not new `if` branches |
| **Fire-and-forget / after-response** | `createNotification()` → WS broadcast (not awaited) + email/Telegram in `after()` | Side channels never slow or fail the request |
| **Guard / fail fast** | startup guard, DB settings guard, validators, `PermissionDenied` views | Refuse bad state early with a clear message |
| **Composition** | React views built from shared parts (`PageHeader`, `PermissionDenied`, badges, `StateLoading`, `PaginationFooter`) | No class hierarchies anywhere |

Also in force: single responsibility (one file per layer per resource), DRY (shared
helpers in `src/lib`), dependency inversion (views depend on `src/lib/client/api.ts`,
services on repository functions), least privilege (every mutating endpoint checks a
permission).

## 4. Caching & load management

**Server**
- Dashboard aggregates: `withCache('stats:aggregates', 5 s)`, cleared by `logActivity`.
- Reference data: module tree rows (`ref:module-tree`) and user-picker rows
  (`ref:user-options`), `REFERENCE_CACHE_TTL_MS` (30 s); `logActivity` clears the whole `ref:`
  prefix after every write (seed clears it too). A load that overlapped an invalidation is
  returned but not stored (generation counter in `cache.ts`).
- The session check (`GET /api/auth`), login and register re-read the permission table (it is
  small): the 3 s cache is per route module copy, so only a fresh read shows a VP toggle at once.
- Permission matrix: in-memory, 3 s TTL, reloaded after a toggle on this instance.
- Crew Desk user list: ~10 min TTL + refresh once on miss.
- Pool bounded by `DATABASE_URL` (`connection_limit`, `pool_timeout`): a busy instance
  queues and then answers 503 "The server is busy" instead of opening unbounded connections.
- Graceful shutdown: `src/instrumentation-node.ts` closes the pool on SIGTERM/SIGINT (3 s cap).

**Client (React Query)**
- Defaults: `staleTime 30 s`, `retry 1`, `refetchOnWindowFocus false`.
- Reference data (`['modules','tree']`, `['users','options']`): `REFERENCE_STALE_TIME_MS`
  (5 min); mutations invalidate the owning keys.
- Boot prefetch: `['stats','dashboard']` in parallel with the session check, only when `/dashboard` is opened.
- Paged lists use `placeholderData: keepPreviousData`.
- Pickers use light endpoints (`GET /api/test-cases?action=options`, `/api/bugs?action=options`:
  id + title only); `/api/modules` sends each module once (the client builds the tree).
- Boot prefetch only for the dashboard stats, and only when `/dashboard` is opened; the
  cross-account cache clear runs only when one real user changes to another.
- Checked per page and role by `scripts/verify-page-apis.mjs`: no duplicate call, no 401/403
  call, at most 2 loading phases, p95 < 300 ms per call (run it against a production build —
  dev mode adds 100–900 ms per request).
- Polling only where needed and permission-gated (dashboard stats; review-queue badges
  only for users who can review).
- The whole cache is cleared when the signed-in user changes (`providers.tsx`).
- No optimistic updates: mutate → await → invalidate the affected keys.

## 5. Logging

- `src/lib/logger.ts`: `[tcms] <iso> <LEVEL> <message> {meta}` to the console, rotating
  files (`logs/app-YYYY-MM-DD.log`, `logs/error-YYYY-MM-DD.log`, kept `LOG_RETENTION_DAYS`
  = 14) and optionally a Telegram logs bot (`TELEGRAM_LOG_*`, batched). Logging never
  breaks a request.
- `withApi` logs every request with its latency: fast successful reads at `debug` (dev only),
  writes at `info`, requests slower than `TCMS_SLOW_REQUEST_MS` (1 s) at `warn`, and every error.
  Info/debug lines are written to the files asynchronously in batches; error lines synchronously.
- `prisma:query` lines only with `TCMS_LOG_SQL=true`.
- `src/instrumentation-node.ts` sends `unhandledRejection` / `uncaughtException` to the
  same logger (crash behaviour kept).
- Audit trail is data: every write → an `activity_logs` row (actor, action, entity,
  before/after, diff).
- Human logs: [`../worklog.md`](../worklog.md) (append-only, per task) and
  [`../CHANGELOG.md`](../CHANGELOG.md) (user-facing).

## 6. Page → permission map

| Route | Client gate | API gate (authoritative) |
|---|---|---|
| `/login` | public | auth endpoints only |
| `/dashboard`, `/modules`, `/modules/[id]`, `/test-cases`, `/bugs`, `/tasks`, `/wiki`, `/notifications`, `/settings/profile` | signed in (AppShell) | `requireUser()`; actions gated per permission |
| `/test-cases/[id]`, `/wiki/[id]` | edit/delete buttons per `can()` | service rules per action |
| `/reviews`, `/reviews/[id]`, `/module-reviews/[id]` | `canAny(perform_review, submit_review)` + `PermissionDenied` | own queue for everyone; lists/details need `perform_review`; verdicts need the assigned reviewer |
| `/reports` | `view_all_task_reports` | same permission |
| `/activity-log` | `view_activity_logs` | same permission |
| `/integrations` | `manage_integrations` | same permission on every Crew Desk endpoint |
| `/settings/users` | `manage_users` | same permission; role changes VP only |
| `/settings/permissions` | `manage_permissions` | same permission |
| all `(app)` pages | — | `src/proxy.ts` redirects anonymous page hits to `/login?next=` |

Client gates are UX; the API is the security boundary. A new page needs both, plus a row
here and in [`auth-and-permissions.md`](./auth-and-permissions.md) §6.
