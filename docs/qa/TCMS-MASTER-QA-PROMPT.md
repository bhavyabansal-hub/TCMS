# TCMS — MASTER QA PROMPT (reusable)

> Copy-paste this entire document as the instruction set whenever TCMS needs a
> full deep-quality pass. It was authored and EXECUTED end-to-end on
> 2026-10-09 (results in `TCMS-TEST-REPORT-2026-10-09.md`). Every check below
> has a concrete probe; replace only the credentials/date as needed.

---

## ROLE

You are the QA + Security lead for TCMS (Next.js 16 App Router + Prisma +
MySQL 8.4, port 3000). Test EVERYTHING — do not sample. For every check,
record: what was probed, expected, observed, verdict. A claim without evidence
does not count. Do not say "checked the important areas" — check every area,
then prove it.

## ENVIRONMENT

- App: `http://localhost:3000` · health: `GET /api` → `{"status":"ok"}`
- Start/restart (Windows): `npm run dev` — see `docs/LOCAL-SETUP-WINDOWS.md`. Never `pkill -f next-server`
  (it kills the running dev server); database only at 127.0.0.1:5500 (never port 3306).
- Admin: `admin@tcms.com / Admin@123` · login: `POST /api/auth?path=login`
- Non-GET requests need `X-Requested-With: tcms` AND `Origin: http://localhost:3000` (CSRF funnel)
- Roles: vp > manager > product > developer > qa_engineer > viewer
  (defaults in `src/lib/permissions.ts`, runtime-togglable via `role_permissions`)
- Regression suites live in `scripts/verify-*.mjs` — run them ALL, they are the floor.

## PHASE 0 — BUILD & BOOT

1. `npx tsc --noEmit` → 0 errors.
2. `npm run build` → success; note warnings.
3. Restart the stack; `curl /api` healthy; `.env` contains `JWT_SECRET` (32+ chars) and `WS_NOTIFY_SECRET`.

## PHASE 1 — SECURITY (four parallel audit tracks, then live probes)

**Track A — Auth/session/CSRF:** login lockout (5 fails → 429, applies before password check,
no extension while locked, resets on success); cookie flags (`HttpOnly; SameSite=Lax`,
paths `/` and `/api/auth`); CSRF funnel on all 18 route files (POST without marker → 403;
evil Origin without marker → 403); JWT secret fail-fast at boot (no hardcoded fallback);
forged token with the old public secret → 401; forged random-sub token → 401 (DB revalidation);
rotation grace is one-shot (replayed pre-rotation token dies ≤120s and never re-extends);
logout revokes; password change requires current password, revokes all refresh tokens,
notifies (`password_changed`); login timing equalized (unknown email also does a bcrypt compare);
self-signup ALWAYS `viewer` — probe `role:"vp"`, `role:"superadmin"`, unknown keys, arrays →
role never sticks; duplicate email → 409; weak passwords → 400.

**Track B — Authorization/IDOR:** build the route→guard matrix for EVERY handler under
`src/app/api/**` (auth required? permission? object-level check? zod validation?).
Then log in as one real user per role and probe every mutation: expect exactly 403 where the
matrix says no, and verify the object-level rules (edit-own vs edit-any, delete = author-or-matrix,
review verdict = assigned reviewer only, notifications/task-reports strictly self-scoped,
users/permissions = manage_users/manage_permissions). Confirm: no mass-assignment
(authorId/reportedBy/createdAt are server-forced), self-role-change blocked for non-managers,
`PUT /api/bugs?action=link-tc` gated, `activity-logs?action=entity|user` gated by
`view_activity_logs`, dashboard `recentActivity` self-scoped for users without that permission.

**Track C — Injection/XSS/upload/limits:** every `$queryRaw`/`$executeRaw` parameterized
(Prisma.sql tagged templates; zero `Prisma.raw`/concat; static ORDER BY); wiki HTML sanitizer
is an ALLOWLIST (sanitize-html): probe `<svg/onload=…>`, `<img/src=x/onerror=…>`,
unquoted + entity-encoded `javascript:` hrefs, `<base>`, `<form>`, `<script>`, `<iframe>`,
inline `style:url(...)` — nothing active may survive create OR update; `rel="noopener noreferrer"`
forced on links; upload path: 10 MB cap, extension allowlist (.exe/.html rejected),
`Content-Disposition: attachment` on download, bytea in DB (nothing under `public/`);
field caps enforced server-side (title 200, description 2000, tags ≤10×40 for test cases;
506-char title → 400); pageSize clamped 1..100; malformed JSON/UUIDs → clean 400/404, no stack.

**Track D — Config/notifications/logs/patterns:** security headers on every response
(CSP with `frame-ancestors 'none'`, X-Frame-Options DENY, nosniff, Referrer-Policy,
Permissions-Policy, HSTS); no CORS wildcard+credentials; WS mini-service verifies a real
60s HMAC ticket (probe: `/notify` without `x-notify-secret` → 401; socket auth with fake
token → never joined); notification triggers fire for: review assigned, verdict, forward,
module review submit/bulk verdict, bug assigned, password changed, task report; delivery
failures never break the main request; notifications are per-user scoped (cross-user
PATCH/DELETE → 403); activity log immutable (INSERT/SELECT only) and audit-logged for
LOGIN/CREATE/UPDATE/DELETE/permission toggles; exactly ONE `new PrismaClient` (singleton);
controllers have no SQL; repositories have no business rules; serializers never leak
`password_hash` or raw rows; logger never logs secrets.

## PHASE 2 — DATA VOLUME (the sheet)

1. Create two modules ("QA Marathon Alpha/Beta").
2. Generate 105 realistic CSV rows each (`title,description,preconditions,priority,expected_result,tags`)
   and import through `POST /api/test-cases?action=import` — the SAME endpoint the Import
   tab uses. Target: 200+ test cases through the sheet path.
3. Verify per-row results: created counts, 0 unexpected failures; then DB-check
   fidelity (no truncated titles, all descriptions present, all drafts, author = importer).
4. Exercise pagination at volume (page size 20, total 400+).

## PHASE 3 — REVIEWS BY EVERY ROLE

1. Via admin: invite one reviewer per role (product, developer, qa_engineer, manager, vp).
2. Grant `perform_review` to developer + qa_engineer via the permission matrix
   (they lack it by default) — this also exercises the VP-togglable override system.
3. Submit one review per reviewer (distinct fresh test cases, correct `reviewerId` —
   note `/api/users?action=options` has NO email field; match by `fullName`).
4. Sign in as EACH reviewer and post a verdict (mix approved / needs_revision / failed
   with flagged fields). Verify in DB: `review_events` has one event per role,
   `notifications` for the author exist (`review_assigned` + verdict types).

## PHASE 4 — PERMISSION MATRIX (role × action, exhaustive)

For each role, sign in as a real user and probe EVERY action class:
list/create/edit/delete test cases (own vs any), bulk delete, submit review, verdict,
modules create/edit, bugs create/link/delete, task reports create/summary, users
list/role-change, permissions read/toggle, activity feed, wiki create/edit-any/delete,
reports stats, notifications, search, dashboard.
Assert EXACTLY: 2xx where allowed, 403 where not (404-allowed-through for missing targets).
Destructive probes must create their OWN fixture per role (no shared-fixture 404 noise).
Never probe role-changes against real users (use a non-existent id → 404-allowed).

**Override round-trips (the VP-togglable matrix):**
- grant `viewer:create_test_case` → viewer POST → 200 → revoke (default-restore) → 403;
- revoke `developer:perform_review` → verdict → 403 → re-grant → session refresh
  (`GET /api/auth`) carries it → verdict → 200.
- After the round-trip: `GET /api/permissions` shows `source:"override"` ONLY for the
  known seed grants — no leaked rows.

## PHASE 5 — FRONTEND / UI (Playwright, browser-level)

1. **Hover preview:** hover a test-case title → card appears with full title,
   DESCRIPTION section, preconditions/expected result when present, author + Updated
   footer; closes on pointer-out; row click STILL navigates to detail.
2. **Signup:** Create-account tab has NO group select; helper text mentions Viewer;
   register → lands in app as viewer (permissions []), Users/Activity nav hidden.
3. **Gated deep links:** viewer opens `/reports` (and `/settings/users`) → PermissionDenied,
   no privileged data render.
4. **Global sweep:** every tab renders for admin (dashboard, modules, test-cases,
   reviews, bugs, tasks, reports, activity-log, notifications, settings ×3,
   integrations, wiki).
5. **Volume + filters:** pagination over 400+ cases; filters + Reset (URL query cleared);
   import tab visible only for create-permission holders; bulk-delete row permanent
   (Delete/Clear always rendered, disabled when empty).

## PHASE 6 — DB, LOGS, NOTIFICATIONS

- DB: counts, orphans (cases→modules, reviews→cases, notifications→users, authors exist),
  version>1 cases have history rows, override hygiene, import fidelity.
- Logs: `logs/error-*.log` and `logs/app-*.log` (plus the dev server console) — no NEW errors during the run;
  no secrets anywhere in log lines.
- Notifications: verdict + assignment + password-changed rows exist; none to
  deactivated users (except self security alerts); WS push works with tickets.

## PHASE 7 — REGRESSION FLOOR (all must be green)

`verify-review-ux-round` (28) · `verify-bulk-delete-ui` (24) · `verify-deep-link-filters` (14) ·
`verify-wiki` (43) · `verify-wiki-ui` (24) · `verify-import` (33) · `verify-notifications` (29) ·
`verify-permissions` (31) · `verify-6-improvements` (10) · `verify-security-fixes` (32) ·
`verify-permission-matrix` (165) · `verify-ui-marathon` · `db-qa-checks`.

## PASS CRITERIA

- 0 CRITICAL / 0 HIGH findings open; every fix re-probed live with recorded status codes.
- 100% of the matrix expectations hold, twice in a row (stability).
- All regression suites green; tsc and build clean; logs clean for the session.
- Deliverables: findings ledger (severity, file:line, evidence, fix), probe log,
  updated suites, final report.
