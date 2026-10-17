# Pages — Activity Log, Notifications, Users, Profile

> Files: `views/activity-log.tsx` (463), `views/notifications.tsx` (253),
> `views/settings-users.tsx` (522), `views/settings-profile.tsx` (322).
> The governance corner of the app: the audit trail, the inbox, account
> administration, and self-service settings.

---

## 1. Activity Log (`'activity-log'`) — the audit trail UI

### Access
`view_activity_logs` holders (vp, manager, product by default; sidebar-hidden for others; the API enforces the same permission).

### Data
`['activity-logs',params]` → `GET /api/activity-logs?page&pageSize=50&userId&entityType&action&dateFrom&dateTo`.
Plus `['users','list','activity']` for the user filter.

### Filters card (each change resets page to 1)
From / To date pickers · User select (*All users*) · Entity select (`module,
test_case, review, bug, task_report, user`) · Action select (`CREATE, UPDATE, DELETE,
STATUS, LOGIN, REVIEW`) · **Reset** button.

### Table
| Column | Detail |
|---|---|
| Timestamp | `formatDateTime` |
| User | avatar + name, or **System** when `userId` is null |
| Action | colored badge via `actionColor` (prefix-based: CREATE emerald, UPDATE amber, DELETE rose, STATUS sky, LOGIN slate, REVIEW purple) |
| Entity | badge with `entityType` |
| Name | **clickable** (row-independent, `stopPropagation`) → cross-navigation: `test_case` → case detail `{id}`, `bug` → bugs view, `module` → modules, `review` → reviews |
| Changes | `{n} field(s)` badge when a `diff` exists, else `—` |

Row click → **ActivityDetailDialog**: title = action + entity badges + entity name;
description = actor, timestamp, optional IP; body = *Changed fields (N)* with a
**DiffRow per field** — red "Before" panel (strikethrough) vs green "After" panel,
values JSON-pretty-printed when not plain strings. Empty diff → *"No field-level
changes recorded."*

Pagination: custom Prev/Next disabled while `isFetching`, caption
`{total} entries · page {page} of {totalPages}` (deliberately not the shared
`<Pagination>` component — it needs the fetching-disable behaviour).

### Where the data comes from (remind)
Every route's `logActivity()` call wrote `beforeSnapshot`/`afterSnapshot` and a
computed `diff` (`{field: {before, after}}`, shallow JSON comparison). Nothing writes
to this table from the UI — it is append-only by design.

---

## 2. Notifications view (`'notifications'`) — the inbox

### Data source (special!)
This view does **not** run its own list query. The **Zustand notifications store is the
single source of truth**: seeded once by `useNotificationSocket` (fetch of latest 50),
then updated by WebSocket pushes and local mark-read/remove actions. The API's
paginated `GET /api/notifications` remains the canonical store; the UI list is a cache.

### Screen
- Header: *"Notifications"* + subtitle `You have N unread notification(s).` or
  *"You're all caught up."* + **Mark all read** (only when unread > 0; POSTs
  `?action=read-all`, updates store, invalidates `['notifications']`, toasts).
- List items: type-specific icon + color — review_* → ClipboardCheck, `bug_assigned`
  → Bug, `test_case_updated` → FileEdit, `module_created` → FolderTree,
  `comment_added` → MessageSquare, fallback Bell. Unread items get a tinted
  background + emerald dot.
- **Item click** (or Enter/Space — keyboard accessible): mark read via PATCH (errors
  silently ignored) → **deep-link by `entityType`**: `test_case` → case detail
  `{entityId}`, `bug` → bugs, `module` → modules, `review` → reviews, else no-op.
- Hover **X** button → `DELETE /api/notifications?id=` → store remove + invalidate.
- Empty state: green CheckCheck icon, *"You're all caught up"*, caption *"New
  notifications will appear here in real time."*

The same items (first 10) appear in the **topbar bell popover**, sharing the store —
marking read in either place updates both instantly.

---

## 2b. Outbound delivery — email + Telegram (`src/lib/server/delivery.ts`)

Every in-app notification can ALSO go out via email (SMTP) and Telegram (Bot API).
Both channels are env-gated and per-user preference-gated (`notify_email`,
`notify_telegram` in Settings → Profile; per-user `telegram_chat_id`):

| Channel | Needs | Timeout | Failure behavior |
|---|---|---|---|
| Email | `SMTP_HOST` (+ optional `SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM/SMTP_SECURE`) | 8 s | logged via `logger.error`, marked `failed`, request unaffected |
| Telegram | `TELEGRAM_BOT_TOKEN` (chat id from the user row) | 5 s | logged, marked `failed`, request unaffected |

Missing configuration = channel `skipped` (log line `Notification delivery attempted
{"channels":"email:skipped telegram:skipped"}`). Delivery NEVER throws and NEVER
blocks the business action that produced the notification. When IT provides SMTP
settings and a bot token, set them in `.env` and test ONLY to the owner's own
account (admin@tcms.com + own chat id) — never to colleagues.

## 3. Users (`'settings-users'`) — user management

### Access
`manage_users` holders (vp + manager by default): sidebar-gated, the view renders an
*"Admins only"* alert otherwise, and every `/api/users` method returns 403 without
`manage_users` regardless of the UI.

### Role rules (client + server agree)
Only a **VP** may set or change a role (`canAssignRoles` in `src/lib/roles.ts`). For
every other user manager the inline Role selects are disabled and invites are created
as `viewer` (`DEFAULT_INVITE_ROLE`); the API answers 403 to anything else.

### Data & mutations
`['users','list',params]` → `GET /api/users?page&pageSize=50&role&isActive`;
create/update/delete mutations → POST / PUT / DELETE with `{ role? }`, `{ isActive? }`
etc.; all invalidate `['users']`; toasts `User invited` / `User updated` /
`User deactivated`.

### Filters & table
Role select (All roles + the six roles) and Status select (All/Active/
Inactive), both reset page. Table: avatar + name (**"(you)"** marker) + email ·
**inline Role select** · **Active Switch** · Member since · trash button.

### Self-protection rules (client + server agree)
You cannot change your **own** role, deactivate yourself, or delete yourself — the
controls are disabled for the current user's row (`Cannot delete yourself` server-side).

### Invite dialog
*"Invite a new user"* — Email, Full name, **Temporary password** (min 8, client-blocked
otherwise), Role select (enabled for a VP only; everyone else invites a `viewer`).
They can sign in immediately.

### Delete dialog
*"Delete user?"* — explains the soft-delete semantics verbatim: *"This will deactivate
{name} and revoke their access. Their historical data (test cases, bugs, reports) will
be preserved."* Confirm is red; row kept with `isActive: false` (login rejected).

---

## 4. Profile (`'settings-profile'`) — self service

### Account card
Avatar initials, full name, email, role badge (`roleColor`), *"Member since"* date.
Read-only identity (email change is deliberately impossible: the API whitelist never
includes it; the input is disabled with a caption *"Email cannot be changed. Contact an
admin if it needs updating."*).

### ProfileForm
Fields: Full name (required), Email (disabled), Avatar URL (`type=url`), Telegram chat
ID, three **Switch** toggles — *Email notifications*, *Telegram notifications*,
*In-app notifications* (only `notifyInapp` has a live server-side effect today:
`createNotification` skips rows for users with it off; the other two are stored
preferences).
Save → `PUT /api/auth` (whitelist: `fullName, avatarUrl, telegramChatId, notifyEmail,
notifyTelegram, notifyInapp`) → `authStore.setUser(updated)` so the topbar/name update
instantly → toast `Profile updated`.

### PasswordForm
Current / New / Confirm password. Client checks: new ≥ 8 chars, confirm matches
(mismatch shows a persistent destructive alert while both fields are non-empty and
differ). Submit → `PUT /api/auth?path=password` → server re-verifies the current
password (400 `Current password is incorrect` on mismatch), re-bcrypts, logs
`UPDATE/user`. Toast `Password changed`, fields cleared. Other sessions keep working
until their access token expires (15 min) — a reasonable trade-off documented here.

---

## 5. How these four views interlock (the governance loop)

```
every mutation ──▶ ActivityLog (audit)  ──▶ Activity Log view (leads audit it)
      │
      └─▶ Notification row (inbox) ──▶ bell popover / Notifications view
                    │                        (click = deep link to the entity)
                    └─▶ WS push (instant) ── otherwise visible on next fetch
Users view controls who can log in and with which role ──▶ every gate in `docs/architecture/auth-and-permissions.md`/06–09
Profile keeps identity + delivery preferences truthful ──▶ notification skip logic
```
