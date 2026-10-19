# Security test — 2026-10-17

> Scope: the whole TCMS web app (every API resource, every page, every role, no login), plus
> settings handling (`.env`) and dependencies. Local only: dev server `:3000` and a production
> build in a separate folder copy on `:3999`, MySQL `127.0.0.1:5500/tcms_test`. No outside site
> was contacted. Repeatable suite: `node scripts/verify-security.mjs` (13 sections, self-cleaning).

## 1. Result

| Run | Result |
|---|---|
| `verify-security.mjs` — dev `:3000` | **162 passed, 0 failed** |
| `verify-security.mjs` — production build `:3999` (bundle scan of the build) | **162 passed, 0 failed** (48 built client files scanned) |
| All other suites, dev and production | see `docs/worklog.md` (task security-2026-10-17) |
| `npm audit` before → after | 28 (1 critical, 20 high, 6 moderate, 1 low) → 13 (0 critical, 10 high, 3 moderate) |

Every Critical and High finding is fixed. Medium findings are fixed; the Low ones are fixed
or in the backlog (B31–B35).

## 2. Findings

| # | Severity | Where | How to reproduce (before the fix) | Fix | Status |
|---|---|---|---|---|---|
| F1 | **Critical** | `next` 16.1.3 (whole app) | `npm audit`: 38 advisories, among them unauthenticated remote code execution on Windows-hosted servers (GHSA-p293-qw3h-jr36), RCE in the image optimizer (GHSA-2xp9-vwfh-vxw4), proxy (middleware) bypasses, cache poisoning, SSRF | `npm audit fix` (no `--force`) → `next` 16.4.2 inside the existing `^16` range; lockfile committed | Fixed; production build + every suite pass on 16.4.2. **Dev `node_modules` still has 16.1.3 until `npm install` (manual step)** |
| F2 | **High** | `GET/PUT/POST/DELETE` every API (`src/lib/auth.ts`) | Sign in, copy the `tcms-refresh` cookie value, send it as `Authorization: Bearer …` → 200 for 7 days, and still after logout (logout only revoked the DB row used by `/refresh`) | Tokens carry `typ: access|refresh`; `verifyToken(token, kind)` accepts only the right kind; HS256 pinned | Fixed — section 2 checks |
| F3 | **High** | `PUT/DELETE /api/users?id=` | As a manager (`manage_users`): `DELETE /api/users?id=<VP id>` → 200, the only VP is locked out; renaming / deactivating another manager also worked | `canManageAccount()` (`src/lib/roles.ts`): a non-VP may only change accounts below their own rank; nobody deactivates themselves | Fixed — section 1 + 11 checks |
| F4 | Medium | `POST /api/auth?path=logout`, `PUT /api/auth?path=password` | After logout the copied access cookie kept working up to 15 min; after a password change every other session's access token kept working | Revoked token ids + per-user "not before" time (globalThis, all route copies); password change returns a fresh cookie pair to the current browser | Fixed — section 2 |
| F5 | Medium | `/login?next=` (`safeNextPath`, `src/lib/routes.ts`) | `/login?next=/%5Cevil.example` — the browser reads `/\evil.example` as `//evil.example` and leaves the site after sign-in | Rejects backslash, whitespace and control characters and anything whose origin differs | Fixed — section 3 (12 hostile values) |
| F6 | Medium | every API with a body (`withApi`) | `POST /api/bugs` with a 500 MB body: the route buffers it all before validation (memory exhaustion); same for multipart uploads | `assertBodySize()`: JSON > `TCMS_MAX_JSON_BODY_KB` (2 MB) → 413, multipart > `TCMS_MAX_UPLOAD_MB`+1 → 413, chunked without length → 411 | Fixed — section 12 |
| F7 | Medium | Crew Desk (`src/lib/server/config.ts`) | With no `CREWDESK_BASE_URL` in `.env` the client silently used the real `https://api.crewdesk.shipgl.in` (the owner's `.env` has no Crew Desk keys) | No built-in address: unset = integration off; outgoing host only from `.env` | Fixed — section 13 |
| F8 | Medium | Crew Desk comment links (`integrations/crewdesk/route.ts`) | Without `TCMS_PUBLIC_ORIGIN`, links in Crew Desk comments were built from the request's Origin / Host headers | `TCMS_PUBLIC_ORIGIN` is required in production (boot refuses without it) | Fixed |
| F9 | Low | every validator with an id field | `POST /api/modules {"parentId":"1' OR '1'='1"}` → MySQL reads it as module 1, then the INSERT fails → 500. Bound parameters, so no injection | `idField()` / `optionalIdField()` (`src/lib/server/id-field.ts`) in 7 validators; MySQL 1265 → 400 | Fixed — section 4 |
| F10 | Low | session cookies | `Secure` depended only on `x-forwarded-proto` | Always `Secure` with `TCMS_DEPLOY_ENV=production` | Fixed (code + header simulation; not run live, see §4) |
| F11 | Low | `PUT /api/auth`, `PUT /api/users` | `avatarUrl` accepted `javascript:` / any text; `fullName`, `telegramChatId` unbounded | http(s) URL only (≤ 500), name ≤ 80, chat id ≤ 64 | Fixed — section 5 |
| F12 | Low | WS service `/notify` | Sent `Access-Control-Allow-Origin: http://127.0.0.1:3000` on a server-to-server endpoint | CORS headers removed | Fixed |
| F13 | Low | all pages | `X-Powered-By: Next.js`; CSP still has `script-src 'unsafe-inline'` (2026-10-19: `'unsafe-eval'` is added on the dev server only — React needs eval() in development; production CSP has none, checked by section 8) | Needs `next.config.ts` edits (owner rule: not edited) | Backlog B31 |
| F14 | Low | logout / limiter | Revocation list and per-IP limiter are in memory (one instance, as designed) | Shared store for a second instance | Backlog B32 |
| F15 | Low | per-IP sign-in limit | Keyed on the last `X-Forwarded-For` entry: reached directly (no nginx) a client can rotate it; the per-email lock (5 → 60 s) still applies | Run behind nginx only (PRODUCTION-CHECKLIST) | Accepted |
| F16 | Low | password policy | 6+ characters with a letter and a digit | Raise for production accounts | Backlog B35 |
| F17 | High (dependency) | `nodemailer` 6.10 | `npm audit`: email to an unintended domain via address interpretation; fix is a major upgrade | Recipients are only validated user emails | Backlog B33 |
| F18 | High/Moderate (dev only) | `eslint-config-next`, `autocannon`, Prisma CLI (`@prisma/config`) | `npm audit`; the only "fix" for Prisma is a CLI downgrade below the 6.19.2 client (refused) | Not part of the production server | Backlog B34 |

## 3. What was tested and found safe

- **Access control / IDOR** — 20 read endpoints × 6 roles + no login, 20 write actions refused for every
  role without the permission or ownership (+ no login → 401), nothing changed afterwards, id guessing
  over neighbouring work-log and notification ids, another user's notification never listed.
- **Sign-in** — per-email lock (6th try 429, right password refused while locked), per-IP limit (31st →
  429), same status + message for known and unknown emails, bcrypt on the unknown-email path, every
  stored hash is bcrypt.
- **Tokens** — tampered role/sub/exp, `alg=none`, `alg=HS512`, random and empty tokens → 401; access
  token refused as a refresh token; deactivated user refused within 31 s.
- **SQL injection** — static: no `$queryRawUnsafe`/`$executeRawUnsafe`/`Prisma.raw` and no string-argument
  `$queryRaw` in `src/`; 200 payload probes over 25 filter/search/sort/id parameters (no 500, no hash,
  no `SLEEP()` effect, tautology matches nothing); payloads in body fields stored verbatim.
- **XSS** — script / `onerror` / `svg onload` payloads in bug, test case (+ steps), wiki (title, HTML,
  tags), work log, profile name, module and CSV import; wiki HTML is sanitized server-side; 10 pages
  opened in headless Chrome as the author: no payload ran, no dialog.
- **CSRF / CORS** — no marker + no Origin, foreign Origin, classic form post → 403 on POST/PUT/DELETE/PATCH
  incl. logout and password change; preflight from a foreign Origin not approved; no ACAO on answers.
- **CSV import** — > 200 rows, wrong extension, binary, > 1 MB, a 900 KB cell (row reported failed),
  formula cells imported as text; CSV export prefixes `= + - @ tab` cells; 12 MB wiki upload refused.
- **Headers** — CSP (`frame-ancestors 'none'`, `object-src 'none'`, `base-uri`, `form-action`),
  `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, HSTS, `Permissions-Policy`, API `no-store`.
- **Error leaks** — malformed / wrong-type JSON, bad ids, FK errors, unknown route / method, stale
  update: no 500, and no stack, SQL, file path or hash in any JSON error of the whole run.
- **Secrets** — no `.env` secret value (JWT, WS, DB passwords, SMTP, Telegram, Crew Desk) in the built
  client files or page HTML; `NEXT_PUBLIC_*` names hold no secret; no secret, user password, hash or
  JWT in today's log files; APIs never return a password hash.
- **Mass assignment** — role / userId / email / isActive / passwordHash / permissions in a profile update,
  bugId / reportedBy / createdAt on a bug, author / version / status on a test case, ownerId on a module,
  role on register: all ignored; managers cannot create VPs or change roles; nobody changes their own role.
- **Request limits** — 3 MB JSON 413, chunked 411, 50 000-level nested JSON 400, XML 400,
  40 parallel `pageSize=100000` lists (capped at 100), app still ready afterwards.
- **Crew Desk** — config endpoint carries no secret or token field; every `fetch()` uses the `.env`
  base URL; ticket ids with paths, hosts or URLs → 400.

## 4. NOT tested

- An **expired** token (forging one needs the JWT secret); expiry is enforced by `jsonwebtoken.verify`.
- **HTTPS for real**: HSTS and `Secure` cookies behind nginx with TLS; `TCMS_DEPLOY_ENV=production` was
  not switched on (the guards refuse the sandbox database) — the Secure rule is proven by code and the
  `x-forwarded-proto: https` simulation only.
- **Several app instances** (revocation and limiter are per process — B32).
- The **WebSocket service** under attack (`ws-auth-probe.mjs` is Linux-only, NOT RUN ON WINDOWS).
- Live **Crew Desk**, **SMTP** and **Telegram** calls (not configured on this machine).
- Large-scale **DoS** (slow-loris, connection floods) and uploaded-file **malware** content.
- The browser XSS pass ran as one role (the author) on 10 pages; other roles see the same rendering code.
- The dev server ran the suites on `next` 16.1.3 (old `node_modules`); the production build on 16.4.2.
