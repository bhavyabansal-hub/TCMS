# 01 · Overview & Architecture

> **TCMS — Test Case Management System.** This document explains what the project is,
> how it is structured, and how a request travels from the browser to the database and
> back. Read this first; the other documents in `docs/` go deeper into each layer.

---

## 1. What TCMS does

TCMS is a full-stack web application for QA (quality assurance) teams. In one place a
team can:

- **Organise** product features into a nested **module tree** (e.g. `Authentication → Login`).
- **Author test cases** with step-by-step instructions, priorities, tags and expected results.
- **Run peer reviews** — a test case or a whole module is submitted to a reviewer who
  approves, fails or requests revision; every submission is a numbered "cycle" and every
  edit creates a new version with a stored snapshot.
- **Track bugs** on a drag-and-drop Kanban board, optionally linked to test cases.
- **Log daily work** (task reports: what was done, how many minutes, linked to modules/cases/bugs).
- **See everything that happened** through in-app notifications and a full audit trail
  (activity log with before/after field diffs).
- **Administer users** with four roles and a permission matrix.

## 2. Technology stack (with exact versions from `package.json`)

| Layer | Technology | Version | Role |
|---|---|---|---|
| UI framework | **Next.js** (App Router) | ^16.1.1 | Serves the app, hosts the API routes |
| UI library | **React** | ^19.0.0 | Component model |
| Language | **TypeScript** | ^5 | Types everywhere |
| Styling | **Tailwind CSS** + shadcn/ui (Radix primitives) | v4 | Look & feel |
| Client state | **Zustand** | ^5.0.6 | Auth session, current view, notifications |
| Server state | **TanStack React Query** | ^5.82.0 | Fetching, caching, invalidation |
| Charts | **Recharts** | ^2.15.4 | Dashboard + reports |
| Drag & drop | **@dnd-kit/core** | ^6.3.1 | Bug Kanban board |
| ORM | **Prisma** | ^6.11.1 | Typed database access |
| Database | **MySQL 8.4** (utf8mb4, strict mode) | 17+ | Storage; native JSON columns with expression defaults |
| Auth | **jsonwebtoken** + **bcryptjs** | 9.0.3 / 3.0.3 | JWT sessions, password hashing |
| Validation | **zod** | ^4.0.2 | Request body validation |
| Toasts | **sonner** | ^2.0.6 | User feedback |
| Realtime | **socket.io / socket.io-client** | 4.8.x | Optional live notifications (mini-service) |

## 3. High-level architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                            BROWSER (client)                              │
│                                                                          │
│  src/app/page.tsx  →  <AppShell>  →  one of 14 views (Zustand switch)    │
│                                                                          │
│  ┌──────────────┐  ┌──────────────────┐  ┌───────────────────────────┐  │
│  │ Zustand      │  │ React Query      │  │ lib/client/api.ts         │  │
│  │ · auth user  │  │ · cache + keys   │  │ request<T>() fetch helper │  │
│  │ · view/params│  │ · 30s staleTime  │  │ · Bearer token header     │  │
│  │ · notifs     │  │ · invalidations  │  │ · auto refresh on 401     │  │
│  └──────────────┘  └──────────────────┘  └───────────────────────────┘  │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ HTTPS  JSON over fetch
                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                     SERVER — Next.js route handlers                      │
│                                                                          │
│  src/app/api/**/route.ts   (13 route files, query-param addressing)      │
│                                                                          │
│  ┌───────────┐  ┌────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ lib/auth  │  │ zod schema │  │ lib/activity │  │ lib/notifications│  │
│  │ JWT check │→ │ validation │→ │ logActivity  │  │ createNotification│  │
│  │ role/can  │  │            │  │ (audit diff) │  │  + WS broadcast  │  │
│  └───────────┘  └────────────┘  └──────────────┘  └────────┬─────────┘  │
│                               │ Prisma Client (lib/db.ts)  │ fetch      │
└───────────────────────────────┼────────────────────────────┼────────────┘
                                ▼                            ▼
                   ┌────────────────────────┐   ┌──────────────────────┐
                   │  MySQL 8.4 (:5500)     │   │ mini-services/       │
                   │  15 tables, 10 MySQL JSON│   │ notifications WS     │
                   └────────────────────────┘   │ :3003 (optional)     │
                                                └──────────────────────┘
```

Three things make this architecture distinctive; keep them in mind throughout the docs:

1. **Every page is a real URL route.** Pages live in the `(app)` route group
   (`/dashboard`, `/modules`, `/test-cases/[id]`, `/reviews/[id]`, `/bugs`, `/tasks`,
   `/reports`, `/activity-log`, `/notifications`, `/settings/*`), so links are shareable
   and back/forward works. `src/lib/routes.ts` is the single source of truth mapping
   `ViewKey <-> URL path`; `<RouteSync/>` bridges URL changes into the `useViewStore`,
   and `navigate(view, params)` pushes the mapped path through the Next router. Which
   view renders is still held in the Zustand store — the URL and the store can never
   disagree because every store change is a URL change and vice versa.
   An edge `src/proxy.ts` redirects anonymous page requests to
   `/login?next=<path>` before any shell JS downloads (defense-in-depth; the API layer
   remains the authoritative gatekeeper).
2. **The API is addressed by query parameters, not path segments.** One route file per
   domain (e.g. `api/test-cases/route.ts` handles everything) and the operation is chosen
   via `?id=`, `?action=` or (for auth) `?path=`. Example: `PUT /api/test-cases?id=abc&action=submit-review`.
   Every route follows the same layering: handler (controller) -> zod validation ->
   service (business rules) -> repository (parameterized raw SQL) -> response built by
   the shared helpers in `src/lib/api.ts` (`withApi`/`ok`/`ApiError`).
3. **Every mutating request writes an audit record.** Routes call `logActivity()` which
   stores before/after snapshots and a computed field-level `diff` into the `ActivityLog`
   table; failures to log never break the main operation.

## 4. Request lifecycle (a complete example)

What happens when a QA engineer clicks **Submit for Review** on a test case:

```
 1. View component (test-case-detail.tsx) — "Submit for Review" dialog
    → testCasesApi.submitReview(id, { reviewerId, dueDate })
 2. lib/client/api.ts request<T>()
    → PUT fetch to /api/test-cases?id=…&action=submit-review
    → headers: Content-Type: application/json + Authorization: Bearer <jwt>
 3. Server route api/test-cases/route.ts, PUT handler
    a. getCurrentUser()            → reads cookie tcms-access, verifies JWT   (401 if bad)
    b. can('submit_review')        → permission matrix check                  (403 if bad)
    c. case lookup                 → 404 if missing; 400 if in_review/approved
    d. reviewer resolution         → body reviewerId, else case.assigneeId,
                                     else first active manager, then VP
    d2. close the case's old open review (same transaction)
    e. cycle = max(cycle)+1        → create ReviewRequest, set case → in_review
    f. logActivity(REVIEW_SUBMITTED/test_case, after:{reviewerId, cycle})
    g. createNotification(reviewer, 'review_assigned') → insert Notification row
                                                     → fire-and-forget POST :3003/notify
 4. Response { …review row… }  → 200 JSON
 5. Client: toast.success('Submitted for review')
    → queryClient.invalidateQueries(['reviews…'])  → queue/sidebar badges refetch
 6. Reviewer's browser (if WS connected): socket 'notification' event
    → zustand addNotification → bell badge increments instantly.
      (If the WS service is not running the row still exists in the DB and
       appears on next fetch/refresh; nothing breaks.)
```

Every flow in the system follows this same 6-step shape: **view → api client → route
(guard → validate → business rule → audit → notify) → response → toast + invalidate →
(optional realtime push)**.

## 5. Boot sequence (what happens from page load to usable app)

```
1. Browser GET /<page>          → proxy.ts checks the tcms-access cookie:
     missing → 302 /login?next=<path> (no shell JS downloaded)
     present → Next.js serves the page shell
2. layout.tsx                   → <Providers> mounts:
     QueryInit                  → React Query client (staleTime 30s, retry 1)
     AuthGate                   → useAuthStore.initialize() + cache warm-up
                                  (prefetches ['stats','dashboard'] and
                                   ['modules','tree'] in parallel with the
                                   session check when a token exists)
3. initialize():
     read localStorage tcms-user + tcms-access
     if present → GET /api/auth (me) to validate the token server-side
        ok    → user stays logged in (session restored)
        transient failure → sessionError retry card (user NOT logged out;
                            tokens are kept, "Try again" re-runs the check)
        hard 401 → clearSession() → redirect /login?next=<path>
4. While !booted → centred spinner
5. AppShell renders the active page; sidebar hides items the role matrix denies
6. Sidebar: users with perform_review/submit_review poll the review queues
   every 30s for the badge count (others never poll — load management)
7. useNotificationSocket connects to WS (if user) and seeds notifications list
8. Default view = 'dashboard' → GET /api/stats?action=dashboard
```

## 6. Repository directory map

```
├── prisma/
│   ├── schema.prisma          17 models, MySQL 8.4 (explicit VARCHAR/TEXT native types), native JSON columns
│   └── migrations/            versioned MySQL migrations (`npx prisma migrate deploy`)
├── src/
│   ├── app/
│   │   ├── layout.tsx         root layout: fonts, metadata, <Providers>, toasters
│   │   ├── page.tsx           the single page → <AppShell/>
│   │   ├── globals.css        Tailwind v4 theme tokens (oklch)
│   │   └── api/…              13 route handlers (see 04-api-reference.md)
│   ├── components/
│   │   ├── providers.tsx      React Query provider + auth boot gate
│   │   ├── app-shell.tsx      sidebar + topbar + view switch
│   │   ├── auth-screen.tsx    login / register split screen
│   │   ├── layout/            sidebar.tsx, topbar.tsx
│   │   ├── views/             14 view components = the "pages" (docs 06–10)
│   │   ├── shared/            state.tsx (loading/empty/error), pagination.tsx
│   │   └── ui/                ~40 shadcn/ui primitives (button, dialog, …)
│   ├── hooks/                 use-notification-socket, use-toast, use-mobile
│   ├── lib/
│   │   ├── client/api.ts      FRONTEND data layer: fetch + session + api namespaces
│   │   ├── api.ts             BACKEND response helpers (ok/401/403/404/paginate)
│   │   ├── auth.ts            JWT, password hash, roles, permission matrix
│   │   ├── db.ts              Prisma singleton
│   │   ├── activity.ts        audit logging + MySQL JSON helpers
│   │   ├── notifications.ts   in-app notification + WS broadcast
│   │   ├── serializers.ts     MySQL JSON normalisers for every row type
│   │   ├── format.ts          dates, colors, labels
│   │   ├── errors.ts          client error → toast mapping
│   │   └── utils.ts           cn() class merger
│   ├── store/index.ts         Zustand: auth, view, notifications
│   └── types/index.ts         shared TypeScript domain types
├── mini-services/notifications/  optional socket.io WS relay (:3003)
├── docs/                          THIS documentation
├── DEPLOYMENT.md                  MySQL 8.4 deployment guide
└── package.json / configs
```

## 7. Environment variables

| Variable | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | Prisma | MySQL connection string (app queries), e.g. `mysql://tcms_app:***@127.0.0.1:5500/tcms_test?connection_limit=40&pool_timeout=10`. Managed by `scripts/mysql-env.sh` (single source of truth). |
| `DIRECT_URL` | Prisma | Direct (non-pooled) string for schema tools. |
| `JWT_SECRET` | lib/auth.ts | HS256 signing secret for access & refresh tokens. Falls back to a dev default — always set it in production. |

Nothing else is required. `PORT` is fixed to 3000 in the npm scripts. The WS
mini-service is configured by constant (`PORT = 3003` inside `mini-services/notifications/index.ts`).

## 8. Conventions used across the codebase

- **String enums**: status/priority/role values are plain strings (`'draft'`, `'P2'`,
  `'manager'`) mirrored in `src/types/index.ts` — the single source of truth for the UI.
- **MySQL JSON columns** are read through `parseJson()` (handles both native JSON objects and
  legacy JSON strings) and serialised exactly once per row via `lib/serializers.ts`.
- **Auth transport**: the JWT access token travels in the `Authorization: Bearer` header
  AND is mirrored into cookie `tcms-access` (server routes read the cookie via
  `next/headers`). The refresh token lives only in localStorage and is sent in the JSON
  body of `POST /api/auth?path=refresh`.
- **Feedback**: success → `toast.success(...)`; failure → `handleApiError(err, fallback)`
  which maps HTTP status to a friendly message. No optimistic updates anywhere — the UI
  always waits for the server, then invalidates React Query caches.
- **Time**: stored as UTC `DateTime`, rendered with `en-US` formatters from `lib/format.ts`.

## 9. Where to read next

| Want to understand… | Read |
|---|---|
| The data model, every table/column/relation | `02-database-schema.md` |
| Login, tokens, roles, who may do what | `03-authentication-and-permissions.md` |
| Every endpoint, request/response, side effects | `04-api-reference.md` |
| The client machine: stores, cache keys, fetch layer | `05-frontend-architecture.md` |
| How each page/screen works | `06`–`10-page-*.md` |
| Complete click-to-database stories | `11-end-to-end-flows.md` |
| Realtime service + production topology (nginx + MySQL 8.4) | `12-realtime-and-deployment.md` |
| Any single file explained in one paragraph | `13-file-index.md` |
