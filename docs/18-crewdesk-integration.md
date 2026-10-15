# 18 — Crew Desk Integration

TCMS links modules to Crew Desk tickets. ONE shared Crew Desk service account
does everything — nobody needs a personal token, and no per-person Crew Desk
mapping exists. Linking posts ONE comment on the ticket pointing back to the
module's permanent page (`/modules/<module_id>`), and TCMS keeps a history of
every attempt (posted, failed and manual copies).

## 1. Safety model (read this first)

**The "no other ticket" rule is enforced in code, in one file.**

- `src/lib/server/crewdesk.client.ts` is the ONLY file allowed to talk to
  Crew Desk. Its `postTicketComment()` checks, BEFORE any network byte is
  sent:
  - `CREWDESK_MODE` must be exactly `live` to allow any ticket other than the
    designated one. A missing, empty or unrecognized value stays in **test
    mode** — only the single designated test ticket (`CREWDESK_TEST_TICKET_ID`,
    designated `1355` for the current dev setup) may receive comments.
  - `manual` mode makes **no Crew Desk calls at all** (see §4).
- A guard refusal returns a clear error and NOTHING is sent to Crew Desk.
- Credentials live only in server env. They are never hard-coded, never
  logged, never sent to the browser (`?path=config` reports booleans, never
  values). Real tokens/passwords never appear in code, tests or docs.
- Outbound calls time out after `CREWDESK_TIMEOUT_MS` (default 8 s).

## 2. Who posts the comment

- Every comment is posted as the SHARED service account. The `user_id` sent
  with the comment comes from the `CREWDESK_USER_ID` setting — never from a
  person's own Crew Desk id.
- Resolution order: `CREWDESK_USER_ID` setting → `user_id` claim of the fixed
  `CREWDESK_TOKEN` → `user_id` claim of the login-issued in-memory JWT. A
  deployment using password login WITHOUT `CREWDESK_USER_ID` therefore posts
  under the service account's claim automatically (null only before the first
  successful login).
- If the configured credential is a JWT, its `user_id` claim is compared with
  `CREWDESK_USER_ID` when BOTH exist (checked at startup for fixed tokens,
  after every login for password logins) and a warning is logged when they
  disagree.
- The human linker is identified inside the comment text only (see §5).

## 3. How TCMS signs in to Crew Desk (replaceable in .env)

| Mode | Env | Behavior |
|---|---|---|
| Fixed token | `CREWDESK_AUTH=token` + `CREWDESK_TOKEN=…` | Bearer token used as-is. |
| Password login | `CREWDESK_AUTH=login` + `CREWDESK_LOGIN_EMAIL` / `CREWDESK_LOGIN_PASSWORD` | `POST {CREWDESK_LOGIN_PATH:-/api/login}` returns a JWT that is kept IN MEMORY ONLY. |
| (auto, local mock) | neither, with `CREWDESK_BASE_URL` unset/pointing at `127.0.0.1:3010` | `scripts/start-tcms.sh` boots the mock AND injects the mock's FICTIONAL login (`tcms.service@crewdesk.test`) so the integration works out of the box. Any real `CREWDESK_TOKEN`/`CREWDESK_AUTH` in env or `.env` wins — never a real call. |
| (auto, no credential) | neither, real base URL | The integration reports `authMode: none` and refuses calls with a config error. |

Password-login rules:

- The token is refreshed **before** expiry (JWT `exp` claim, 5-minute margin).
- Any **401** triggers exactly one fresh login and one retry of the request.
- **3 failed logins** pause all attempts for **15 minutes**; users see
  "Crew Desk login failed, contact admin" so the shared account can never be
  locked out by a misconfiguration.
- Passwords and tokens are never logged anywhere.

## 4. The three modes

| `CREWDESK_MODE` | Crew Desk traffic | Comment |
|---|---|---|
| `manual` | NONE (lookup refused) | TCMS generates the comment text; the user presses **Copy comment** / **Copy module link** and pastes it into Crew Desk themselves. Every copy is saved in history as a `manual` row and can be re-copied later. |
| `test` (default) | designated test ticket only | posted automatically after the checks below |
| `live` | any ticket (production, set deliberately) | posted automatically after the checks below |

## 5. The comment text (one builder, used everywhere)

```
TCMS: test cases for module "<module name>" — <origin>/modules/<module_id>
Linked by <full name from the TCMS login> (<email from the TCMS login>)
<optional note typed by the linker>
```

- The note is PLAIN TEXT: control characters (tabs, newlines, DEL, C1) are
  removed, whitespace is collapsed, and it is hard-capped at **300
  characters** (sanitized server-side in `crewdesk.validation.ts`).
- The exact same builder produces the posted comment AND the "Copy comment"
  text in manual mode — and the history page's per-row Copy button rebuilds
  the text from the stored fields.
- History stores the real TCMS user (foreign key), the time, the note and the
  Crew Desk comment id.

## 6. Verification-only email check

In test and live modes, BEFORE posting, TCMS looks up the logged-in user's
TCMS email (lowercase, trimmed) in the Crew Desk user list, fetched WITH THE
SHARED credentials:

- Not found → the post is refused before anything is sent and the UI shows
  **"Your email was not found in Crew Desk. Ask your admin."**
- Found → ONLY two facts are stored on the TCMS user: the matched Crew Desk
  user id (`users.crewdesk_user_id`) and the time of the check
  (`users.crewdesk_checked_at`). The Crew Desk user list is NEVER stored,
  shown, or returned to any browser.
- Caching: the list is kept in memory for ~10 minutes; when an email is not
  found the list is refreshed once and the lookup retried; a stored match is
  re-verified at most once every 24 hours (fresh stored check → no network).
- The Integrations page shows a badge: **"verified in Crew Desk"** or
  **"not found in Crew Desk"** (shown as "not required" in manual mode).
- There are NO email exceptions: everyone is matched by their own TCMS login
  email. (The former admin exception feature was removed by product
  decision — table, endpoints, UI card and tests included.)
- Manual mode makes no Crew Desk calls, so it skips this check entirely.

## 7. API endpoints (`/api/integrations/crewdesk`, session required)

| Call | Purpose |
|---|---|
| `POST ?path=lookup` `{ticketId}` | Preview a ticket: title + current status, shown BEFORE submitting. Refused in manual mode. Unknown ticket → 404 `Ticket not found`. |
| `POST` `{moduleId, ticketId, note?}` | Create the link (201 `posted`); in manual mode `ticketId` is optional and the row is a `manual` copy. Duplicates → 409. Any failure → 201 with a `failed` history row keeping the user's input. |
| `POST ?path=retry&linkId=…` | Retry a failed link (email check re-runs, fresh ticket status, stored note). Already-posted → 409. |
| `GET ?path=comment&linkId=…` | Rebuild the copyable comment text + module URL of any history row. |
| `GET ?path=email-check` | The badge status for the logged-in user (never exposes the list). |
| `GET` | Link history (paginated): module, ticket (+title snapshot), linked by, note, date, status, last error. |
| `GET ?path=config` | Safe summary (`mode`, `authMode`, `authConfigured`, `testTicketId`, shared account email) for UI banners. |

## 8. Link flow (create & retry share it)

1. Role gate (`manage_integrations`; viewers cannot create links).
2. Module exists → 404 otherwise.
3. Duplicate guard (`posted`/`failed` rows; a `manual` copy never blocks the
   real link) → friendly 409.
4. **Email check** (test/live only) — stop before posting when not found.
5. `getTicket` — fresh on every attempt (never trust a stale snapshot).
6. Post the comment as the SHARED account with the ticket's current status.
7. History row: `posted` (comment id stored) / `failed` (sanitized reason) /
   `manual` (no call was ever made).

Every failure after the duplicate guard produces a `failed` row — the user's
input is never lost, Retry always picks up where it stopped.

## 9. Schema

- `crew_desk_links` — `status posted|failed|manual`, `crewdesk_comment_id`,
  `ticket_title/ticket_status` snapshots, `note`, `last_error` (sanitized),
  `linked_by_id` (the real TCMS user). Module delete cascades.
- `users.crewdesk_user_id` + `users.crewdesk_checked_at` — the email-check
  result (matched id + time only). The Crew Desk user list and the former
  `crew_desk_email_exceptions` table (removed) are never persisted.

## 10. Mock Crew Desk (ALL automated tests run against this)

`mini-services/crewdesk-mock` (bun, `127.0.0.1:3010`), started automatically
by `start-tcms.sh` when `CREWDESK_BASE_URL` is missing or points at the mock.
It mimics the real API's quirks: form-data only (JSON → 400), `type` /
`user_id` / `status` required, `status_id` → 400, unknown ticket → `Ticket
not found`, comments never change ticket status, bearer auth.

- Tickets: `1355` (designated), `4191` (proves the guard refuses a second
  ticket), `4192`. Anything else is rejected.
- Users: FICTIONAL `@crewdesk.test` accounts only — `tcms.service@…` (the
  shared account, id `7001`), `dana.reyes@…` (id `7002`), a mixed-case entry
  (proves case-insensitive matching) and one email absent from TCMS.
- Auth: fixed token AND `POST /api/login` (returns a signed mock JWT with
  `exp` + a token epoch; wrong credentials → 401 and a counted failure).
- Fault injection (control plane under `/__mock`, same bearer):
  `POST /__mock/config {"mode":"ok"|"down"|"slow"|"badtoken"}` (badtoken
  bumps the epoch, instantly invalidating issued JWTs), `POST /__mock/reset`,
  `GET /__mock/comments | /__mock/tickets | /__mock/stats`.

## 11. Testing rules and evidence

- `scripts/run-crewdesk-tests.sh` phases the app through FOUR configurations
  and runs `scripts/verify-crewdesk.mjs` against each — **mock only**:
  1. `manual` — zero Crew Desk traffic, copy text assertions.
  2. `test-login` — the full posting pipeline: email found / mixed-case /
     not-found-with-exact-message / exceptions-removed-proof / duplicate /
     mode guard / down-and-retry / history + the 401→re-login→retry recovery.
  3. `test-token` — a JWT whose user_id claim intentionally mismatches
     `CREWDESK_USER_ID`: proves the SETTING is what is sent, and the startup
     warning fires (grepped from the server log).
  4. `badcreds` — wrong password: the first three lookups each attempt one
     login, the fourth is blocked locally, and every answer is the friendly
     "Crew Desk login failed, contact admin" (proven via mock login stats).
- The suite also asserts self-signup stays disabled (403) and that the login
  screen renders without a register tab.
- **No script may call a real Crew Desk address until the product owner
  confirms it.** The former real-API scripts were removed on purpose.

## 12. Going live (production checklist)

1. Get the real service-account credentials from the Crew Desk admins.
2. On the production server set EITHER `CREWDESK_AUTH=token` +
   `CREWDESK_TOKEN=…` OR `CREWDESK_AUTH=login` + `CREWDESK_LOGIN_EMAIL` /
   `CREWDESK_LOGIN_PASSWORD`, plus `CREWDESK_USER_ID` (the shared account's
   Crew Desk user id) and `CREWDESK_BASE_URL`. Keep `CREWDESK_MODE=test` and
   the designated test ticket first; watch the startup warning log.
3. When the owner confirms the exact endpoints, update `getTicket()` /
   `postTicketComment()` in the client file (single point of change) if the
   real shapes differ, then switch with intent: `CREWDESK_MODE=live` on the
   production server only.
4. Re-run `node scripts/verify-crewdesk.mjs` — it must stay green against the
   mock even in a live-mode deployment (the suite never touches real APIs).
