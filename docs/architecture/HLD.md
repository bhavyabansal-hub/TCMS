# HLD — High-Level Design

> What TCMS is, its components, how a request travels, how it boots, how it is deployed,
> and how it scales. Code-level design (layers, patterns, caching, logging, page map) is in
> [`LLD.md`](./LLD.md); the rules are in [`../CODING-STANDARDS.md`](../CODING-STANDARDS.md).

## 1. What TCMS does

A web application for QA teams. In one place a team can:

- **Organise** product features into a nested **module tree** (`Authentication → Login`).
- **Author test cases** with steps, priorities, tags and expected results; every edit is a
  new version with a stored snapshot.
- **Run peer reviews** of one case or a whole module; every submission is a numbered cycle
  with verdicts and flagged fields.
- **Track bugs** on a drag-and-drop Kanban board, linked to test cases.
- **Log daily work** (task reports) and see team **reports**.
- **Keep a wiki**, link modules to Crew Desk tickets, and see everything that happened
  through **notifications** and a full **audit trail**.
- **Administer users** with six roles and a runtime permission matrix (126 cells).

## 2. Technology stack

| Layer | Technology | Role |
|---|---|---|
| UI + API | **Next.js 16** (App Router, Turbopack in dev) | Pages under `src/app/(app)`, API route handlers under `src/app/api` |
| UI library | **React 19**, Tailwind CSS v4, shadcn/ui (Radix) | Components and look & feel |
| Client state | **Zustand 5** (session, view, notifications) + **TanStack React Query 5** (all server data) | State and caching in the browser |
| Charts / DnD | Recharts, @dnd-kit | Dashboard, reports, bug Kanban |
| Data access | **Prisma 6** client used for raw SQL only | Tagged-template queries in repositories |
| Database | **MySQL 8.4** (utf8mb4, strict mode, UTC, native JSON) | The only database |
| Auth | jsonwebtoken + bcryptjs | JWT sessions in httpOnly cookies, password hashing |
| Validation | zod 4 | Request validation before every service |
| Realtime | socket.io 4.8 mini-service (`mini-services/notifications`) | Optional live notifications |

## 3. Components

```
┌──────────────────────────── BROWSER ────────────────────────────┐
│ App Router pages (src/app/(app)/*) → AppShell → view component   │
│ Zustand (session/view/notifs) · React Query (server data cache)  │
│ src/lib/client/api.ts: fetch + X-Requested-With + 401 refresh    │
└───────────────┬──────────────────────────────┬──────────────────┘
                │ HTTPS JSON (cookies)         │ WebSocket (optional)
                ▼                              ▼
┌──────────── Next.js server (ONE process) ────────────┐   ┌──────────────────────────┐
│ src/proxy.ts (edge): anonymous page → /login          │   │ notifications service    │
│ src/app/api/<resource>/route.ts → validation →        │   │ :3003 sockets            │
│   service → repository (raw SQL)                      │──▶│ :3004 loopback /notify   │
│ shared: db (Prisma singleton) · cache · logger ·      │   └──────────────────────────┘
│   permissions (matrix + 3 s cache) · activity log ·   │
│   notifications (DB row → WS → email/Telegram)        │──▶ SMTP / Telegram (optional)
└───────────────────────────┬──────────────────────────┘──▶ Crew Desk API (optional)
                            │ pooled connections (connection_limit)
                            ▼
                    MySQL 8.4 — 17 tables
```

Three design choices run through the whole system:

1. **Every page is a real URL** (`/dashboard`, `/modules`, `/test-cases/[id]`,
   `/reviews/[id]`, `/bugs`, `/tasks`, `/reports`, `/wiki`, `/activity-log`,
   `/integrations`, `/notifications`, `/settings/*`). `src/lib/routes.ts` maps views ↔
   paths; `src/proxy.ts` redirects anonymous page requests to `/login?next=<path>`
   (defense in depth — the API is the real gatekeeper).
2. **The API is addressed by query parameters** — one route file per resource, the
   operation chosen by `?id=`, `?action=` or `?path=` (e.g.
   `PUT /api/test-cases?id=…&action=submit-review`). Every route runs the same four
   layers and answers through the shared helpers in `src/lib/api.ts`.
3. **Every write leaves an audit row** (`logActivity()`: before/after snapshots + field
   diff in `activity_logs`); a failed audit write never breaks the operation.

## 4. Request flow (example: Submit for Review)

```
 1. View (test-case-detail.tsx) → testCasesApi.submitReview(id, { reviewerId, dueDate })
 2. src/lib/client/api.ts → PUT /api/test-cases?id=…&action=submit-review
    (cookies tcms-access, header X-Requested-With: tcms)
 3. withApi(): same-origin check, request log, read-only switch, error funnel
    a. requireUser()        → verify the JWT cookie                      (401)
    b. validation           → zod                                         (400)
    c. service              → can('submit_review'); case lookup (404);
                              400 if in_review/approved; resolve reviewer
                              (body → case assignee → first active manager, then VP)
    d. repository (one tx)  → close the case's old open review, insert review_requests
                              (cycle = max + 1), set case → in_review
    e. logActivity(REVIEW_SUBMITTED) + createNotification(reviewer, 'review_assigned')
       → DB row → WS broadcast (not awaited) → email/Telegram after the response
 4. 200 JSON → toast.success → invalidate ['reviews', …] → queue badges refetch
 5. Reviewer's browser (WS connected) → bell badge +1 instantly; without WS the row
    shows on the next list fetch.
```

Every flow has this shape: **view → api client → route (guard → validate → rule →
repository → audit → notify) → response → toast + invalidate → optional push**.

## 5. Boot sequence

**Server (once per process):** `src/instrumentation.ts` loads `src/instrumentation-node.ts`
only in the Node runtime → production startup guard (secrets) → DB settings guard
(sql_mode, UTC, utf8mb4; production only) → process error capture → graceful shutdown on
SIGTERM/SIGINT (closes the DB pool) → daily backup-staleness check.

**Browser:**

```
1. GET /<page>   → proxy.ts: no tcms-access cookie → 302 /login?next=<path>
2. layout.tsx    → <Providers>: React Query client + AuthGate
3. AuthGate      → paint from the cached display profile (localStorage tcms-user),
                   GET /api/auth (me) validates the cookie session; prefetches
                   ['stats','dashboard'] + ['modules','tree'] in parallel
                   transient failure → retry card (not logged out); 401 → /login
4. AppShell      → sidebar shows only links the permission matrix allows
5. Notifications socket connects (if the WS service runs); review-queue badges poll only
   for users who can review
```

## 6. Deployment topology

**Production (Linux + nginx, single instance — decision D8):**

```
  browser ── HTTPS :443 ──▶ nginx (TLS, reverse proxy)
                              ├─ /            ──▶ Next.js app   127.0.0.1:3000  (.next/standalone/server.js)
                              └─ /socket.io/  ──▶ notifications 127.0.0.1:3003  (loopback broadcast :3004)
  Next.js app ── pooled connections (connection_limit) ──▶ MySQL 8.4 (company IT server)
```

Two systemd services (`tcms-app`, `tcms-ws`); the firewall allows only 80/443. Steps:
[`../deploy/PRODUCTION-CHECKLIST.md`](../deploy/PRODUCTION-CHECKLIST.md); nginx:
[`../deploy/reverse-proxy-websocket.md`](../deploy/reverse-proxy-websocket.md).
`DATABASE_URL` is the app user (DML only), `DIRECT_URL` the migrate user (DDL, `prisma
migrate deploy`); both must be `mysql://`.

**Local (Windows):** `npm run dev` (`scripts/dev-tcms.mjs` → `next dev :3000`) against
MySQL 8.4 at `127.0.0.1:5500/tcms_test`; the WS service is optional
([`../deploy/local-setup-windows.md`](../deploy/local-setup-windows.md)).

**Health and safety switches:** `GET /api` (liveness), `GET /api/ready` (503 when MySQL is
down), `TCMS_READ_ONLY=true` (every write 503, sign-in and reading keep working),
`TCMS_DEPLOY_ENV=production` (startup guard on).

**Fallbacks:** DB down → `/api/ready` and data requests answer 503 with a clear message,
`/api` stays up; WS service down → the app works, notifications are refresh-visible;
email/Telegram failure → logged, never fails or slows the request.

## 7. Scaling

### 7.1 Today: one instance, scaled vertically

TCMS runs as **one** Next.js process + **one** WS service + one MySQL. Some state lives in
the process on purpose (speed, simplicity):

| State | File | What a second instance would break |
|---|---|---|
| TTL cache (stats aggregates) | `src/lib/server/cache.ts` | Writes invalidate only the local copy → other instances serve stale numbers until the TTL ends |
| Permission-override cache (3 s) | `src/lib/permissions.ts` | A toggle reaches other instances only after ≤ 3 s |
| WS socket registry | `mini-services/notifications/index.ts` | Users on relay B miss events sent through relay A (they still see them on the next fetch) |
| Per-IP sign-in limit | `src/lib/server/login-rate-limit.ts` | Counted per instance (the per-email lock is in MySQL and stays global) |
| Prisma pool | `src/lib/db.ts` | Capacity: instances × `connection_limit` must stay under MySQL `max_connections` |

Already safe for several instances: JWT access tokens (stateless), refresh tokens and the
login lock (MySQL tables), CSRF checks (stateless), all repositories (one database).

### 7.2 Scaling path (not built — do this before running a second app instance)

```
             nginx (load balancer, health check GET /api/ready)
            ┌───────────────┼───────────────┐
        app #1          app #2          app #N        (stateless; connection_limit each)
            └───────┬───────┴───────┬───────┘
                 Redis              MySQL 8.4 (+ read replica later)
      (cache, permission-changed pub/sub, notify pub/sub, rate limit)
            ┌───────┴───────┐
         WS #1 … WS #N  (each subscribes to the notify channel)
```

1. **Cache → Redis.** Keep `withCache()` / `invalidateCache()` as the only call sites;
   implement them with Redis `GET`/`SET PX` and prefix deletes. Keep in-process miss coalescing.
2. **Permission toggles → Redis pub/sub** (`tcms:permissions:changed`): every instance
   reloads the matrix at once (removes the 3 s window).
3. **Notifications → Redis pub/sub** (`tcms:notify`): every WS instance pushes to its own
   sockets, so N relays behind the load balancer deliver every event. Interim without
   Redis: one WS process + sticky sessions.
4. **Per-IP sign-in limit → Redis** counters.
5. **Connection budget:** `instances × connection_limit (+ admin) ≤ max_connections`;
   lower `connection_limit` per instance as instances are added, or put ProxySQL in front.
6. **Rollout gates:** health check per instance in nginx, rolling deploys (the refresh
   grace window survives a restart), two-instance acceptance test (write on :3000, read on
   :3001 immediately), notifications arrive on sockets of both instances.

Nothing else changes: sessions, CSRF, login lock, repositories, schema and the four layers
are already multi-instance safe.

### 7.3 Measured headroom (one instance)

Measured 2026-10-17 on the owner's laptop (Intel i5-1335U, Windows 11; MySQL, the dev server and
the load generator on the same machine), production build (`next start`), demo data, pool
`connection_limit=40`. Script: `scripts/loadtest-1000.mjs`.

- **API speed, single user:** page-load calls answer in 5–13 ms (p95); every call a page makes
  has p95 < 60 ms (`scripts/verify-page-apis.mjs`).
- **Capacity of one Node process here:** ~670 req/s for a trivial route, 440–720 req/s for real
  endpoints — CPU-bound in one process; the DB peaked at 51 connections and was never the limit.
- **1000 real users** (one page every ~20 s ≈ 350 API req/s): served completely, 0 errors,
  p50 605 ms, p95 764 ms.
- **1000 always-busy clients** (1000 requests in flight at every moment — a stress test, not a
  user model): the single process saturates at ~500 req/s, latency queues up to seconds and
  Windows refuses part of the new connections. That load needs the scaling path (§7.2): several
  app instances behind nginx, or a server CPU with more single-core speed.

Levers already applied: one Prisma pool per process (default 40), cache-aside for the module
tree, user picker and dashboard aggregates, light picker endpoints, batched module-review writes,
list-sort indexes, buffered async log writes, fast successful reads logged at debug level.

### 7.4 Load test results

| Run | Load | Requests | p50 | p95 | Errors | DB conn peak |
|---|---|---|---|---|---|---|
| 2026-10-17 realistic, pool 40 | 1000 users, 350 req/s, 60 s | 21 001 | 605 ms | 764 ms | 0 | 51 |
| 2026-10-17 realistic, pool 20 | 1000 users, 350 req/s target (253 reached), 60 s | 15 164 | 854 ms | 2 491 ms | 0 | 31 |
| 2026-10-17 stress, pool 40 | 1000 always-busy clients, 60 s | 30 750 | 10.1 s | 44.8 s | 24 845 refused connections | 51 |
| 2026-10-17 warm-up | 20 VU, 5 s | 1 824 | 54 ms | 82 ms | 0 | 21 |
