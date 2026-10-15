# 15 — Coding Standards & LLD (Low-Level Design)

> Living document. Every claim below is verified against the codebase (audit of
> 2026-10-01). When new code lands, keep this map accurate — it is the contract
> that reviews are checked against.

## 1. The layered request pipeline (Controller → Validation → Service → Repository)

```
src/app/api/<domain>/route.ts        ← CONTROLLER: parse request, pick action,
                                       call validator, call service, return helper
                                       response. NO business logic, NO SQL, NO db import.
src/app/api/<domain>/<domain>.validation.ts   ← VALIDATION: one zod-backed validate*()
                                       per endpoint/action; throws ApiError.badRequest
                                       with flattened field errors BEFORE any service runs.
src/app/api/<domain>/<domain>.service.ts      ← SERVICE: business rules, permissions
                                       (requirePermission/ensurePermission), audit log,
                                       notifications, orchestration. NO SQL, NO db import.
src/app/api/<domain>/<domain>.repository.ts   ← REPOSITORY: data access ONLY —
                                       parameterized raw SQL (db.$queryRaw /
                                       $executeRaw with Prisma.sql/Prisma.join).
                                       No business rules, no HTTP.
src/lib/api.ts                       ← RESPONSE HELPERS: withApi() error funnel,
                                       ok()/paginate() success builders, ApiError
                                       factories (badRequest/unauthorized/forbidden/
                                       notFound/conflict). The ONLY way any route
                                       produces a response.
src/lib/db.ts                        ← SINGLETON Prisma client (globalThis cache).
                                       Exactly one instantiation site in the codebase.
src/lib/server/config.ts             ← CENTRAL ENV INVENTORY: the ONLY file allowed
                                       to read process.env. Every deployment knob is
                                       declared once (name, default, why) and imported
                                       as `import { … } from '@/lib/server/config'`.
                                       Import-free module so any layer can use it.
```

**Verified audit results (2026-10-01):** all 16 route files / 39 handlers follow the
pipeline; zero routes import `db`/repositories; zero services run SQL (the single
historical exception — `seed.service.ts` opening `$transaction` — was fixed by moving
the unit-of-work wrapper `runSeedInTransaction()` into `seed.repository.ts`); all 19
repository files are 100% parameterized raw SQL (0 ORM model calls, 0
`$queryRawUnsafe`/`$executeRawUnsafe` — grep-verified).

### Rules that keep the pipeline clean

1. **The controller decides, never computes.** Query-param dispatch (`?action=`) and
   body shapes end at the controller; everything after the validator call is service
   vocabulary.
2. **Validation happens before the service**, both for sanity (400s with field errors)
   and so services can trust their inputs.
3. **Each endpoint gets its own validator + service function** (39 handlers, 15
   validation files, one `validate*` per endpoint/action). Shared zod schemas are
   composed, not duplicated.
4. **Cross-domain reads go service → repository.** Services may import another
   domain's repository (documented in `reviews.repository.ts` header) but repositories
   never import services, and nothing outside `src/lib/db.ts` instantiates a client.
   Direction is always downward.
5. **Transactions are opened in repositories** (unit of work). `seed.repository.ts →
   runSeedInTransaction(cb)` is the template; repository functions accept an optional
   `Prisma.TransactionClient`.
6. **One response funnel.** Success = payload (or `paginate()` envelope for lists);
   errors = `{ error, details? }` via thrown `ApiError` caught by `withApi()`. Zod
   failures become 400 + flattened field errors automatically. The client
   (`lib/client/api.ts`) is written against exactly this contract.

## 2. Raw SQL rules

- Every statement is a tagged template (`db.$queryRaw\`...\`` / `$executeRaw`) — values
  are always bound parameters, never string-concatenated. Dynamic IN-lists use
  `Prisma.join`; optional filters compose with `Prisma.sql`/`Prisma.empty`.
- `$queryRawUnsafe` / `$executeRawUnsafe` are forbidden (lint-review enforced; zero
  occurrences today).
- Column names are snake_case (DB truth) mapped to camelCase row interfaces declared
  per query in `types/sql-rows.ts` or beside the query.
- Migrations live in `prisma/` (see `prisma/migrations/`); repositories never
  mutate schema.

## 3. LLD principles in force

| Principle | Where it shows up |
|---|---|
| **Single Responsibility** | one file per layer per domain; view components compose shared building blocks; `withApi` exists so no route repeats error plumbing |
| **DRY** | shared `PermissionDenied` guard (7 views), shared badges (`shared/badges.tsx`), shared formatters/palettes (`lib/format.ts`), shared `qs()` query builder + `writeAccessCookie()` in the client API, shared `StateLoading`/`QueryErrorAlert`/`PaginationFooter`, shared date helpers (`todayISO`/`isoDaysAgo`) |
| **Open/Closed** | permission matrix is data (role_permissions rows + 3s server cache), not code — adding a capability needs no new conditionals |
| **Dependency Inversion** | views depend on `lib/client/api.ts` abstractions; services depend on repository functions; the prisma client is injected into repositories as an optional `client` param (enables transaction pass-through) |
| **Singleton** | `src/lib/db.ts` (globalThis pattern, one instantiation); the TTL cache store (`src/lib/server/cache.ts`); WS mini-service is a single process on :3003 |
| **Composition over inheritance** | React component composition (`PageHeader` + `PermissionDenied` + shared badges); no class hierarchies anywhere |
| **Fail fast, degrade gracefully** | validators throw before services run; `withApi` maps every throw to a meaningful status; React error boundaries (`global-error.tsx`, `(app)/error.tsx`) catch render crashes; `AuthGate` keeps tokens on transient failures and shows a retry card instead of logging the user out |
| **Program to interfaces** | TypeScript row interfaces per query, endpoint response types in `@/types`, typed API namespace objects |
| **Least privilege** | every mutating endpoint calls `requirePermission()`; viewer role has read-only matrix; reviews are participant-scoped server-side |
| **One source of config** | `process.env` is read ONLY in `src/lib/server/config.ts` (grep-verified); every other module imports typed constants with documented defaults — no magic strings, no scattered fallbacks |

## 4. Caching & load management

**Server**
- RBAC permission cache: in-memory, 3s TTL (`src/lib/permissions.ts`) — matrix toggles
  apply almost immediately without a per-request DB hit.
- Generic TTL cache with request coalescing (`src/lib/server/cache.ts`): concurrent
  misses share ONE loader promise; bounded at 500 entries; write paths invalidate by
  prefix (e.g. `logActivity` keeps stats aggregates fresh).
- Crew Desk user-list cache: ~10-min TTL + refresh-once-on-miss + 24h per-user
  re-check (`crewdesk.identity.ts`) — verification without hammering Crew Desk.
- Prisma connection pool is bounded by the DATABASE_URL (`connection_limit=40&pool_timeout=10`
  in the sandbox starter) so a busy instance queues instead of opening unbounded
  connections. Server-side guards: MySQL `max_connections` (sandbox 200; ask IT for prod) and Prisma
  `idle_in_transaction_session_timeout=10s` are set at DATABASE level, so a runaway
  query or a leaked transaction can never choke the pool. Shutdown is graceful:
  `src/instrumentation.ts` closes the pool on SIGTERM/SIGINT (3s cap) so a redeploy
  never strands connections.

**Client (React Query)**
- Global defaults: `staleTime: 30s`, `retry: 1`, `refetchOnWindowFocus: false`.
- Reference data (`['modules','tree']`, `['users','options']`): `REFERENCE_STALE_TIME_MS`
  = 5 min (defined once in `lib/client/api.ts`) — mutations invalidate the owning roots,
  so the longer cache is safe.
- Boot prefetch warms `['stats','dashboard']` + `['modules','tree']` in parallel with
  the session check → first paint without skeleton flash.
- Paginated/filterable lists use `placeholderData: keepPreviousData` (no page-flicker).
- Polling is deliberate and permission-gated: dashboard stats 30s; sidebar review
  queues 30s ONLY for users who can perform/submit reviews (viewers never poll).
- Cross-account safety: the whole query cache is cleared during render when the signed-in
  user changes (`providers.tsx`) so one user's data can never flash into the next session.
- No optimistic updates (by choice): mutations invalidate and refetch — simpler, always
  consistent with the audit log.

## 5. Logging

- **Structured app logger**: `src/lib/logger.ts` — level-tagged lines
  (`[tcms] <iso-time> <LEVEL> <message> {meta}`) with THREE transports, all
  failure-isolated so logging can never break a request:
  1. **console** — always;
  2. **rotating files** — `logs/app-YYYY-MM-DD.log` (info+) +
     `logs/error-YYYY-MM-DD.log` (errors only), retention
     `LOG_RETENTION_DAYS` (default 14), one daily sweep;
  3. **Telegram LOGS BOT** — when `TELEGRAM_LOG_BOT_TOKEN` +
     `TELEGRAM_LOG_CHAT_ID` are set, lines at `TELEGRAM_LOG_LEVEL`+ are
     mirrored to the owner's dedicated log chat (batched, at most one message
     per `TELEGRAM_LOG_MIN_INTERVAL_MS`, oversized batches keep the newest
     lines + a suppression counter). This is a SEPARATE bot from the
     user-notification `TELEGRAM_BOT_TOKEN`.
- **Process-level capture**: `src/instrumentation.ts` funnels
  `unhandledRejection`/`uncaughtException` into the same logger (crash
  behaviour preserved), so global failures reach Telegram too.
- Services log business milestones; `withApi` logs every request line with
  latency and every unhandled exception with route + status.
- **DB client logging**: prisma `log: ['error']` in production, `['query','error']` in dev
  (`src/lib/db.ts`) — query-level noise stays out of prod logs.
- **Audit trail is data**: every mutation writes an `activity_logs` row (actor, action,
  entity, before/after, field diff) through `logActivity()` — queryable in the Activity
  Log view; log-write failures never break the main operation.
- **Dev work log**: `worklog.md` (repo root) is the append-only human log of every task
  batch; `docs/CHANGELOG.md` is the user-facing summary.

## 6. Route & permission map (page level)

| Route | Page group | View gate (client) | API gate (authoritative) |
|---|---|---|---|
| `/login` | public | — | public (auth endpoints only) |
| `/dashboard`, `/modules`, `/test-cases`, `/bugs`, `/tasks`, `/notifications`, `/settings/profile` | `(app)` | AppShell auth guard | `requireUser()` |
| `/test-cases/[id]` | `(app)` | edit/delete buttons per `can()` | service permission rules per action |
| `/reviews`, `/reviews/[id]`, `/module-reviews/[id]` | `(app)` | `canAny(perform_review, submit_review)` + `PermissionDenied` | participant-scoped service rules |
| `/reports` | `(app)` | `view_all_task_reports` | `requirePermission('view_all_task_reports')` |
| `/activity-log` | `(app)` | `view_activity_logs` | `requirePermission('view_activity_logs')` |
| `/integrations` | `(app)` | `manage_integrations` | `requirePermission('manage_integrations')` on every Crew Desk endpoint (reads included) |
| `/settings/users` | `(app)` | `manage_users` | `requirePermission('manage_users')` |
| `/settings/permissions` | `(app)` | `manage_permissions` | `requirePermission('manage_permissions')` |
| all `(app)` pages | — | — | `src/proxy.ts` redirects anonymous page hits to `/login?next=` (cookie presence; defense-in-depth) |

Client gates are UX; the API remains the security boundary. Every client gate has a
server twin — if you add a page, add both.
