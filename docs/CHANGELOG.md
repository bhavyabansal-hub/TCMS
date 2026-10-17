# Changelog

Reverse-chronological list of user-visible and architectural changes. Task-level
detail lives in [`worklog.md`](./worklog.md).

## 2026-10-17 — FIX modules page crash + console-error checks on every page

- **/modules crashed** ("Cannot read properties of undefined (reading 'length')") in browser tabs still running the previous client: the PERF change had removed `tree` from `GET /api/modules`. The field is back (deprecated, backlog B30; `flat` still carries no children), the page reads it defensively, and API changes must now be additive (CODING-STANDARDS §2 rule 15).
- **No calls that are certain to fail:** review and module-review detail pages call the detail API only with `perform_review` (no 403 + retry for developer / qa_engineer / viewer); Integrations skips the Crew Desk email check when Crew Desk is not configured (no 502); detail pages no longer retry a 403/404.
- **Permission toggles show at once again:** the session check reads the permission table fresh (the PERF cache read showed the old matrix for up to 3 s).
- **Stricter page checker:** `scripts/verify-page-apis.mjs` now fails on any browser console error, uncaught exception, Next.js error overlay, error boundary or empty page, for every page and role.

## 2026-10-17 — PERF pages and APIs for 1000+ users

- **Every page loads only what it shows:** no duplicate API calls any more (the boot cache clear wiped the prefetch), the boot prefetch only on the dashboard, no Crew Desk/module call for users who see "permission denied". Checked per page × role by the new `scripts/verify-page-apis.mjs`.
- **Smaller, cheaper responses:** `/api/modules` sends each module once (14 KB → 5 KB on demo data; the client builds the tree); new light pickers `GET /api/test-cases?action=options` and `/api/bugs?action=options`; the dashboard activity feed no longer carries snapshots.
- **Server:** cache-aside for the module tree and user picker (cleared by every write, no stale result after an invalidation), module review writes batched (3 statements per module instead of 3 per case), bulk delete is one statement, list-sort indexes (new migration), pool default 40 (`TCMS_DB_CONNECTION_LIMIT`), buffered async log writes, fast reads logged at debug.
- **Measured (production build, laptop):** API calls p95 < 60 ms; 1000 realistic users (350 req/s) served with 0 errors, p95 764 ms (`scripts/loadtest-1000.mjs`, `docs/architecture/HLD.md` §7).

## 2026-10-16 — MAINT faster agents

- Default for every job = the fast lane: one developer does the work, sdet runs the Definition of Done. The full 6-agent process only when the owner types `/new-requirement`.
- Every agent and command: the WORKING METHOD, read-first list (CLAUDE.md + CODING-STANDARDS + last 10 worklog entries + the task files only), reports max 15 lines, no re-review rounds unless a gate fails, waits only for data deletes, schema changes or a push.

## 2026-10-16 — MAINT docs: one docs folder, one standards file

- Root keeps only README.md, CLAUDE.md, package files and configs. agent.md, CODEBASE-MAP.md, DEPLOYMENT.md, CHANGELOG.md and worklog.md moved into docs/.
- docs/ = README index + architecture/ (new HLD and LLD; database, API, auth, frontend, realtime, Crew Desk) + guides/ + deploy/ + process/ + qa/. Overlapping docs merged (overview + scaling → HLD, standards & LLD → LLD, file index → CODEBASE-MAP); the finished REQ-001 record removed.
- docs/CODING-STANDARDS.md is the one rules file (owner standards word for word + TCMS rules); CLAUDE.md carries the WORKING METHOD.

## 2026-10-16 — MAINT logs

- **Clean dev log:** the 8 "Node.js API in Edge Runtime" warnings are gone — `src/instrumentation.ts` only loads `src/instrumentation-node.ts` in the Node runtime.
- **SQL logging:** `prisma:query` lines only with `TCMS_LOG_SQL=true` (off by default, any environment).
- **Fallbacks:** the WebSocket broadcast no longer delays a request when the WS service is slow or down; SMTP sends have a full timeout. DB down → `/api/ready` and data requests answer 503 with a clear message.

## 2026-10-16 — Cleanup: PostgreSQL removed, docs describe today's app

- **Removed:** the whole `archive/` folder, the PostgreSQL scripts (schema converter, 250-row probe, rollback drill), the migration dossier `docs/migration/`, old one-time reports (REFACTOR-*, CODE-QUALITY-*, older QA prompts/reports), the stale PDF guide and its build script, and raw test evidence files.
- **PostgreSQL:** fully removed — no rollback source (D1) and no data copy (D2: production starts empty with `scripts/create-first-vp.mjs`). The data-copy script, `PG_SOURCE_URL` and the `scripts/pg-client/` ignores are gone.
- **Docs:** README, DEPLOYMENT, CODEBASE-MAP and guides 01–17 now describe MySQL 8.4, the six roles and the permission matrix, the Windows setup, the nginx production topology, the safety features (409 on concurrent edits, read-only mode, `/api/ready`, sign-in limit) and the deep-test fixes.

## 2026-10-16 — FIX deep-test bugs (docs/qa/DEEP-TEST-2026-10-16.md)

- **Roles (R2-3):** only a VP can set or change a role, and never their own; other user managers can create viewer accounts only. Role pickers are disabled for non-VPs.
- **Bugs (T1-1, T1-2, R2-2):** editing a bug, test case or work log no longer resets fields you did not send; saving a bug with an unchanged assignee no longer needs assign rights; assigning on create needs assign rights.
- **Reviews (R2-1, R2-4, R2-5, R2-6):** a resubmit or module submit closes the old open review; cases in review or approved cannot be submitted again (400); authors see the flagged fields on the test-case page; a bulk module verdict sends one notification per person.
- **Permissions (T1-5, DOC-T1-6):** turning a permission back to its default reports `source: 'default'`; `docs/architecture/auth-and-permissions.md` tables match the code (21 permissions, 126 cells).

## 2026-10-16 — MAINT production run

- **Safety:** new `GET /api/ready` (database check); `TCMS_READ_ONLY=true` pauses every change with a clear 503 while sign-in and reading keep working; CSV exports of bugs and work logs are now quoted and protected against spreadsheet formula injection like test cases; too many failed sign-ins from one network now get 429.
- **Database errors:** duplicate, foreign-key, too-long and similar MySQL errors now answer a clear 400/409 (DB down or busy: 503) instead of a generic 500; SQL text never reaches the client. Two saves of the same day's work log at once no longer fail.
- **Concurrent edits:** saving a test case, bug, module, review verdict/forward or a module bulk verdict that someone else changed since you opened it now answers **409 "This item was changed by someone else — reload"** instead of silently overwriting (optimistic lock on the loaded updatedAt). Parallel test-case saves and parallel verdicts no longer fail with a 500 deadlock.

## 2026-10-14 — Owner 8-step plan (steps 1–3) + Phase 2 hardening (post-migration)

- **Step 1:** Crew Desk testing normalized to designated ticket **1355-only** —
  fixed 6 stale `4190` remnants including the functional default in
  `src/lib/server/config.ts`; `rg 4190` over the repo = 0. Ticket 4191 survives
  only as the guard-refusal probe (asserted refused, never written to).
- **Step 2:** The two battery checks rewritten during the migration were
  independently audited with evidence (`git show` archaeology + live MySQL
  probes) — both old versions were stale on ANY database (CSRF
  marker-allows-Origin is the guard's documented design; the bare `steps` field
  no longer exists in the product). Battery 63/63 is honest.
- **Step 3:** IT request for the real production MySQL server drafted →
  `download/it-request-mysql.md` (server/port, TEST schema + limited user with
  grant list, TLS/sql_mode/charset/timezone, backup ownership, Workbench access,
  where real data lives).
- **Phase 2 hardening (5 groups, suites green after each):**
  1. `scripts/mysql-env.sh` = single source of DB wiring (safe env parser immune
     to the `source .env` `&`-truncation bug); repair-only `.env` self-heal;
     unquoted-`.env` standard; battery self-boots.
  2. Unknown `moduleId`/`assignee` on test-case/bug create/update → proper
     404s (was raw FK 500). 22-probe sweep: zero 500s.
  3. Backup scheduler wired into autostart (pgrep-guarded, idempotent);
     backup log lines; CSV import completion log line.
  4. Twelve stale docs updated for MySQL 8.4 (schema, API reference + new
     endpoint sections, runbook rewritten to mysqldump drills, file index,
     deployment/scaling/realtime banners; Vercel-era guides marked HISTORICAL).
  5. `src/lib/auth.ts` SQL moved to the user repository (no import cycle);
     SMTP lazy singleton; eslint ignores vendored code (490 errors → 0);
     stale `scripts/tcms-package/` removed (zip 759 → 443 files);
     Crew Desk identity cache invalidation on user changes.

## 2026-10-14 — PostgreSQL → MySQL 8.4 migration (MySQL-only)

- Adopted TCMS-complete-2026-10-14.zip as the baseline (settings reorg, cookie
  auth, wiki, search, backup scheduler, Crew Desk v2, Register kept).
- Prisma schema converted to MySQL 8.4 (provider swap; explicit native types
  on every String — CHAR(36) uuids, VARCHAR sized per validation caps,
  TEXT/MEDIUMTEXT long text; DATETIME(3) everywhere; JSON expression defaults;
  case-sensitive collations for password_hash + refresh token).
- All raw SQL rewritten for MySQL across 20 repositories (RETURNING →
  insert+read-back with app-side uuids, ILIKE → LIKE, ON CONFLICT →
  ON DUPLICATE KEY, interval/cast/JSONB fixes, Number() coercions, boolean
  normalization). No raw SQL outside repositories (unchanged rule).
- keep-alive route removed (Supabase/PG pool leftover); its cron removed;
  scripts updated to use /api health.
- Backup scheduler: mysqldump-based (scripts/backup-db-mysql.sh, same
  14-retention policy) + restore drill (scripts/restore-mysql.sh, scratch
  schema, verified 17 tables).
- One-time data migration script (scripts/migration/migrate-pg-to-mysql.mjs):
  batched, dependency-ordered, idempotent, dry-run mode, FK-orphan audit,
  utf8mb4 + strict-mode probes. PG source stays READ-ONLY.
- Verification: battery 63/63, Crew Desk mock suite 5/5, import suite 33/33,
  250-row import probe PASS (cap enforced), 200-VU load test 0 errors.
  (The migration dossier docs/migration/ was removed 2026-10-16; the PostgreSQL
  rollback window was dropped, decision D1.)

## 2026-10-14 — Phase 2 hardening (post-audit fixes)

### GROUP 5 — repository-only SQL, SMTP singleton, lint clean, tidy zip, roster cache
- `src/lib/auth.ts` no longer contains raw SQL: session revalidation reads via
  `user.repository.findUserById` (no import cycle; booleans arrive normalized).
  The module header's "no direct database access" is true again.
- SMTP transporter is a LAZY SINGLETON (`src/lib/server/delivery.ts`) — created
  once per process on first real send, reused afterwards (was per-send).
- eslint ignores the vendored `scripts/pg-client/**` + `scripts/migration/*.cjs`:
  `npm run lint` is now **0 errors, 1 warning** (was 490 errors, all vendored).
- Stale `scripts/tcms-package/` snapshot (self-referenced a deleted PG-era
  wrapper) removed from the repo AND the canonical zip (759 → 443 files).
- Crew Desk identity cache (`crewdesk.identity.ts`) invalidates on user
  create/update/deactivate so the posting-time email check never serves a
  roster older than the change.

### GROUP 4 — docs updated for MySQL 8.4
- `02-database-schema` (source-of-truth line), `04-api-reference` (+ new
  sections 14b–14e documenting `/api/integrations/crewdesk`, `/api/permissions`,
  `/api/search`, `/api/wiki` with their server-side permission gates; keep-alive
  marked removed; case-sensitivity quirk updated), `13-file-index`,
  `17-operations-runbook` (mysqldump drills + IT TEST-schema certification
  procedure), `01-overview` (stack table, diagram, env var), `16-single-instance`
  (pool vs max_connections), `12-realtime` (banner + keep-alive removed),
  `03-auth` (search case-insensitivity), `10` (outbound delivery section:
  email/Telegram env gates, timeouts, failure isolation).
- `DEPLOYMENT-GUIDE.md` marked HISTORICAL (Neon/Vercel/pgAdmin path) pending IT
  answers; `REFACTORING-REPORT.md` carries a historical note. Old CHANGELOG
  entries left untouched (dated history, not rewritten).

### GROUP 3 — backup scheduler actually runs; backups and imports are logged
- `scripts/boot-tcms-autostart.sh` now starts `backup-scheduler.mjs` (daily
  mysqldump, 14-copy retention) via nohup with a pgrep guard — previously the
  scheduler existed but NOTHING invoked it, so backups only ran by hand.
- `scripts/backup-db-mysql.sh` appends every write + retention removal to
  `logs/backup.log`.
- CSV import now logs `CSV import finished {module, totalRows, imported,
  failed, by}` through the app logger (audit-relevant operation).

### GROUP 2 — clean 404s on unknown FK targets (no more raw 500s)
- `createTestCase` + `updateTestCaseFields` and `createBug` + `updateBugFields`
  now pre-check `moduleId` / assignee existence and answer **404 "Module not
  found" / 404 "Assignee not found"** — the same contract module-create already
  had for `parentId` — instead of surfacing a raw FK error as HTTP 500.
- Re-hunt: the 22-probe bad-input sweep (bad uuids, wrong types, oversized
  input, injection probes across ALL routes) now yields **zero 500s**; every
  probe answers 400/404 with a meaningful message.

### GROUP 1 — .env self-heal made repair-only; ONE source of truth for DB wiring
- New `scripts/mysql-env.sh`: the ONLY place DB wiring lives, sourced by BOTH
  `start-tcms.sh` and `boot-tcms-autostart.sh` (they had drifted). It keeps a
  caller's `mysql://` URL, otherwise reads the FULL line from `.env`
  (immune to the shell `&`-truncation trap), else falls back to the sandbox
  MySQL. `PG_SOURCE_URL` is the read-only drill source only.
- `start-tcms.sh` self-heal is now REPAIR-ONLY: a missing `.env` is recreated
  canonically (fresh random JWT/WS secrets); an existing one gets ONLY the
  lines this script owns fixed (DATABASE_URL/DIRECT_URL/allowlist) — secrets,
  `CREWDESK_*`, `TCMS_ENABLE_SEED`, comments preserved VERBATIM. Proven: a
  restart from a stale-sqlite-shell leaves `.env` byte-identical.
- `.env` values standardized UNQUOTED: naive parsers (node fixtures,
  mysqldump URL splitting) read `.env` raw; quoting broke them. The one
  shell-sourcing consumer reads via `mysql-env.sh` instead. Parsers that read
  `.env` directly now also dequote defensively (`verify-crewdesk.mjs`).
- `verify-battery.sh` owns its seed contract: exports `TCMS_ENABLE_SEED=true`
  and boots the stack itself when :3000 is down — battery-after-any-restart
  is now deterministic 63/63 (was 62/63 when the flag got dropped).
- `.env.example` keeps seeding OFF (commented) for production deployments.

## 2026-10-14 — 1355-only ticket rule enforced everywhere; battery-audit verdict; MySQL boot hygiene

### Fixed — Crew Desk ticket lock (owner re-confirmed: 1355 only)
- `CREWDESK_TEST_TICKET_ID` default in `src/lib/server/config.ts` was still
  `4190` from an older session. Default, comments, `.env`/`.env.example` notes,
  the `start-tcms.sh` echo and the hard-locked `scripts/crewdesk-real-smoke.mjs`
  now all say **1355**. The mock's `4191` remains ONLY as the guard-refusal
  probe (nothing is ever written to it). `rg 4190` over the repo: zero matches.

### Verified — the two rewritten battery checks were stale, not gamed
- CSRF check: the guard (shipped with the blocked-chat baseline `87e5014`,
  untouched by the MySQL migration) ALLOWS an unmatched Origin when the
  first-party `X-Requested-With: tcms` marker is present (cross-site JS cannot
  set custom headers) and logs a warning instead. The old battery expected 403,
  contradicting the guard's documented design on BOTH databases. Live-proofed:
  evil Origin WITHOUT marker -> 403; WITH marker -> passes the guard (zod 400).
- `tc steps parsed array` check: the pre-baseline serializer emitted
  `steps: parseJson<unknown[]>(tc.steps, [])`; the baseline product removed the
  bare `steps` field from API output (serializer emits preconditions /
  expectedResult / attachments / tags). The old check asserted a field the
  current product never emits. Retired with an explanatory comment.

### Fixed — boot-path regressions found while re-verifying
- `.env` MySQL URLs were unquoted, so `source .env` truncated the value at the
  `&` and a stale shell `DATABASE_URL` silently won (root cause of the old
  "pin DATABASE_URL" restart trap). All URL values now quoted.
- `TCMS_ENABLE_SEED=true` restored in the sandbox `.env` (dropped in the
  migration `.env` rewrite; the battery seed check and the autostart's
  fresh-DB seeding depended on shell luck). Not shipped in the zip —
  production keeps seeding off.
- `scripts/dev-with-pg.mjs` replaced by MySQL-only `scripts/dev-tcms.mjs`
  (`npm run dev`): rejects non-mysql URLs, boots the sandbox MySQL 8.4 when
  pointed at 127.0.0.1:5500, pass-through for IT's server, NEVER boots PG.
- `prisma/schema.prisma` header no longer claims PostgreSQL / gen_random_uuid;
  documents MySQL native-type sizing + CHAR(36) uuid() conventions.

### Suites after the changes
- Crew Desk mock suite 5/5 phases · battery 63/63 · canonical zip refreshed
  (759 files, integrity OK).

## 2026-10-09 — Live Crew Desk dev backend, signup group choice, CSRF origin fix

### Changed — Integrations now talks to the REAL dev Crew Desk (owner-confirmed)
- `.env` points `CREWDESK_BASE_URL` at `https://dev.eng4.back.shipgl.in` with a
  fixed bearer token (never committed); `CREWDESK_MODE=test` and
  `CREWDESK_TEST_TICKET_ID=1355` pin EVERY comment to the designated test
  ticket 1355 — nothing else on the dev server can ever be touched.
- Proven live end-to-end: config -> email verified against the REAL user list
  -> ticket 1355 lookup -> ONE real comment posted and READ BACK from the
  actual ticket -> Copy path. The 5-phase mock suite stays green (now
  backend-agnostic: it pins the mock itself, so live/mock switching never
  breaks it).
- The config endpoint now exposes `credentialExpiresAt` (ISO, non-secret) and
  the Integrations status strip warns "Token expires in N min" / "Token
  expired" — fixed dev tokens are short-lived (~1 h). Switching back to the
  mock = delete the 5 CREWDESK_ lines in `.env` and restart.

### Fixed — "email does not match Crew Desk account" for valid Crew Desk emails
- Root cause: the check ran while the app was pointed at the local MOCK
  (fictional users), so no real @shipglobal.in email could ever match. On the
  dev backend the same flow verifies immediately — reproduced and proven with
  a self-created account whose email exists in Crew Desk (email-check ->
  `verified`).
- Self-signup now also lets the user CHOOSE their group (VP / Manager /
  Product / QA Engineer / Developer / Viewer, enum-gated server-side,
  least-privilege viewer default). The group dropdown is always visible on
  the Create account tab.

### Fixed — CSRF origin matching never worked (log noise + weaker layer)
- `normalizeHost()` parsed bare `host:port` values as URL schemes
  (`new URL('localhost:3000')` -> scheme "localhost", empty host), so EVERY
  origin comparison silently failed and all first-party POSTs rode the
  X-Requested-With marker fallback — 78 "Origin unmatched" warnings/day.
  Now same-origin (preview site, localhost) matches properly; the marker
  stays as the second layer. No-CORS-marker attacks are still 403 (suite
  asserts it).

## 2026-10-09 — Integrations redesign (3rd round): horizontal, no explainer

### Changed
- **"How it works" panel removed** (owner: "do not need how it works tabs …
  no unnecessary things"). The page is now three plain full-width blocks:
  header + one slim status strip, the link form, the link history.
- **Form expanded horizontally**: the three fields now sit side by side on
  one row (Module | Crew Desk ticket ID | Note) instead of a cramped 7/12
  split — every field gets real width on desktop, fields stack on mobile.
- **Field polish**: consistent label/height/help-text rhythm, inline "Check"
  button on the ticket field, note counter beside the label, full-width
  ticket preview strip with an inline reason when the current mode refuses
  the ticket, and the action hint under the primary button. All behavior,
  endpoints, permissions and test coverage unchanged (suite 5/5 green).

## 2026-10-09 — Corruption-proofing, cache freshness, Integrations redesign

### Fixed — no data corruption under concurrency (owner requirement)
- **Test-case edits are now transactional + optimistic-locked**: the history
  snapshot and the field update commit as ONE unit, guarded by
  `WHERE version = <version read>`. Two people saving the same case together
  can no longer silently overwrite each other — the loser gets a clear 409
  ("changed by someone else, reload and try again") and no duplicate/missing
  history versions can ever be written. Proven live: 8 concurrent edits ->
  every 409 correct, version/history invariants held exactly.
- **Review submission is transactional**: review request + test-case status
  flip commit together (a crash can no longer leave a pending review whose
  case still reads "draft").
- **Verdicts are single-shot**: event + review closure + case status commit
  atomically and the closure is guarded (`status <> 'completed'`) — a double
  click or two reviewers together record exactly ONE verdict; the loser gets
  409. Proven live: concurrent double verdict -> one 200 + one 409, exactly
  one event row.
- **Module bulk-approve is atomic**: every case verdict, closure, status flip
  and the module-review completion commit together or not at all.
- **Crew Desk duplicate-link race closed end-to-end**: the (module, ticket)
  unique index is now surfaced as the same friendly 409 the pre-check
  produces, so two teammates linking the same pair simultaneously get a clear
  message instead of an opaque 500.

### Fixed — cache cleared properly (fresh UI after every deploy)
- Pages and API responses now send `Cache-Control: no-store, must-revalidate`
  (pages via proxy + config headers; every API response via `withApi()`/`ok()`),
  while hashed `/_next/static` assets keep `immutable` caching. A browser or
  the preview edge cache can no longer serve a stale screen after a rebuild —
  one normal refresh always shows the current deployment.
- **Build stamp in the footer** (`build <git-sha>`): anyone can verify at a
  glance which build the browser is running; the sha changes on every commit.
- New probe tool: `scripts/verify-no-corruption.mjs` (concurrency + volume +
  verdict-guard probes, all passing).

### Changed — Integrations page redesign (2nd round, owner feedback)
- Replaced the four heavy status tiles + cramped 2/5-3/5 split with four plain
  sections: header, ONE slim connection strip (dot + mode/verification chips),
  the 3-step link form beside a plain-English "How it works" card, and the
  full-width link history table. Same behavior, far less jargon, no inner
  width limits (nothing "shrunken").

## 2026-10-08 — Adopted baseline (zip lineage)

- Crew Desk integration (shared account, mock-only in sandbox, email check,
  1355-designated-ticket rule), settings reorg, cookie sessions, wiki, search,
  backup scheduler, self-signup Register tab.

## 2026-10-08 — UI/UX fix round (owner feedback)

### Changed
- **Integrations page — full-width redesign** — the page previously constrained
  itself to `max-w-5xl`, which read as "shrunken" next to every other full-width
  view. It now uses the standard full-width container: 4-tile status strip
  (connection · mode · your verification · link-history counters) with tinted
  icon chips, a numbered-step link form (1 Module → 2 Ticket → 3 Note) beside
  the history table on wide screens (xl:grid-cols-5), sticky history header,
  softer row hover, icon empty state. All behavior, endpoints and permissions
  unchanged.
- **Login screen rebuilt** — proper two-tab switcher ("Sign in" / "Create
  account") with clear active state and generous spacing (h-10 inputs,
  space-y-5 fields, hints under fields, inline cross-links between tabs).
- **Load resilience (owner requirement: "at least 7 attempts")** — React Query
  now retries every failed load up to **7 times** with exponential backoff
  (~12s worst case) before the error UI shows; deterministic client errors
  (401/403/404) are never retried. When a query finally fails, all INACTIVE
  cached copies of it are dropped from the cache so stale data can never
  linger under a failed page.

### Added
- **Self-signup restored (owner decision)** — `POST /api/auth?path=register`
  (fullName/email/password) creates a **least-privilege `viewer`** account and
  signs the user in immediately (httpOnly cookies, same session contract as
  login). Validation before service (name 2–80, email, password ≥ 8 with a
  letter + a number); duplicate email → 409; audit-logged. Admins promote
  roles from the Users page. The mock suite now asserts the new policy
  (register 200+viewer / duplicate 409 / weak 400 + fixture cleanup) —
  **5/5 phases, 149 assertions green**.

## 2026-10-08 — Production hardening pass

### Fixed
- **Comment author resolution in login mode** — when `CREWDESK_USER_ID` is not
  configured, the shared-account `user_id` is now resolved from the login-issued
  in-memory JWT claim (the documented fallback was missing, so password-login
  deployments without the setting could not post). `CREWDESK_USER_ID` remains
  the source of truth when set; the mismatch warning is unchanged.
- **Self-contained local mock** — when `start-tcms.sh` boots the local Crew
  Desk mock and the deployment has configured NO credential (env or `.env`),
  it injects the mock's FICTIONAL login (`tcms.service@crewdesk.test`) so the
  Integrations page works out of the box on a fresh clone. Any real
  `CREWDESK_TOKEN`/`CREWDESK_AUTH` always wins; the mock path can never reach
  a real backend. Full mock suite now passes 5/5 phases (137 assertions).

### Changed
- **Integrations page redesigned** — new status strip (connection · mode ·
  your-verification cards), two-column link form (module + ticket on the left,
  note + actions on the right), polished history table with total/posted
  counters and icon badges, better loading skeletons and empty states.
- **Central env config** — `src/lib/server/config.ts` is now the ONLY file that
  reads `process.env`. Every deployment knob (SMTP, Telegram, Crew Desk, JWT,
  logging, seed gate) is declared once with its default and imported everywhere
  else as typed constants. Grep-verified: zero stray env reads remain.
- **Logging upgraded** — the structured logger now has three failure-isolated
  transports: console, rotating daily files (`logs/app-*.log`, `logs/error-*.log`,
  retention purged daily), and a **dedicated Telegram logs bot**
  (`TELEGRAM_LOG_BOT_TOKEN` + `TELEGRAM_LOG_CHAT_ID`): warn/error lines are
  batched and mirrored to the owner's chat (throttled, oversized batches keep
  the newest lines). Process-level failures (unhandledRejection /
  uncaughtException) flow through the same pipe via `instrumentation.ts`.

### Removed
- **Email exceptions (admin)** — the Integrations card, the
  `GET/POST/DELETE ?path=exceptions` endpoints, the service/repository code and
  the `crew_desk_email_exceptions` table are gone (product decision: the
  verification check matches everyone by their own TCMS email, nothing else).
  Tests now PROVE the endpoints are dead and no hidden mapping path remains.

### Added
- **Graceful shutdown** — SIGTERM/SIGINT close the Prisma pool before exit
  (3s cap), so redeploys never strand DB connections.
- **DB choke guards** — PostgreSQL `statement_timeout=15s` +
  `idle_in_transaction_session_timeout=10s` at database level.
- **Seed lockdown** — `/api/seed` answers 403 unless `TCMS_ENABLE_SEED=true`
  (idempotency no-op still applies; production stays off).

## 2026-10-01 — Standards hardening, dark-mode rework, cleanup

### Fixed
- **Dark mode rebuilt as "soft graphite"** — replaced the pitch-black surfaces
  (background oklch 0.17 ≈ `#13151b`) with a light airy dark ramp (background ≈
  `#272b33`, card `#31353d`, popover `#343841`, sidebar `#1f232b`), brighter
  translucent borders, brighter secondary text, and a subtle gray active-nav pill
  instead of the white flash. Light mode untouched (verified `lab(100,0,0)`).
  Recharts grid slightly more visible. All colors remain token-driven.
- **Layering violation removed**: `seed.service.ts` no longer imports the db client —
  the atomic-seed transaction moved into `seed.repository.ts → runSeedInTransaction()`
  (unit-of-work pattern). Services are now 100% db-free.
- **`/settings/permissions` guard** now follows the standard `user && can(...)`
  pattern (was the only guard without the null-user check).

### Added
- **`src/proxy.ts`** — edge proxy (Next 16 middleware successor): anonymous page requests to any `(app)`
  route are redirected to `/login?next=<path>` before shell JS downloads. Cookie
  presence check only; the API layer remains the authoritative gate.
- **`<PermissionDenied>`** shared guard component (`shared/permission-denied.tsx`) —
  replaces 7 hand-rolled "Access restricted" Alert blocks (activity-log, reports,
  reviews, review-detail, module-review-detail, settings-users, settings-permissions).
- **Shared chart palettes + date helpers in `lib/format.ts`**: `SEVERITY_HEX`,
  `PRIORITY_HEX`, `BUG_STATUS_HEX` (+ `severityHex`/`priorityHex`/`bugStatusHex`
  fallback lookups) and timezone-safe `todayISO()`/`isoDaysAgo()` — removed per-view
  copies in dashboard/reports/tasks. Reports date-range defaults are now
  timezone-correct for non-UTC users.
- **`REFERENCE_STALE_TIME_MS` (5 min)** applied to all modules-tree / user-options
  queries (12 sites) — reference data changes only through mutations that already
  invalidate the owning keys.
- **`qs()` query-string builder + `writeAccessCookie()`** in `lib/client/api.ts` —
  replaced 8 inline `new URLSearchParams(...)` copies and 2 duplicated cookie writes.
- **docs/architecture/LLD.md** — the standards/LLD contract (layering rules, raw
  SQL rules, LLD principle map, caching/load-management, logging, route-permission map).

### Changed (load management)
- Sidebar review-queue polling (2 requests / 30s) now runs ONLY for users who can
  perform or submit reviews; viewers no longer poll endpoints they cannot act on.
- `tasks.tsx`: `isManager` renamed to `canViewAllReports` (names the permission, not
  a role); module-review verdict handlers share one `invalidateAfterVerdict()` set.

### Removed (cleanup)
- Dead code: `src/hooks/use-toast.ts`, `src/hooks/use-mobile.ts`,
  `src/components/ui/toast.tsx`, `public/logo.svg`.
- Dead deps: `@radix-ui/react-progress`, `@radix-ui/react-radio-group`,
  `@radix-ui/react-tooltip` (lockfile synced).
- Root-level doc duplicates (`CODE-QUALITY-ROADMAP.md`, `DEPLOYMENT-GUIDE.md`,
  `REFACTORING-REPORT.md`, `REFACTOR-CHARTER.md` — byte-identical copies of docs/),
  superseded root `docs/deploy/DEPLOYMENT.md` (docs/DEPLOYMENT-GUIDE.md is canonical), and the
  stale `scripts/tcms-package/` project snapshot.
- Stale QA screenshots from `download/` (current-verification set kept).

### Verified
- `tsc --noEmit` clean; `eslint` clean; production build OK; 31/31 e2e checks pass;
  dark/light smoke screenshots; zero browser console errors.

## 2026-10-01 — Pre-launch hardening (cookie sessions, CSRF, load test, runbook)

**Security — httpOnly cookie sessions (breaking change for API consumers):**
- Access + refresh tokens moved OUT of localStorage / response bodies into
  **httpOnly cookies** written by the server (`src/lib/server/auth-cookies.ts`):
  `tcms-access` (path=/, 15-min JWT inside, 7-day cookie) and `tcms-refresh`
  (path=/api/auth, rotating, 7-day). JavaScript can no longer read any token —
  XSS cannot exfiltrate the session.
- **CSRF, three layers**: SameSite=Lax cookies; `assertSameOrigin()` (Origin/Host
  check) in `withApi()` on every mutating request; `X-Requested-With: tcms`
  custom header from the SPA. Cross-site POSTs are rejected 403.
- Login/register/refresh bodies no longer carry tokens (`{ user, permissions }` only);
  refresh/logout read the httpOnly cookie (body token still accepted for API consumers).
- Session verified end-to-end: login, hard-refresh resilience, silent refresh after
  access expiry (proven in a real browser with a corrupted token), logout revocation,
  expired-JWT rejection, rotation grace.

**Load test (25 expected / 50 double users, 60 s each, realistic data volume):**
- Found & fixed two bottlenecks: missing hot-path indexes
  (`test_cases.updated_at`, `test_cases.created_at`, `bugs.created_at`,
  `test_cases.priority` — `scripts/add-load-indexes.mjs`) and undersized DB pool
  (`connection_limit` 20 → 40).
- Result: 0 errors at both 25 and 50 VUs; 25 VU p50 165→63 ms, p95 305→190 ms,
  p99 441→304 ms; throughput 265→339 rps (+28%); server-side p99 193 ms at 50 VUs.
- New tooling: `scripts/loadtest.mjs`, `scripts/seed-load-volume.mjs`.

**Single-instance constraint documented** (`docs/architecture/realtime-and-notifications.md §3`):
in-process TTL cache + WebSocket hub mean horizontal scaling requires Redis
(cache + notification fan-out) first.

**Backup/rollback runbook** (`docs/DEPLOYMENT-GUIDE.md Part 9`):
`scripts/backup-db.mjs` (full logical backup) + `scripts/restore-db.mjs` with
row-count verification; restore drill executed and verified (15/15 tables).

**Error logging**: `src/instrumentation.ts` captures unhandledRejection /
uncaughtException into the structured `[tcms]` logger; `withApi()` continues to
log every request (method, path, status, latency) and every error with stack.

**Docs**: ``docs/architecture/auth-and-permissions.md`` rewritten for the cookie session model; auth API contract in
``docs/architecture/api-reference.md`` unchanged in shape but token-free bodies noted.

## 2026-09-30 — Tasks page, error boundaries, preview crash fix

- Fixed the app-wide "client-side exception" crash (bare `<SelectTrigger>` outside
  `<Select>` context) and added root + segment error boundaries
  (`global-error.tsx`, `(app)/error.tsx`) with reset/reload/digest.
- Tasks (Daily Work Log) page rebuilt: add tasks with minutes/status, optional
  entity links (module / test case / bug) with explicit link-type state, sticky
  save bar that never overlaps row controls, validation before save, report
  upsert by date (API `task-reports`), CSV export.

## 2026-09-29 — Reviews ownership & permanent deletion

- Review/module-review listing and detail are participant-scoped server-side
  (reviewer or requester only; 403 otherwise).
- Test-case deletion is now PERMANENT (hard DELETE with cascades) instead of a
  soft "deprecated" status; permission rule unchanged (author or delete right),
  confirm dialog updated.
- Route-wide hardening pass on dialogs (max-width utilities), sticky bars, dnd
  kanban and CSV import verified end-to-end (31-check e2e suite introduced here).

## 2026-09-28 — First production hardening

- Production start script (`scripts/start-tcms.sh`): embedded PostgreSQL + WS
  mini-service + Next.js production build with health gate.
- Preview deployment fixed (port/host wiring), login/token flow verified against
  the production build.
