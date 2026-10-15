# TCMS — FULL TEST REPORT — 2026-10-09

**Scope executed:** 2 features (hover preview, default-viewer signup) + 4-track
security audit (4 parallel agents) + 13 security fixes + 210 test cases imported
through the sheet path (512 total in DB) + reviews performed by product,
developer, QA engineer, manager and VP + 165-check permission matrix (×2 runs)
+ browser UI marathon + 29 DB deep checks + full regression battery.
**Every number below is a live-verified probe result, not an assumption.**

---

## 1. FEATURES SHIPPED

### 1.1 Hover preview on test-case titles
- Hovering a row title opens a non-modal card: full (untruncated) title,
  priority/status/module chips, full DESCRIPTION, PRECONDITIONS, EXPECTED
  RESULT, tags, author + Updated footer. Zero extra API calls (list already
  returns `tc.*`). Card closes on pointer-out; the row click still navigates
  to the detail page (hover never steals the click).
- UI suite: 11/11 checks (appear, sections, close, click-through, volume).

### 1.2 Create-account: group chooser removed, everyone starts as Viewer
- UI: group select deleted; helper text: "New accounts start with Viewer
  access — an admin can change your group later from the Users page."
- **Server-enforced, not just UI:** the register zod schema no longer accepts
  `role` (unknown keys stripped) AND `registerUser` hard-codes `viewer`
  (defense in depth). Live-probed `role:"vp"`, `role:"superadmin"`, unknown
  keys, arrays — the stored role is ALWAYS `viewer`, permissions `[]`.
- Role changes afterwards only via the Users page (`manage_users` gate).

## 2. SECURITY AUDIT — FINDINGS LEDGER (4 parallel agents)

### CRITICAL (3) — all fixed & re-verified
| # | Finding | Evidence | Fix |
|---|---------|----------|-----|
| C1 | **JWT secret fallback live** — `JWT_SECRET` unset → hardcoded public fallback signed real admin tokens | Forged HS256 token → `GET /api/users` 200 | Strong random secret in `.env`; `config.ts` fail-fast at boot (<32 chars throws); forged probes now 401 (old-secret + random-sub) |
| C2 | **Wiki sanitizer bypass → stored XSS** — regex chain defeated by `<svg/onload=…>`, entity-encoded `javascript:`, `<base>`, `<form>` | Stored verbatim via create/update; rendered with `dangerouslySetInnerHTML` | Replaced with allowlist `sanitize-html` (tags/attrs/schemes limited, `rel="noopener noreferrer"` forced, `data:`/protocol-relative blocked) — 11 XSS vectors re-probed, nothing active survives; clean HTML preserved |
| C3 | **WS mini-service accepted any identity** — client sent `token:'dev'`, never verified; cross-user eavesdrop + spoofed pushes | Fake token subscribed to admin's stream via gateway | 60s HMAC ticket (`GET /api/auth?path=ws-ticket`) verified by the mini-service (shared `WS_NOTIFY_SECRET`); `/notify` now requires `x-notify-secret` (401 without); fail-closed if secret missing |

### HIGH (5) — all fixed & re-verified
- **H1** `PUT /api/bugs?action=link-tc` ran with NO permission check (viewer
  could link test cases to any bug) → now requires create_bug/assign_bug,
  unknown ids → 404 (was silent 200). Live: viewer 403, admin 200, bad id 404.
- **H2** `activity-logs?action=entity|user` leaked IP/UA/snapshots to any
  authenticated user → both branches now require `view_activity_logs`
  (viewer 403, manager 200).
- **H3** Dashboard `recentActivity` was global → self-scoped for users without
  `view_activity_logs`.
- **H4** Zero security headers → CSP (`frame-ancestors 'none'`, `object-src
  'none'`, `base-uri`, `form-action`), X-Frame-Options DENY, nosniff,
  Referrer-Policy, Permissions-Policy, HSTS now on every response (verified).
- **H5** No field-length caps (60 MB JSON title accepted → HTTP 200) → caps on
  test-cases (title 200 / desc 2000 / tags 10×40), bugs, modules; 5000-char
  title → 400 live.

### MEDIUM/LOW — fixed
One-shot rotation grace (replayed token no longer re-extends — replay bound to
the first 120s); login timing equalization (dummy bcrypt on unknown email —
measured ~3 ms → comparable to known-email path); changePassword policy parity
(letters-only now 400); JWT role/is_active revalidated against the DB every 30s
(demote/deactivate takes effect ≤30s; forged random-sub tokens 401); CSV export
RFC-4180 quoting + formula-injection neutralization (`=+-@` prefixed); module
`ownerId` existence validation (400 not 500); `/wiki` added to the edge proxy
matcher; fetch-before-check guards in Users/Reports views; review detail UI
gates aligned exactly with the API (`perform_review`).

### Deferred (documented, non-blocking)
Login lockout is per-email (an attacker can keep 5 fails/min to annoy one
account — IP dimension recommended); register rate-limit (recommend per-IP
bucket at the edge); refresh-token family reuse detection (bounded by one-shot
grace now); hashed-at-rest refresh tokens; upload magic-byte sniffing
(extension allowlist + attachment-only downloads already in place).

## 3. VOLUME VIA THE SHEET (Phase 2)

- `POST /api/test-cases?action=import` × 2 files × 105 rows → **210 created,
  0 failed rows** (run twice during idempotency testing → 420 total imported).
- DB after everything: **512 test cases**, 29 modules, 47 users, 44 bugs,
  44 wiki docs, 30 review requests, 1226 activity-log rows, 257 notifications.
- Fidelity checks: no title >200 chars, no description >2000, every row kept
  its description, all drafts, author = importer, pagination works at volume.

## 4. REVIEWS BY EVERY ROLE (Phase 3)

| Role | Reviewer | Verdict recorded |
|------|----------|------------------|
| product | qamarathon.product@tcms.dev | approved |
| developer | qamarathon.developer@tcms.dev | needs_revision (flagged description) |
| qa_engineer | qamarathon.qa_engineer@tcms.dev | approved |
| manager | qamarathon.manager@tcms.dev | failed (flagged expectedResult) |
| vp | qamarathon.vp@tcms.dev | approved |

All five verdicts executed by the assigned reviewer's OWN session
(`perform_review` granted to developer/qa via the VP matrix — also proving the
override system). Notifications verified in DB for assignments + verdicts.

## 5. PERMISSION MATRIX — 165/165 (×2 runs)

Every role × every action class probed with real sessions: test-case CRUD +
own/any/bulk semantics, submit-review, verdicts, modules, bugs (+link-tc),
task reports (+summary), users list/role-change, permissions read/toggle,
activity feed, wiki matrix, reports, notifications, search, dashboard.
- All denies are exactly 403; object-level rules hold (own vs any,
  author-or-matrix delete, assigned-reviewer verdicts, self-scoped data).
- Override round-trips: `viewer:create_test_case` grant→create 200→revoke→403;
  `developer:perform_review` revoke→verdict 403→re-grant→session refresh→200.
- State hygiene: after all runs, `role_permissions` contains exactly the two
  seed grants, nothing else. (One probe in an early run promoted the manager
  probe account — discovered by the matrix itself and restored; probe rewritten
  to target a non-existent id so it can never mutate real users again.)

## 6. UI MARATHON (Playwright)

Hover preview 11/11 · signup default-viewer flow (no group select → registered
→ viewer sidebar → /reports PermissionDenied) · all 14 admin tabs render ·
pagination over 400+ cases · search + hover card on a seeded row.

## 7. DB / LOGS / NOTIFICATIONS

- 29/29 DB checks: counts, zero orphans in every direction checked, version>1
  cases all have history rows, override hygiene, import fidelity, verdicts by
  all 5 roles, notification rows for assignment/verdict/password.
- Logs: no new errors during the entire session (the single error-log line
  predates it — sandbox-recycle schema drift, already self-healed). No secrets
  in any log line.

## 8. REGRESSION FLOOR

| Suite | Result |
|---|---|
| verify-security-fixes (new) | 32/32 |
| verify-permission-matrix (new) | 165/165 ×2 |
| verify-ui-marathon (new) | all green |
| db-qa-checks (new) | 29/29 |
| verify-review-ux-round | 28/28 |
| verify-bulk-delete-ui | 24/24 |
| verify-deep-link-filters | 14/14 |
| verify-wiki (API) | 43/43 |
| verify-wiki-ui | 24/24 |
| verify-import | 33/33 (stale steps/16-perms expectations modernized) |
| verify-notifications | 29/29 |
| verify-permissions | 31/31 (state-agnostic expectations) |
| verify-6-improvements | 10/10 |

`tsc --noEmit` 0 errors · production build green · stack restarted healthy.

**Verdict: SHIP.** Zero open critical/high findings; security posture
materially raised (auth bypass, stored XSS, WS hijack, IDOR-class gaps all
closed and re-probed); permission system verified exhaustively.
