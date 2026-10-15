# TCMS — Code Quality & Improvement Roadmap

This document captures what's already been fixed (Phase 1) and a prioritized
list of larger improvements to make before/after launch (Phase 2+).

---

## ✅ Phase 1 — Completed (this session)

These DRY / bug-prevention fixes are already done:

| # | Fix | Files |
|---|---|---|
| 1 | **Centralised serializers** — every JSON column (steps, tags, attachments, flaggedFields, tasks, snapshot, diff) is now parsed in one place. The `flaggedFields.map is not a function` bug class can no longer happen. | `src/lib/serializers.ts` |
| 2 | **Shared color helpers** — removed 7 duplicated functions (`reviewStatusColor`, `moduleReviewStatusColor`, `verdictHex`, `verdictColor`, `severityDot`) from 5 view files; all live in `src/lib/format.ts` now. | `src/lib/format.ts` |
| 3 | **Unified JSON helper** — removed duplicate `safeJson`; everything uses `parseJson` from `src/lib/activity.ts`. | `src/app/api/module-reviews/route.ts` |
| 4 | **Shared error handler** — `handleApiError(err, fallback)` replaced 22 repeated `toast.error(err instanceof Error ? err.message : '...')` patterns. Smart messages based on HTTP status (401/403/404/500/network). | `src/lib/errors.ts` |
| 5 | **Shared state components** — `<StateLoading>`, `<StateLoadingCards>`, `<StateSpinner>`, `<StateEmpty>`, `<StateError>`. | `src/components/shared/state.tsx` |
| 6 | **Shared pagination** — `<Pagination page={} totalPages={} onPageChange={} />`. | `src/components/shared/pagination.tsx` |

---

## 🔴 Phase 2 — High priority (do before launch)

### 2.1 Use the serializers in every API route
The serializers are written but not yet wired into every route. Currently
`test-cases` and `module-reviews` use them, but `reviews`, `bugs`,
`task-reports`, `activity-logs` still do manual `parseJson` calls. Replace
those manual calls with the serializer functions so the parsing logic lives
in exactly one place.

**Why:** Right now, if you add a new JSON column to a model, you have to
remember to parse it in every route that returns that model. With serializers,
you update one function and every route is correct.

**Effort:** ~1 hour.

### 2.2 Database transactions for multi-step operations
Several routes do multiple writes that should be atomic:

- `modules/route.ts` → `submit-review`: creates a `ModuleReviewRequest` +
  many `ReviewRequest`s + updates many test cases. If one fails midway, you
  get a half-created review.
- `reviews/route.ts` → verdict: creates a `ReviewEvent` + updates the
  `ReviewRequest` + updates the `TestCase` + maybe updates the
  `ModuleReviewRequest`. Same risk.
- `test-cases/route.ts` → update: saves a `TestCaseHistory` snapshot + updates
  the test case.

**Fix:** wrap each in `db.$transaction([...])` or `db.$transaction(async (tx) => { ... })`.

**Effort:** ~2 hours.

### 2.3 Auth tokens in httpOnly cookies (not localStorage)
Currently access/refresh tokens live in `localStorage` (plus a mirror cookie).
`localStorage` is accessible to any JavaScript running on the page — if an XSS
bug ever lands, tokens are stolen. httpOnly cookies are not readable by JS,
which eliminates that attack surface.

**Fix:**
- Set the access token as an `httpOnly`, `SameSite=Lax` cookie on login
  (server-side via `cookies().set(...)`).
- Remove the `Authorization` header logic from the API client — cookies are
  sent automatically.
- Keep the refresh token in an httpOnly cookie too.
- The `getCurrentUser()` helper already reads from cookies, so the server
  side is ready.

**Effort:** ~3 hours (touch auth route + API client + auth store).

### 2.4 Shared zod schemas (frontend + backend)
The backend validates input with zod schemas (in each route file). The
frontend re-implements the same rules manually (e.g. "password min 8 chars").
When the backend rule changes, the frontend doesn't know.

**Fix:** move all zod schemas to `src/lib/schemas.ts` and import them in both
the API routes and the frontend forms (with `react-hook-form` + `@hookform/resolvers/zod`).

**Effort:** ~4 hours.

### 2.5 Rate limiting on auth endpoints
`/api/auth?path=login` has no rate limit. An attacker can brute-force
passwords. Add a simple in-memory rate limiter (e.g. max 10 login attempts per
IP per minute) — no Redis needed for a small team.

**Effort:** ~1 hour.

---

## 🟡 Phase 3 — Medium priority (first month after launch)

### 3.1 Consistent loading / empty / error states everywhere
The shared `<StateLoading>`, `<StateEmpty>`, `<StateError>` components exist
but not every view uses them yet. Audit each view and swap ad-hoc markup for
the shared components so the UX is identical everywhere.

### 3.2 Optimistic updates for mutations
Currently every mutation (create test case, update bug, submit review) waits
for the server response before updating the UI. For snappy UX, update the
local cache immediately and roll back on error. TanStack Query supports this
via `onMutate` + `setQueryData`.

### 3.3 Search across all entities
Only test cases have a search box. Add search to: bugs, modules, activity log,
notifications. A shared `<SearchInput>` component would keep the UX consistent.

### 3.4 Request timeout + abort on unmount
The API client (`src/lib/client/api.ts`) has no timeout — if the server hangs,
the user stares at a spinner forever. Add an `AbortController` with a 30s
timeout and abort in-flight requests when the component unmounts (TanStack
Query does this automatically if you pass `signal`).

### 3.5 Activity log completeness
Activity logging is manual in every route. Some operations might miss it
(e.g. module permission grants, notification reads). Audit each write
operation and ensure `logActivity()` is called. Consider a higher-order
function like `withActivityLog(handler, action, entityType)` to make it
impossible to forget.

### 3.6 Pagination on all list endpoints
`bugs`, `task-reports`, `notifications`, `activity-logs` have pagination on
the backend but some frontends hard-code `pageSize=200`. For a small team
this is fine, but as data grows it'll slow down. Use the `<Pagination>`
component everywhere.

### 3.7 WebSocket reconnection robustness
The current WS client reconnects with exponential backoff, but it doesn't
re-fetch missed notifications after a reconnect. If a notification was pushed
while the user was disconnected, it's lost. On reconnect, fetch the latest
notifications via `notificationsApi.list()` to fill the gap.

### 3.8 Dark mode toggle
The CSS variables already support dark mode (`.dark` class). Add a toggle in
the topbar / settings using `next-themes` (already installed).

---

## 🟢 Phase 4 — Nice to have (post-launch)

### 4.1 End-to-end tests with Playwright
The app has no tests. A small set of Playwright E2E tests covering the golden
path (login → create test case → submit for review → approve) would catch
regressions. The Agent Browser verification we do now is manual; Playwright
automates it.

### 4.2 Type-safe API responses (end-to-end)
Right now the frontend types in `src/types/index.ts` are hand-maintained and
can drift from the backend. Options:
- **Zod schemas as the single source of truth** (see 2.4) — infer both the
  backend response type and the frontend type from the same schema.
- **tRPC** — would give end-to-end type safety without codegen, but requires
  rewriting the API layer.

### 4.3 Export to real PDF (not window.print)
The Reports page uses `window.print()` for "Export PDF". For a polished
result, use `@react-pdf/renderer` or a server-side PDF generator
(`@react-pdf/renderer` works client-side and is already installable).

### 4.4 Email/Telegram notifications (Celery equivalent)
The original spec called for async email/Telegram delivery. We currently do
in-app + WebSocket only. For email, use a transactional email API (Resend,
SendGrid) triggered from `createNotification()`. For Telegram, use the Bot API.
Both can be fire-and-forget `fetch` calls (no queue needed for a small team).

### 4.5 File attachments
The schema has an `attachments` JSON column on test cases and bugs, and the
API has placeholder endpoints, but the frontend doesn't have an upload UI.
Wire up file uploads to local disk (`/public/uploads/`) or S3-compatible
storage.

### 4.6 Keyboard shortcuts
QA engineers work fast. Add keyboard shortcuts: `g` then `d` for dashboard,
`g` then `t` for test cases, `/` to focus search, `n` to create new, etc.
Use the `cmdk` package (already installed) for a command palette.

### 4.7 Audit log retention policy
Activity logs grow forever. Add a cron job (or manual button in Settings) to
archive/delete logs older than 90 days.

### 4.8 Soft-delete for bugs
Bugs are hard-deleted by admins. Consider soft-deleting (status = 'deleted')
so data isn't lost and can be audited.

### 4.9 Bulk operations
- Bulk change status on test cases (select multiple → change status)
- Bulk assign bugs
- Bulk move test cases between modules

### 4.10 i18n
Currently English-only. `next-intl` is already installed — extract strings
and add a language switcher if you need multi-language support.

---

## 📐 Code standards to enforce going forward

1. **No new duplicated helpers.** Before writing a color/format/error helper,
   check `src/lib/format.ts` and `src/lib/errors.ts` first. If it's common,
   put it there.

2. **Every new API route that returns a model with JSON columns must use the
   serializer** from `src/lib/serializers.ts`. Never call `parseJson` directly
   in a route handler — use `serializeTestCase(tc)` etc.

3. **Every catch block uses `handleApiError(err)`** — no more
   `toast.error(err instanceof Error ? ...)`. Form-validation errors can still
   use `toast.error('Field is required')` directly.

4. **Every list view uses `<StateLoading>` / `<StateEmpty>` / `<StateError>`**
   for its three states. No ad-hoc skeleton markup.

5. **Every paginated list uses `<Pagination>`** — no inline Prev/Next buttons.

6. **Every form uses `react-hook-form` + zod** (once 2.4 is done) — no manual
   `useState` per field for forms with more than 3 fields.

7. **Every write operation calls `logActivity()`** — if you add a new
   mutation endpoint, wire up the activity log in the same commit.

8. **Types come from `src/types/index.ts`** — if you add a field to a Prisma
   model, update the type in the same commit.

9. **No `any` types.** Use `unknown` + type narrowing, or proper interfaces.

10. **Components > 300 lines should be split.** The `test-case-detail.tsx`
    view is ~600 lines and contains the editor + dialogs inline — consider
    extracting them into separate files.
