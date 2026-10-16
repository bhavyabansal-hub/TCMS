# Authentication, Sessions & Permissions

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
everywhere uses the new value. 21 togglable actions × 6 roles = 126 cells
(`PERMISSION_ACTIONS` in `src/types/index.ts`; the `PUT` reply says `source: 'default'`
when the toggle removed the override row).

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
   `review.reviewerId === me.userId` (assigned reviewer only — no VP bypass).

The UI mirrors these rules so forbidden controls simply don't render (sidebar
items, action buttons, the Users and Permissions panels). **The UI checks are
convenience only — the API is the real gatekeeper.** A `viewer` calling the API
directly gets 403.

## 6. Endpoint-by-endpoint protection map

Verified against the services on 2026-10-16 (deep test, `docs/qa/DEEP-TEST-2026-10-16.md`).
✓ = session required (401 without). "own" checks happen after the permission check.

| Endpoint (method) | Auth | Permission / extra check |
|---|---|---|
| `GET /api`, `GET /api/ready` | none | liveness / readiness |
| `POST /api/auth?path=register` | none | only when `TCMS_ALLOW_SIGNUP=true` (else 403); creates a `viewer` |
| `POST /api/auth?path=login` / `refresh` / `logout` | none | per-email lock (5 → 60 s) + per-IP failed-sign-in limit (429) |
| `GET / PUT /api/auth` (me / profile / password), `?path=ws-ticket` | ✓ | self only; role/email immutable via this route |
| `GET / POST /api/seed` | none | 403 unless `TCMS_ENABLE_SEED=true`; no-op once any user exists |
| `GET /api/stats?action=dashboard` | ✓ | any role; the recent-activity part is the full feed with `view_activity_logs`, otherwise own rows only |
| `GET /api/stats?action=reports` | ✓ | `view_all_task_reports` |
| `GET /api/search` | ✓ | any role |
| `GET /api/modules` (tree, `?id=`) | ✓ | any role |
| `POST /api/modules` | ✓ | `create_module` |
| `PUT /api/modules?id=` | ✓ | `edit_module` |
| `PUT /api/modules?id=&action=submit-review` | ✓ | `submit_review`; only draft / needs_revision cases; closes their old open reviews |
| `DELETE /api/modules?id=` | ✓ | module creator **or** `edit_module` (hard delete; submodules + module reviews cascade, cases/bugs keep the row with `module_id` NULL) |
| `GET /api/test-cases` (list, `?id=`, history, reviews) | ✓ | any role |
| `POST /api/test-cases`, `?action=import`, `?action=import-template` | ✓ | `create_test_case` |
| `PUT /api/test-cases?id=` | ✓ | `edit_any_test_case` **or** (author ∧ `edit_own_test_case`); 409 on a stale `expectedUpdatedAt` |
| `PUT /api/test-cases?id=&action=submit-review` | ✓ | `submit_review`; 400 when the case is in_review or approved; closes the case's old open review |
| `DELETE /api/test-cases?id=`, `?action=bulk-delete` | ✓ | author **or** `delete_test_case` (hard delete) |
| `GET /api/reviews?action=queue` | ✓ | any role, own queue only |
| `GET /api/reviews` (all), `GET /api/reviews?id=` | ✓ | `perform_review` (403 otherwise) |
| `POST /api/reviews?id=` (verdict) | ✓ | `perform_review` ∧ assigned reviewer; 400 when the review is completed; 409 stale |
| `POST /api/reviews?id=&action=forward` | ✓ | `perform_review`; open reviews only |
| `GET /api/module-reviews?action=queue` | ✓ | any role, own queue only |
| `GET /api/module-reviews?action=all`, `?id=` | ✓ | `perform_review` |
| `POST /api/module-reviews?id=&action=bulk-verdict` / `approve-all` | ✓ | `perform_review` ∧ assigned reviewer; 409 stale |
| `POST /api/module-reviews?id=&action=change-reviewer` | ✓ | `perform_review` |
| `GET /api/bugs` (list, `?id=`, `&action=links`) | ✓ | any role |
| `POST /api/bugs` | ✓ | `create_bug`; an `assignedToId` additionally needs `assign_bug` |
| `PUT /api/bugs?id=` (fields, status) | ✓ | `create_bug` **or** `assign_bug`; 409 stale |
| `PUT /api/bugs?id=` changing the assignee | ✓ | additionally `assign_bug` (re-sending the current assignee needs nothing extra) |
| `PUT /api/bugs?id=&action=link-tc` | ✓ | `create_bug` **or** `assign_bug` |
| `DELETE /api/bugs?id=` | ✓ | `delete_bug` (hard delete; vp + manager by default) |
| `GET /api/task-reports?action=my` | ✓ | self |
| `GET /api/task-reports?action=summary` | ✓ | `view_all_task_reports` |
| `GET /api/task-reports?id=` | ✓ | owner ∨ `view_all_task_reports` |
| `GET /api/task-reports` (list, `?action=export`) | ✓ | without `view_all_task_reports` force-filtered to own rows |
| `POST /api/task-reports` (upsert) | ✓ | `create_task_report`; row owned by the caller |
| `PUT /api/task-reports?id=` | ✓ | `create_task_report` ∧ owner (even VPs cannot edit others' reports) |
| `GET /api/activity-logs` (all branches: list, `?action=entity`, `?action=user`) | ✓ | `view_activity_logs` |
| `GET /api/notifications`, `POST ?action=read-all` | ✓ | own rows only |
| `PATCH / DELETE /api/notifications?id=` | ✓ | owner only (403), unknown id 404 |
| `GET /api/users?action=options` | ✓ | any role (names + roles, no emails) |
| `GET / POST / PUT / DELETE /api/users` | ✓ | `manage_users`; **role rules:** only a VP may create a non-viewer account or change a role; nobody changes their own role; nobody deactivates themselves |
| `GET / PUT /api/permissions` | ✓ | `manage_permissions` (vp by default) |
| `GET /api/wiki` (list, `?id=`, `&action=download`) | ✓ | any role |
| `POST /api/wiki`, `?action=upload` | ✓ | `create_wiki_doc` |
| `PUT /api/wiki?id=` (+ `&action=upload`) | ✓ | author ∧ (`edit_own_wiki_doc` ∨ `edit_any_wiki_doc`), else `edit_any_wiki_doc` |
| `DELETE /api/wiki?id=` | ✓ | author **or** `delete_wiki_doc` |
| `/api/integrations/crewdesk` (all) | ✓ | `manage_integrations` |

Maintenance: with `TCMS_READ_ONLY=true` every write above answers 503 except login / refresh / logout.

## 7. Password change

`PUT /api/auth?path=password` with `{ currentPassword, newPassword }`: requires min 8
chars, verifies the current password (`400 Current password is incorrect` on mismatch),
re-bcrypts and saves, writes an `UPDATE/user` activity log. The client additionally
double-checks the confirmation field and length before even sending.

## 8. Honest security notes (worth knowing)

1. **`JWT_SECRET`**: with `TCMS_DEPLOY_ENV=production` the startup guard refuses to boot
   when it is missing, shorter than 32 characters or a placeholder (`src/lib/server/startup-guard.ts`).
2. **Formerly weak branches are closed** (2026-10-16 check): `GET /api/reviews` (all) needs
   `perform_review`; every `activity-logs` branch needs `view_activity_logs`.
3. **WS mini-service** joins a socket to `user:<id>` only with a valid 60 s HMAC ticket
   (`GET /api/auth?path=ws-ticket`, `WS_NOTIFY_SECRET`); without the secret it fails closed.
4. **CSRF**: `SameSite=Lax` httpOnly cookies + every state-changing request must carry a
   matching Origin or the `X-Requested-With: tcms` header (`assertSameOrigin`, `src/lib/api.ts`).
5. Search filters use case-INSENSITIVE `LIKE` on MySQL 8.4 (utf8mb4_unicode_ci columns) — since the 2026-10-14 migration;
   not a security one (documented in `docs/architecture/api-reference.md`).
