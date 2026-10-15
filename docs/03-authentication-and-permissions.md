# 03 · Authentication, Sessions & Permissions

> How a user proves who they are, how the app remembers them, and exactly who is
> allowed to do what. Server logic: `src/lib/auth.ts`; client logic:
> `src/lib/client/api.ts` + `src/store/index.ts`; UI: `src/components/auth-screen.tsx`.

---

## 1. The two tokens (httpOnly cookie session)

| | **Access token** | **Refresh token** |
|---|---|---|
| Format | JWT (HS256), payload `{ sub, email, role, fullName, jti }` | JWT with extra `nonce`, plus a random suffix for uniqueness |
| Lifetime | **15 minutes** | **7 days** |
| Stored where | httpOnly cookie `tcms-access` (path=/, SameSite=Lax, Secure on https) — **never** in JS-readable storage | httpOnly cookie `tcms-refresh` (path=/api/auth so it is only sent to auth endpoints, SameSite=Lax, Secure on https) |
| Sent how | Automatically by the browser on every same-origin API/page request | Automatically on calls to `/api/auth/*` only |
| Server validation | `jsonwebtoken.verify` with `process.env.JWT_SECRET` | verify + lookup in `RefreshToken` table (must exist, not revoked, not expired) |
| Persisted server-side? | No (stateless) | Yes — one `RefreshToken` row enables revocation |

**Why cookies:** JavaScript can never read an httpOnly cookie, so a successful XSS
attack cannot exfiltrate the session — the strongest practical mitigation for a SPA.
`localStorage` keeps ONLY the non-sensitive display profile (`tcms-user`) for an
instant boot paint; the server `me` call is the real session check.

**Note on cookie Max-Age:** the `tcms-access` cookie lives 7 days even though the JWT
inside expires after 15 minutes. An expired-JWT cookie is harmless (the server always
verifies signature + exp) — but keeping the cookie present lets the edge proxy
(`src/proxy.ts`) distinguish "no session at all" from "session that just needs a
silent refresh", so a hard refresh after 15 idle minutes heals instead of flashing
the login page. Helpers: `src/lib/server/auth-cookies.ts`.

**CSRF protection (three layers):**
1. `SameSite=Lax` on both cookies — a cross-site POST can never carry the session.
2. `assertSameOrigin()` in `withApi()` — every state-changing request (POST/PUT/
   PATCH/DELETE) must either send an `Origin` matching a trusted host or be
   rejected 403. Trusted hosts: any entry of `x-forwarded-host` (proxy chains
   supported), `Host`, and the optional `TCMS_EXTRA_ALLOWED_HOSTS` env list
   (comma-separated — set it when a gateway/tunnel rewrites the Host header,
   e.g. the preview deployment). Hosts are compared case-insensitively with
   default ports (443/80) stripped; `Origin: null` is never trusted. Blocks are
   logged with the seen `origin`/`host`/`x-forwarded-host` values for diagnosis.
3. `X-Requested-With: tcms` custom header on every SPA call — cross-site JS cannot
   set a custom header without a CORS preflight, which the API never approves.
   (Requests that DO send an Origin skip this check; API test suites without a
   browser Origin must therefore always carry the marker.)

## 2. Login flow (start to finish)

```
AuthScreen (login tab)
  → authApi.login({ email, password })          POST /api/auth?path=login
      Server:
        1. assertSameOrigin (CSRF layer 2+3)    → 403 if cross-site
        2. zod loginSchema { email, password(min 1) }
        3. db.user.findUnique({ email })         → 401 'Invalid credentials' if missing
           …or isActive === false                → 401 'Invalid credentials'
        4. bcrypt.compareSync(password, passwordHash) → 401 if wrong
        5. createSession(user):
             accessToken  = jwt.sign(payload, secret, { expiresIn:'15m' })
             refreshToken = jwt.sign(payload+nonce, secret, { expiresIn:'7d' })
             db.refreshToken.create({ userId, token: refreshToken, expiresAt: +7d })
        6. logActivity(LOGIN/user)
        7. → 200 { user (publicUser), permissions } + Set-Cookie:
             tcms-access=<jwt>; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800
             tcms-refresh=<jwt>; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=604800
  → saveUser(user)                  // display profile ONLY — no tokens in JS
  → zustand setUser(user); toast 'Welcome back!'; AppShell renders
```

The response body carries **no tokens** — they exist only inside the httpOnly cookies.
`publicUser` (the only user shape ever returned): `{ userId, email, fullName, role,
isActive, avatarUrl, telegramChatId, notifyEmail, notifyTelegram, notifyInapp,
createdAt }` — **never** `passwordHash`.

**Self-signup is AVAILABLE (owner decision 2026-10-08)** via `POST
/api/auth?path=register` (`fullName`, `email`, `password`). New accounts are
created with the LEAST-privileged role (`viewer`) and are signed in
immediately (same session-cookie contract as login). Validation runs before
the service: name 2–80 chars, valid email, password ≥ 8 chars with at least
one letter and one number; a duplicate email answers **409**. Admins can
promote the role later from the Users page, and the event is audit-logged
(`CREATE` on `user`).

**Login brute-force guard:** every failed attempt is counted per email in the
`login_attempts` table. After **5 failed attempts the email is locked for 60 seconds**
(HTTP 429 `Too many failed attempts. Try again in Ns.`), even if the next password is
correct. When the lock expires the counter starts fresh; a successful login clears the
history immediately. Unknown emails count too (no user enumeration).

## 3. Session restore & logout

**Restore (page reload):** `AuthGate` → `useAuthStore.initialize()` checks the local
display profile (a HINT only — cookies are invisible to JS), then validates
server-side with `GET /api/auth` (`me`), which the browser authenticates with the
httpOnly access cookie. If the access JWT expired but the refresh cookie is still
valid, the first `me` call gets a 401, `request<T>()` transparently refreshes (below)
and retries — so a returning user within 7 days never sees a login screen. If
validation fails outright → `clearStoredUser()`.

**Logout:** `POST /api/auth?path=logout` (server reads the refresh cookie) revokes the
`RefreshToken` row (always 200) **and clears both httpOnly cookies** via
`Set-Cookie … Max-Age=0`. The client wipes the local display profile and the auth
store. The 15-minute access token may technically still work until expiry —
acceptable for this threat model; revocation protects the *renewal* path.

## 4. Automatic token refresh (the invisible 401 dance)

`request<T>(url, options, retry = true)` in `lib/client/api.ts`:

```
response.status === 401 && retry?
  → tryRefresh()  (single-flight: concurrent 401s share one refresh call)
      POST /api/auth?path=refresh with EMPTY body — server reads the
      httpOnly refresh cookie; every tab shares the browser's cookie jar,
      so the old multi-tab localStorage rescue is unnecessary.
      ok  → server Set-Cookie re-arms the jar → retry original request ONCE
      bad → clearStoredUser() + window.location.assign('/login?next=<path>')
            // explicit redirect, never a silent reload loop
```

Server-side refresh (`?path=refresh`), in order: no cookie/body token → 401; row
missing / `revoked` / expired → 401 `Invalid or expired refresh token`; JWT verify
fail → 401; user missing/inactive → 401. On success the old row gets a short
**rotation grace window** (heals a dropped response) and a **new pair** is issued and
set as fresh cookies (rotation — a stolen refresh token stops working after the next
legitimate refresh).

## 5. Roles & the togglable permission matrix

Six roles, hierarchy `viewer (0) < qa_engineer (1) < developer (2) < product (3) <
manager (4) < vp (5)`. VP is the top admin.

| Role | Intended for | Default capabilities (every cell is togglable) |
|---|---|---|
| `viewer` | Read-only stakeholders | Browse: dashboard, module tree, case lists/details, notifications, profile |
| `qa_engineer` | Writing test cases | + create cases, edit **own** cases, submit reviews, report bugs, daily task reports |
| `developer` | Engineering | + report bugs, daily task reports |
| `product` | Product owners | + create/edit modules, create cases & edit own, perform reviews, view all reports & activity |
| `manager` | Team managers | + edit/delete any case, delete bugs, assign bugs, user management, Reports & Activity Log |
| `vp` | System owner | + manage the permission matrix itself; everything else |

**The matrix is runtime-togglable — not hardcoded.** Defaults live in
`src/lib/permissions.ts` (`DEFAULT_PERMISSIONS`); deviations live in the
`role_permissions` table (one row per toggled cell). The VP opens the
**Permissions** panel and flips any cell (e.g. "let Developers create test
cases") — the change applies immediately: `PUT /api/permissions` upserts the
override, invalidates the in-memory cache, and the next permission check
everywhere uses the new value. 16 togglable actions × 6 roles.

How checks resolve: `can(role, action)` (src/lib/permissions.ts) consults the
override cache first, then falls back to defaults; services gate through
`ensurePermission(me, action)` / `requirePermission(action)` exactly as before.
Session payloads (login/register/me) carry the user's effective `permissions`
array, and the UI gates with `useAuthStore.can(action)` — so hiding a panel and
enforcing an API rule are the same source of truth.

Two enforcement layers exist and both are always applied:

1. **Permission matrix** — coarse capability check (above; overrides win).
2. **Ownership checks** in the services — e.g. `edit_own_test_case` additionally
   verifies `case.authorId === me.userId`; review verdicts verify
   `review.reviewerId === me.userId || role === 'vp'`.

The UI mirrors these rules so forbidden controls simply don't render (sidebar
items, action buttons, the Users and Permissions panels). **The UI checks are
convenience only — the API is the real gatekeeper.** A `viewer` calling the API
directly gets 403.

## 6. Endpoint-by-endpoint protection map

| Endpoint (method) | Auth | Permission / extra check |
|---|---|---|
| `POST /api/auth?path=register` | — | Self-signup → creates a `viewer` account + signs in (409 duplicate, 400 invalid) |
| `POST /api/auth?path=login` | none | — |
| `POST /api/auth?path=refresh` / `logout` | none | refresh: valid unrevoked token row |
| `GET / PUT /api/auth` (me / profile / password) | ✓ | self only; role/email immutable via this route |
| `GET /api/seed` / `POST /api/seed` | none | no-op once any user exists |
| `GET /api/stats?action=dashboard` | ✓ | any role |
| `GET /api/stats?action=reports` | ✓ | `view_all_task_reports` (403 `Team lead or admin only`) |
| `GET /api/modules` (+`?id=`) | ✓ | any role |
| `POST /api/modules` | ✓ | `create_module` |
| `PUT /api/modules?id=` | ✓ | `edit_module` |
| `PUT /api/modules?id=&action=submit-review` | ✓ | `submit_review` |
| `DELETE /api/modules?id=` | ✓ | `admin`/`team_lead` **or** module creator |
| `GET /api/test-cases` (list/history/reviews/detail) | ✓ | any role |
| `POST /api/test-cases` | ✓ | `create_test_case` |
| `PUT /api/test-cases?id=` | ✓ | `edit_any_test_case` **or** (author ∧ `edit_own_test_case`) |
| `PUT /api/test-cases?id=&action=submit-review` | ✓ | `submit_review` |
| `DELETE /api/test-cases?id=` | ✓ | author **or** `delete_test_case` (PERMANENT delete — row + history + review links removed; confirm dialog client-side) |
| `GET /api/reviews?id=` / `?action=queue` | ✓ | any role |
| `GET /api/reviews` (all, paginated) | ✓ | any role *(weak spot — see §8)* |
| `POST /api/reviews?id=` (verdict) | ✓ | `perform_review` ∧ (assigned reviewer ∨ admin) |
| `GET /api/module-reviews` (`?action=queue`) | ✓ | any role |
| `GET /api/module-reviews?action=all` | ✓ | `view_all_task_reports` |
| `GET /api/module-reviews?id=` | ✓ | any role |
| `POST /api/module-reviews?id=&action=approve-all` | ✓ | `perform_review` ∧ (assigned reviewer ∨ admin) |
| `GET /api/bugs` (list/detail/links) | ✓ | any role |
| `POST /api/bugs` | ✓ | `create_bug` |
| `PUT /api/bugs?id=` (fields) | ✓ | any authenticated user *(by design: anyone can move a board card)* |
| `PUT /api/bugs?id=` (with `assignedToId`) | ✓ | additionally `assign_bug`, else 403 |
| `PUT /api/bugs?id=&action=link-tc` | ✓ | any authenticated user |
| `DELETE /api/bugs?id=` | ✓ | **admin only** (hard delete) |
| `GET /api/task-reports?action=my` | ✓ | self |
| `GET /api/task-reports?action=summary` | ✓ | `view_all_task_reports` |
| `GET /api/task-reports?id=` | ✓ | owner ∨ `view_all_task_reports` |
| `GET /api/task-reports` (list) | ✓ | non-managers force-filtered to own rows |
| `POST /api/task-reports` (upsert) | ✓ | `create_task_report`; row owned by caller |
| `PUT /api/task-reports?id=` | ✓ | **owner only** (even admins can't edit others' reports) |
| `GET /api/activity-logs` (full list) | ✓ | `view_activity_logs` |
| `GET /api/activity-logs?action=entity` / `=user` | ✓ | any authenticated user *(check happens after these branches — see §8)* |
| `GET /api/notifications` | ✓ | always scoped to `userId = me` |
| `POST /api/notifications?action=read-all` | ✓ | self rows only |
| `PATCH/DELETE /api/notifications?id=` | ✓ | owner only (400 `Not your notification` otherwise) |
| `/api/users` **all methods** | ✓ | `manage_users` → effectively **admin only** (403 `Admin only`) |

## 7. Password change

`PUT /api/auth?path=password` with `{ currentPassword, newPassword }`: requires min 8
chars, verifies the current password (`400 Current password is incorrect` on mismatch),
re-bcrypts and saves, writes an `UPDATE/user` activity log. The client additionally
double-checks the confirmation field and length before even sending.

## 8. Honest security notes (worth knowing)

1. **`JWT_SECRET` fallback**: if the env var is missing, a hardcoded dev secret is used.
   The deployment guide's checklist makes setting it mandatory — on Vercel it is one of
   the 3 required variables.
2. **Weaker branches** (documented, by design acceptable for a team tool): `GET
   /api/reviews` (all) has no role gate; `activity-logs?action=entity|user` run before
   the permission check. Both still require a valid login.
3. **WS mini-service does not validate tokens** (`token: 'dev'` placeholder) — it only
   relays notification payloads to a `user:<id>` room; compromise impact is limited to
   seeing your own notification stream early. Documented in `12-realtime-and-deployment.md`.
4. No CSRF protection beyond `SameSite=Lax` cookie + Bearer-header requirement — the
   API never relies on the cookie alone (a browser-initiated cross-site form post would
   lack the `Authorization` header).
5. Search filters use case-INSENSITIVE `LIKE` on MySQL 8.4 (utf8mb4_unicode_ci columns) — since the 2026-10-14 migration;
   not a security one (documented in `04-api-reference.md`).
