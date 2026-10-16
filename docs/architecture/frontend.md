# Frontend Architecture — how the client is built

> The browser side is a single-page application: one URL, fourteen views, three state
> systems with clear jobs. This document explains the machinery; documents 06–10 walk
> through each view.

---

## 1. Three state systems, three jobs

| System | File | Owns | Example |
|---|---|---|---|
| **Zustand** (client state) | `src/store/index.ts` | *Who am I, where am I, what did the bell just tell me* | `useAuthStore`, `useViewStore`, `useNotificationsStore` |
| **React Query** (server state) | `providers.tsx` + usage in views | *What has the API returned, when is it stale, what to refetch after a mutation* | `['test-cases','list',filters]` |
| **Component state** (`useState`) | each view | *Transient UI: dialogs, text inputs, page numbers* | `createOpen`, `search`, `page` |

Rule of thumb: **nothing derived from the server is ever copied into Zustand** (except
notifications, which are push-updated); Zustand's `user` is a mirror of the server
session used for instant rendering and permission gating.

## 2. Zustand stores (exact shape)

### `useAuthStore`
```
{ user, isLoading, isInitialized, sessionError,
  initialize()                     // read localStorage → GET /api/auth → validate
                                   //   transient failure → sessionError=true (retry card,
                                   //   tokens KEPT — user is NOT bounced to /login)
  retrySession()                   // re-run the session check from the retry card
  login(email, password)           // authApi.login → setSession → setUser
  register(data)                   // same for register
  logout()                         // authApi.logout → clearSession → user=null
  setUser(user)                    // used by profile updates
  can(action) / canAny(actions)    // permission-matrix checks against user.permissions
}
```
`initialize()` runs once from `AuthGate`; until booted && isInitialized the whole app
shows a centred spinner. This is the **session restore** path. `can()`/`canAny()` are
the ONLY way views gate UI — never compare `user.role` strings inline.

### URL routing — every page is a real route
```
src/lib/routes.ts                 // ViewKey <-> path map (single source of truth)
pathForView(view, params)         // build the URL for a view
viewFromPath(pathname)            // resolve a URL back to {view, params}
safeNextPath(raw)                 // sanitize ?next= (open-redirect safe)
navigate(view, params)            // store action — pushes the mapped URL
<RouteSync/>                      // bridges browser back/forward + deep links
                                  // into useViewStore on every URL change
```
Pages live in `src/app/(app)/**/page.tsx` (`/dashboard`, `/modules`, `/test-cases`,
`/test-cases/[id]`, `/reviews`, `/reviews/[id]`, `/module-reviews/[id]`, `/bugs`,
`/tasks`, `/reports`, `/activity-log`, `/notifications`, `/settings/*`). Refresh,
bookmarks and shared links restore the SAME view now; `src/proxy.ts` redirects
anonymous page requests to `/login?next=<path>` first. `useViewStore` still decides
which view component renders — but every store change is a URL change, so they cannot
disagree.

### `useViewStore` — view state mirrored to the URL
```
type ViewKey = 'dashboard' | 'modules' | 'test-cases' | 'reviews' | 'bugs' |
  'tasks' | 'reports' | 'activity-log' | 'notifications' | 'settings-users' |
  'settings-permissions' | 'settings-profile' | 'test-case-detail' |
  'review-detail' | 'module-review-detail'

{ current: ViewKey, params: Record<string,string>,
  navigate(view, params?) }        // set() + router.push(pathForView(view, params))
```
The `(app)` pages resolve `viewFromPath(pathname)` and hand the result to the store;
`navigate()` pushes the mapped URL through the router bridge. The three `*-detail`
views read `params.id`. Refresh restores the SAME view (URL is the truth), and
`/login?next=` returns you to where you were headed after signing in.

### `useNotificationsStore`
```
{ items: Notification[], unreadCount,
  setItems(list)                   // seeded from GET /api/notifications (50)
  addNotification(n)               // WS push → prepend, cap 50
  markAllRead() / markRead(id) / remove(id) }
```
Consumed by the topbar bell, the Notifications view, and the socket hook.

## 3. The data layer — `src/lib/client/api.ts`

A plain fetch client (no React Query code in it). Pieces:

1. **Session helpers** — `getAccessToken/getRefreshToken/getStoredUser/setSession/clearSession`
   over `localStorage` keys `tcms-access`, `tcms-refresh`, `tcms-user`; `setSession`
   also writes the `tcms-access` cookie so server routes can read the JWT.
2. **`request<T>(url, options, retry=true)`** — sets `Content-Type: application/json`
   and `Authorization: Bearer <token>`; on 401 (first attempt) calls `tryRefresh()`
   (single-flight) then retries once; on refresh failure wipes the session and reloads.
   Non-OK responses throw `ApiError { status, data, message }` where `message` comes
   from the server's `{ error }` body. 204 → `undefined`.
3. **Namespaced endpoint functions** — `authApi`, `usersApi`, `modulesApi`,
   `testCasesApi`, `reviewsApi`, `moduleReviewsApi`, `bugsApi`, `taskReportsApi`,
   `notificationsApi`, `activityLogsApi`, `statsApi`, `seedApi`. One function per
   endpoint; they only build URLs and parse nothing. (Full inventory with routes:
   `docs/architecture/api-reference.md`.)

## 4. React Query conventions (live in the views)

Global defaults (`providers.tsx`): **staleTime 30 s · retry 1 · refetchOnWindowFocus
false**. Two polling loops exist: dashboard stats and the two sidebar review queues
(`refetchInterval: 30_000`).

### Cache key inventory (exact)

| Key | Used by | Notes |
|---|---|---|
| `['stats','dashboard']` | dashboard | 30 s polling |
| `['stats','reports']` | reports | |
| `['modules','tree']` | modules + every module picker | |
| `['modules','detail',id]` | modules view | `enabled: !!selectedId` |
| `['test-cases','list',{search,statusFilter,priorityFilter,moduleFilter,page}]` | test-cases table | filters are part of the key |
| `['test-cases','list','all-light']` | tasks/bugs pickers | pageSize 200 |
| `['test-cases','detail',id]` / `['test-cases','history',id]` / `['test-cases','reviews',id]` | case detail page | |
| `['reviews','queue']` + `['module-reviews','queue']` | sidebar badge + reviews view | 30 s polling, `enabled: !!user` |
| `['reviews','all']` / `['module-reviews','all']` | reviews "All" tab | `enabled: tab==='all'`; both need `perform_review` |
| `['reviews','detail',id]` / `['module-reviews','detail',id]` | detail pages | |
| `['bugs','list']` | bugs board/table | pageSize 200 |
| `['users','all']` / `['users','list',params]` | pickers, Users page, activity filter | |
| `['task-reports','my']` / `['task-reports','user',userId,date]` | tasks view | `view_all_task_reports` vs self variants |
| `['notifications']` | — (store is primary) | invalidated after read/delete |
| `['activity-logs',params]` / `['activity','test_case',id]` | activity log, case detail | |

### Mutation pattern (no optimistic updates, by design)

```
mutation.mutate(body)
  onSuccess:  toast.success('…')
              qc.invalidateQueries({ queryKey: [rootKey, …] })   // sometimes precise keys too
              navigate(…) when a redirect makes sense
  onError:    handleApiError(err, 'Fallback message')
```

Coarse root keys (`['test-cases']`, `['modules']`, `['bugs']`, `['reviews']`,
`['module-reviews']`, `['users']`, `['task-reports']`, `['notifications']`) keep
invalidation simple and correct; precise keys (`['reviews','queue']`,
`['test-cases','detail',id]`) refresh the visibly-open data faster. The cost of this
simplicity — a few extra refetches — is negligible at this data scale.

## 5. Error handling & toasts

- **sonner** is the toast engine (`import { toast } from 'sonner'`); `layout.tsx`
  mounts `<SonnerToaster position="top-right"/>`. (The legacy radix toast stack was
  removed in the Oct 2026 cleanup — `ui/toast.tsx`, `hooks/use-toast.ts` no longer exist.)
- `lib/errors.ts` maps thrown `ApiError`s to friendly text:
  network → *"Network error — please check your connection."*; 400 → *"Invalid input…"*;
  401 → *"Your session has expired…"*; 403 → *"You do not have permission to do this."*;
  404 → *"This item no longer exists."*; 500 → *"Server error…"*; server-provided
  `data.error` always wins over the generic text.
- `handleMutation(promise, { success })` wraps the common then/catch/toast dance.

## 6. Rendering building blocks

- **shadcn/ui primitives** (`src/components/ui/*`, ~40 files): Radix-based,
  Tailwind-styled, template-provided. Views mainly use button, card, dialog,
  alert-dialog, select, input, textarea, table, badge, tabs, switch, checkbox, sheet,
  popover, dropdown-menu, avatar, tooltip, scroll-area, calendar, alert, separator.
- **shared/state.tsx** — one vocabulary for async UI: `StateLoading(rows)`,
  `StateLoadingCards(n)`, `StateSpinner(label)`, `StateEmpty({icon,title,…,action})`,
  `StateError({message,onRetry})`.
- **shared/pagination.tsx** — `<Pagination page totalPages total onPageChange>`; renders
  nothing when there's a single page. Used by the test-cases table; activity-log and
  users use a custom Prev/Next pair because they disable buttons while `isFetching`.
- **lib/format.ts** — every color map and formatter the views use (exact mappings):
  `statusColor` (draft slate, in_review amber, needs_revision orange, approved emerald,
  active green, deprecated zinc), `priorityColor` (P0 red, P1 orange, P2 yellow, P3
  sky), `bugStatusColor`, `severityColor`, `verdictColor`, `roleColor` (vp purple,
  manager indigo, product amber, developer cyan, qa teal, viewer slate), `actionColor` (by prefix: CREATE emerald,
  UPDATE amber, DELETE rose, STATUS sky, LOGIN slate, REVIEW purple),
  `reviewStatusColor`; formatters `formatDateTime`, `formatDate`, `timeAgo`,
  `minutesToHuman`, `truncate` (all `en-US`).

## 7. Component composition of a typical view

Every view follows the same skeleton — this consistency is what makes the app easy to extend:

```tsx
export default function SomethingView() {
  const { user } = useAuthStore()               // 1. identity + role gates
  const qc = useQueryClient()
  const { data, isLoading } = useQuery(key, fn) // 2. server data
  const [filter, setFilter] = useState(...)     // 3. local UI state
  const x = useMutation(...)                    // 4. mutations w/ toast+invalidate
  if (isLoading) return <StateLoading/>         // 5. async states
  return (                                       // 6. layout: header → filters → content
    <div>…toolbar… table/cards… dialogs…</div>
  )
}
```

Role gating always goes through the permission-matrix helpers — `can('action')` /
`canAny([...])` from `useAuthStore` — which mirror the API's real server-side checks
(`requirePermission`/`ensurePermission`). Never compare `user.role` strings inline.

## 8. Theming & styling

- `globals.css` (Tailwind v4): `@theme inline` maps shadcn CSS variables
  (`--background`, `--primary`, `--chart-1..5`, `--sidebar-*`, `--radius: 0.625rem`)
  in **oklch**, with a `.dark` class variant. `tailwind.config.ts` keeps the legacy
  hsl-var mapping for compatibility.
- **Dark mode**: next-themes (`attribute="class"`, `defaultTheme="light"`) — toggled
  from the topbar sun/moon button, persisted in localStorage. The `.dark` palette is a
  "soft graphite" ramp (surfaces ≈ `#272b33`, stepped background < card < popover,
  translucent-white borders) — deliberately NOT pitch black. All colors are token-driven;
  the only hardcoded `bg-black`/`text-white` classes are intentional (overlays, badges,
  destructive buttons). Light mode tokens are untouched by dark mode.
- Fonts: Geist / Geist Mono via `layout.tsx`.
- Chart hex palettes live in `lib/format.ts` (`STATUS_HEX`, `SEVERITY_HEX`,
  `PRIORITY_HEX`, `BUG_STATUS_HEX` + `statusHex`/`severityHex`/`priorityHex`/
  `bugStatusHex` fallback lookups) — views never declare their own.

## 9. Quirks worth knowing (documented, harmless)

1. Module-review per-case Fail/Needs-Revision prompts use `window.prompt` while the
   approve-all flow and single review detail use rich dialogs — a UX inconsistency,
   not a bug (on the polish backlog).
2. Bug delete inside the detail sheet has **no confirmation dialog**.
3. The socket hook's WS auth sends `token: 'dev'` (server doesn't validate — see `docs/architecture/realtime-and-notifications.md`).
4. The bugs board query key is intentionally filter-free (`['bugs','list']`): the board
   fetches a fixed page (pageSize=200) and filters client-side.
