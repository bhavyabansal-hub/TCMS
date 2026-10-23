# Plan — readable numeric IDs (INT AUTO_INCREMENT)

Status: **BUILT 2026-10-17** (owner OK: Q1 INT UNSIGNED, Q2 digit strings, Q4 reset + reseed).
Changes against this plan, decided while building:
- **Q3:** no drop-all migration — the three old migrations were REPLACED by one clean baseline
  `20261017120000_baseline_numeric_ids` (production never ran a migration).
- **activity_logs.entity_id** stays `VARCHAR(64)`: permission toggles log `role:action` keys there.
- The seed also creates one wiki document (so `/wiki/[id]` is checked).
- Row ids become digit strings in ONE place: a Prisma query hook in `src/lib/db.ts` (and the same
  hook in `scripts/lib/db-guard.mjs` for the suites).
Results: `docs/worklog.md` (task numeric-ids-2026-10-17).

Goal: every table key becomes `1, 2, 3 …` (`INT UNSIGNED AUTO_INCREMENT`) instead of a
`CHAR(36)` UUID. Production starts empty (decision D2), so no data is converted; the dev
database `tcms_test` is reset and reseeded.

## 1. Decisions to confirm (recommendation first)

| # | Question | Recommendation | Alternative |
|---|---|---|---|
| Q1 | Column type | `INT UNSIGNED` (max 4.29 billion) for every key — the driver returns plain JS numbers, no BigInt handling | `BIGINT UNSIGNED` for `activity_logs` / `notifications` (needs BigInt → Number at every repository boundary) |
| Q2 | How ids travel in the API and the UI | **Digit strings** (`"42"`): URLs `/test-cases/42`, Select values, Maps and route params stay strings — the frontend barely changes; repositories convert at the boundary | JSON numbers (`42`) and `number` in TypeScript — 58 type fields, 13 Select bindings and 5 route reads change |
| Q3 | Migration shape | One new migration `numeric_ids` that drops all 17 tables (child → parent) and recreates them with numeric keys; history stays linear and `migrate deploy` works everywhere | Squash `prisma/migrations/` into a new baseline (needs `migrate resolve` on every existing database) |
| Q4 | Dev data | Reset `tcms_test` (all rows deleted) and reseed with `/api/seed` | — (there is nothing to keep) |

Q3 + Q4 delete all dev data — that needs the owner's explicit OK.

## 2. What changes

### Database (`prisma/schema.prisma` + new migration)
- **14 UUID keys** → `Int @id @default(autoincrement()) @db.UnsignedInt`: users, refresh_tokens,
  modules, test_cases, test_case_history, module_review_requests, review_requests, review_events,
  bugs, task_reports, notifications, activity_logs, crew_desk_links (`link_id`), wiki_documents.
  Unchanged: `role_permissions` (`role, action`), `login_attempts` (`email`),
  `bug_test_case_links` (composite of two numeric FKs).
- **30 foreign-key columns** → `INT UNSIGNED` (same nullability, same ON DELETE rules):
  module parent/owner/created/updated by, test case module/author/assignee/last editor, history
  case/changed by, reviews (case, reviewer ×3, requester ×2, module review), events, bugs
  (module, reported by ×2, assigned to), bug ↔ test-case link (both), task reports, notifications,
  activity logs, Crew Desk links, wiki (author, last editor), refresh tokens.
- **Polymorphic ids** `activity_logs.entity_id`, `notifications.entity_id` → `INT UNSIGNED NULL`.
- **JSON ids** inside `task_reports.tasks` (`moduleId` / `testCaseId` / `bugId`) → numbers.
- Index names unchanged; the list-sort indexes from 2026-10-17 are recreated.

### Data access (20 repositories, 45 row interfaces in `src/types/sql-rows.ts`)
- Remove `newId()` (`src/lib/server/id.ts`, 23 call sites in 14 files). MySQL has no `RETURNING`,
  so an INSERT returns its key with `SELECT LAST_INSERT_ID()` — **on the same connection**: each
  insert helper runs INSERT + `LAST_INSERT_ID()` inside one `db.$transaction` (or the caller's
  `tx`). This is the main code change and the main risk (§4).
- Multi-row inserts (module review fan-out, verdict batch, CSV import) use the first id +
  row count (InnoDB gives consecutive ids to one simple INSERT) or re-select by a natural key.
- Row interfaces: `*_id: string` → `number`; serializers turn them into the API form (Q2).

### Validation, services, auth
- Id inputs: `z.string().min(1)` → positive-integer string (`/^\d+$/`); the one `.uuid()`
  (Crew Desk `linkId`) → the same.
- JWT `sub`, WebSocket ticket and socket room `user:<id>` carry the numeric id (7 places);
  existing sessions become invalid after the reset (everyone signs in again).
- Seed: references by `LAST_INSERT_ID()` instead of pre-generated UUIDs.

### Frontend
- With Q2 = digit strings: no type changes; the URL contract (`/test-cases/42`, `?moduleId=7`)
  keeps working. With JSON numbers: 58 type fields, 13 Select bindings, 5 route reads.

### Scripts and docs
- 11 scripts that query ids directly, the fake-UUID probes (`00000000-…` in
  verify-permission-matrix, verify-security-fixes, mysql-correctness-test) and UUID regexes
  (`verify-permission-toggle-e2e` path masking, `mysql-correctness-test`) → numeric forms.
- Docs: `architecture/database.md` (keys), `api-reference.md` (id fields), `CODING-STANDARDS.md`
  §2/§4 (naming rule stays "entity-named keys"; the `newId()` rule becomes `LAST_INSERT_ID()`).

## 3. Order of work (one commit per step)

1. Schema + migration (drop + recreate); apply to `tcms_test` (**owner OK**), reseed.
2. Repositories + `sql-rows` types + id helper removal (insert pattern).
3. Validation / services / auth / WebSocket ids.
4. Frontend adjustments (minimal with Q2 = strings).
5. Scripts.
6. Docs + worklog.

## 4. Risks

| Risk | Mitigation |
|---|---|
| `LAST_INSERT_ID()` read on a different pooled connection returns the wrong id | One shared insert helper that always runs inside a transaction; a test inserting in parallel from 50 requests and checking every returned id belongs to its row |
| Multi-row insert ids not consecutive | Only simple multi-row INSERTs (consecutive in InnoDB); otherwise re-select by natural key |
| Guessable ids (`/test-cases/1`, `/test-cases/2`) | Every endpoint already checks the session and the permission per row; the permission suites prove it — ids were never a security boundary |
| A missed `string` id in SQL (`WHERE x = 'abc'`) | MySQL compares numbers and digit strings; `tsc` + the row types catch shape errors; full suite run |
| Old sessions / cookies after the reset | Expected: sign in again |

## 5. How it is proven

- `npx tsc --noEmit`, `npx eslint .`, `node scripts/audit-standards.mjs` (0 / 0 / 0).
- `npx prisma migrate deploy` on the reset `tcms_test`; drift check = empty migration.
- All suites 0 failed: verify-import, verify-permissions, verify-notifications, verify-review-matrix,
  verify-concurrency, verify-db-errors, verify-flagged-fields, verify-safety, verify-ui-gates,
  verify-page-apis, **verify-role-flows-e2e** and **verify-permission-toggle-e2e**.
- New check: every id in every list/detail response is a positive integer (string or number per
  Q2), and a parallel-insert test proves `LAST_INSERT_ID()` returns the right row.
- `npm run build` in a separate folder copy.
