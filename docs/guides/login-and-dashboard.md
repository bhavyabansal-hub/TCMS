# Pages — Login / Register & Dashboard

> Screens: **AuthScreen** (`src/components/auth-screen.tsx`) and **Dashboard**
> (`src/components/views/dashboard-v2.tsx`, the QA Command Center). These are the first two things every user
> sees; together they illustrate the app's whole pattern: gate → fetch → render → navigate.

---

## 1. AuthScreen — Sign in / Create account tabs

### When it shows
`AppShell` checks `useAuthStore().user`; if there is no logged-in user the shell is
never rendered — the **entire screen** is the auth experience. The boot spinner in
`AuthGate` guarantees this decision is made only after the stored session was validated
(or cleared).

### Layout
A split screen: left panel = product pitch (title, feature bullets, gradient accent);
right panel = a pill-style tab switcher — **"Sign in"** and **"Create account"** —
above a form card with generous spacing (space-y-5 fields, h-10 inputs, hints under
each field).

### Sign-in tab (state: `mode='signin'`)

| Element | Behaviour |
|---|---|
| Email, Password inputs | plain controlled state (`email`, `password`) |
| **"Sign in"** button | `authStore.login(email, password)` → `POST /api/auth?path=login` |
| success | `setSession(...)`, toast `Welcome back!`, `AppShell` re-renders as the app |
| failure | toast `err.message` — typically *Invalid credentials* (401) |
| inline hint | "New to TCMS? Create an account" flips to the register tab |

### Create account tab (state: `mode='register'`) — RESTORED (owner decision 2026-10-08)

Full name + Email + Password + Confirm password. Client-side confirm-match check,
server-side validation (name 2–80, password ≥ 8 with a letter + a number).
`authStore.register(...)` → `POST /api/auth?path=register` creates a
**least-privilege `viewer`** account, signs the user straight in (httpOnly cookies),
and lands them in the app. Duplicate email → **409** toast; weak password → **400**
with the field error. Admins promote roles from the Users page.

### Demo accounts
The seed endpoint (`/api/seed`) creates the documented accounts — `admin@tcms.com /
Admin@123`, `teamlead@tcms.com / Lead@123`, `qa1@tcms.com / QA@12345`,
`viewer@tcms.com / View@12345` — but the login screen does NOT render quick-fill
buttons (they were removed when self-signup was restored; showing credential
quick-fills on a public page is an unnecessary exposure).

### Flow to remember
Login does **not** navigate anywhere — the auth store flips `user`, and the same
`page.tsx` now renders the shell whose default view is `dashboard`.

---

## 2. Dashboard — the QA Command Center

**File:** `src/components/views/dashboard-v2.tsx`. **ViewKey:** `'dashboard'`
(default after login). **Visible to:** every role; parts of it follow the permission matrix.

### Data
| Query | Endpoint | Refresh | Enabled |
|---|---|---|---|
| `['stats','dashboard']` | `GET /api/stats?action=dashboard` | 30 s | always |
| `['reviews','queue']` | `GET /api/reviews?action=queue` | 60 s | with `perform_review` |
| `['bugs','focus',userId]` | `GET /api/bugs?assignedToId=<me>` | 60 s | always |

`GET /api/stats?action=dashboard` returns totals, the status and severity breakdowns,
open bugs, `myPendingReviews` (personal) and `recentActivity` — the full feed for
`view_activity_logs` holders, otherwise only your own rows.

### Screen anatomy (top → bottom)
1. **Hero header** — greeting plus up to three buttons, each shown only with its
   permission: **New Test Case** (`create_test_case`), **Report Bug** (`create_bug`),
   **Reports** (`view_all_task_reports`).
2. **KPI cards** — Total Test Cases, Approved & Active, Open Bugs, My Pending Reviews (the
   last navigates only with `perform_review`).
3. **Quality Pipeline** — cases per status as a flow (click → test cases).
4. **Suite Health Score** — ring 0–100 from Approval (40) + Bugs (30) + Reviews (15) +
   Freshness (15); tiers Excellent / Good / Fair / At Risk.
5. **Status Mix** and **Bug Severity** charts (recharts), **Bug Lifecycle**.
6. **Focus Queue** — up to 8 items: my open reviews and the bugs assigned to me.
7. **Quick Actions** — New Test Case (`create_test_case`), Report Bug (`create_bug`),
   Reviews (`perform_review`), Tasks, Modules, Reports (`view_all_task_reports`).
8. **Latest Activity** — recent activity rows; **View all** → `activity-log` only with
   `view_activity_logs`; empty state *"No recent activity"*.

### States
- Loading: `DashboardSkeleton`.
- Query error: an `AlertTriangle` card.
- No mutations and no dialogs — the dashboard only reads.

### Why it matters architecturally
One `/api/stats` request aggregates across all domains (parallel queries, one shaped
object), so the landing page avoids N+1 client fan-out; polling keeps it fresh without
depending on the WebSocket service.
