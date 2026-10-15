# 06 · Pages — Login / Register & Dashboard

> Screens: **AuthScreen** (`src/components/auth-screen.tsx`) and **Dashboard**
> (`src/components/views/dashboard-v2.tsx`; the classic view described below is archived at `archive/src/components/views/dashboard.tsx`). These are the first two things every user
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

## 2. Dashboard — the landing overview

**File:** `archive/src/components/views/dashboard.tsx` (archived; live: `src/components/views/dashboard-v2.tsx`). **ViewKey:** `'dashboard'`
(default after login). **Visible to:** every role.

### Data
One query — `['stats','dashboard']` → `GET /api/stats?action=dashboard`, polling every
30 s:

```
{ totalTestCases, statusBreakdown[{status,count}], openBugs,
  severityBreakdown[{severity,count}], myPendingReviews, recentActivity[10] }
```

`myPendingReviews` is *personal* (reviews where I am the reviewer), which is why the
same dashboard shows different numbers to different roles.

### Screen anatomy (top → bottom)

1. **Greeting header** — `Welcome back, {first name} 👋` from the auth store, with two
   quick actions on the right: **"New Test Case"** → `navigate('test-cases')` and
   **"Report Bug"** → `navigate('bugs')`.
2. **Four KPI cards** (clickable, each navigates):

   | Card | Value source | Navigates to |
   |---|---|---|
   | Total Test Cases | `totalTestCases` | `test-cases` |
   | Open Bugs | `openBugs` | `bugs` |
   | My Pending Reviews | `myPendingReviews` | `reviews` |
   | Approved Test Cases | `statusBreakdown` entry `approved` | `test-cases` |

3. **Two charts (recharts), side by side:**
   - *Test Cases by Status* — donut `PieChart` over `statusBreakdown`.
     Colors: draft `#64748b`, in_review `#f59e0b`, needs_revision `#f97316`,
     approved `#10b981`, active `#22c55e`, deprecated `#a3a3a3`.
   - *Open Bugs by Severity* — horizontal `BarChart` over `severityBreakdown`.
     Colors: critical `#dc2626`, high `#ea580c`, medium `#f59e0b`, low `#0ea5e9`.
4. **Recent Activity feed** — last 10 `ActivityLog` rows (action badge, actor avatar,
   entity name, `timeAgo`); **"View all"** → `navigate('activity-log')` (menu item itself
   is lead/admin only, but the dashboard feed renders for everyone).

### States & permissions
- Loading: skeleton grid (`StateLoadingCards`).
- Query error: an `AlertTriangle` card *"Failed to load dashboard data."*
- Empty activity: *"No recent activity"*.
- No mutations, no dialogs, no role gates — the dashboard is read-only by design.

### Why it matters architecturally
The dashboard is the only screen that aggregates across *all* domains in a single
request — the `/api/stats` route runs six Prisma queries in parallel and returns one
shaped object, deliberately avoiding N+1 client fan-out. The 30-second polling is what
keeps the landing numbers fresh without the WebSocket dependency.
