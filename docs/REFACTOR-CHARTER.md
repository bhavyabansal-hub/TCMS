# REFACTOR CHARTER — 4-Layer API + Raw SQL (MUST READ before writing any code)

You are refactoring ONE API resource of the TCMS Next.js app to the project's
mandatory architecture. Read this charter fully, then the exemplar files, then
your legacy route. The refactor is already partially done — the shared
infrastructure and two exemplar resources (test-cases, auth) are COMPLETE.
Match them exactly.

## 1. Read order (in this order!)

1. `CLAUDE.md` — section "Coding standards (mandatory)" (the law)
2. `prisma/schema.prisma` — NEW schema: snake_case tables/columns, entity-named
   PKs (`users.user_id`, `modules.module_id`, `test_cases.test_case_id`, ...),
   DB-generated uuid ids (`gen_random_uuid()` — INSERTs never supply PKs)
3. `prisma/database-setup.sql` — the physical DDL (exact table/column names)
4. EXEMPLAR (copy these patterns precisely):
   - `src/app/api/test-cases/route.ts` (controller)
   - `src/app/api/test-cases/test-cases.validation.ts`
   - `src/app/api/test-cases/test-cases.service.ts`
   - `src/app/api/test-cases/test-cases.repository.ts`
   - `src/app/api/auth/*` (second exemplar)
5. `src/lib/api.ts` — response helpers + `ApiError` + `withApi` + `getPagination`
6. `src/lib/auth.ts` — `requireUser()`, `ensurePermission()`, `can()`
7. `src/lib/serializers.ts` + `src/types/sql-rows.ts` + `src/types/index.ts`
   (the API contract — FROZEN, do not edit)
8. `src/lib/logger.ts`, `src/lib/activity.ts` (logActivity/parseJson),
   `src/lib/notifications.ts` (createNotification)
9. YOUR legacy route: `src/app/api/<resource>/route.ts` (the behavior spec)

## 2. Files you create (in your resource folder `src/app/api/<resource>/`)

- `<resource>.repository.ts` — raw SQL ONLY (SELECT/INSERT/UPDATE/DELETE)
- `<resource>.validation.ts` — zod schemas, ONE dedicated validator per action,
  each validator THROWS `ApiError.badRequest('Invalid input', flattenZodError(e))`
- `<resource>.service.ts` — business logic + orchestration + serialization
- `route.ts` — thin controller (rewritten; keep the same exported method names
  GET/POST/PUT/PATCH/DELETE)

Layer contract:
- **Controller**: `withApi(req, async () => { ... })` wrapper; `requireUser()`;
  parse query/body; call validator; call ONE service function per action;
  `ok(...)` the result. NO SQL, NO permissions (services do that), NO mapping.
- **Validation**: runs BEFORE services (in the controller). One validator per action.
- **Service**: permissions via `ensurePermission(me, 'action')`, business rules,
  soft deletes, version/snapshot logic, `logActivity`, `createNotification`.
  Services return SERIALIZED (camelCase API) shapes. Throw `ApiError.*` for
  expected failures. Never import NextResponse/next/server into services
  (`NextRequest` as a TYPE for request metadata is allowed, same as exemplar).
- **Repository**: ONLY data access. Functions named `findX`, `listX`, `insertX`,
  `updateX`, `deleteX`, `countX`. No business conditionals, no HTTP, no logging.
  Cross-resource table access MUST go through that resource's repository file
  (import it, e.g. `../test-cases/test-cases.repository`), never ad-hoc SQL
  against another resource's table.

## 3. Raw SQL rules (STRICT)

- ONLY `db.$queryRaw` / `db.$executeRaw` tagged templates (Prisma singleton from
  `@/lib/db`). Parameter values via `${value}` INSIDE the tagged template —
  they become bind parameters. `Prisma.sql` / `Prisma.join` for dynamic
  fragments. NEVER string concatenation, NEVER `$queryRawUnsafe`/
  `$executeRawUnsafe` with user input.
- Identifiers: snake_case, quoted where needed (`"user_id"` only if ambiguous —
  plain names usually work; always quote reserved words).
- JSONB writes: `${JSON.stringify(value)}::jsonb`; nullable:
  `${value ? JSON.stringify(value) : null}::jsonb`.
- **Every UPDATE must set `updated_at = NOW()`** (raw SQL bypasses @updatedAt).
- Counts: `COUNT(*)::int` (avoids BigInt). Aggregates: cast to ::int when the
  column is INTEGER.
- Dates: pass JS `Date` objects as parameters; `new Date(input.string)` in
  services. Nullable dates pass `null`.
- Case-insensitive search uses `ILIKE ${'%'+term+'%'}` (improvement over the
  legacy case-sensitive contains — intentional).
- Return joined reference data via the alias convention
  `<relation>_<column>` (e.g. `au.user_id AS author_user_id`), and build the
  JOIN selects as a module-level `Prisma.sql` constant (see exemplar
  `TEST_CASE_SELECT` / `REVIEW_SELECT`).
- PKs: never insert them — the DB generates uuids. Use `RETURNING *` (or
  `RETURNING <pk>` then re-read with joins, like the exemplar) to get the row.
- Composite keys (bug_test_case_links) stay composite.

## 4. Response & error rules (STRICT)

- Responses only via `ok(data)` / `paginate(...)` from `@/lib/api`
  (pagination envelope: `{ data, page, pageSize, total, totalPages }`).
- Expected errors: `throw ApiError.badRequest/unauthorized/forbidden/notFound/
  conflict(msg, details?)`. Keep the LEGACY error messages for the same
  situations (frontend toasts show them) unless listed in §6.
- Unknown-action dispatches: legacy mixed 200-with-error (stats) or 400 —
  standardize to `throw ApiError.badRequest('Unknown action')`.
- Never leak `password_hash` or stack traces. Users are returned through
  `serializeUser` only.

## 5. Serialization rules (STRICT)

- Rows come back snake_case (`full_name`, `test_case_id`). ALWAYS map them
  through `src/lib/serializers.ts` before returning — the API contract is
  camelCase with entity-named PKs (`testCaseId`, `bugId`, `userId`, ...).
- Optional JOIN refs are emitted only when the join columns exist
  (serializers handle this; just make your SELECT aliases match the
  `<relation>_<column>` convention).
- Paginated lists: `paginate(rows.map(serializeX), total, page, pageSize)`.

## 6. Intentional behavior changes (already decided — do not "preserve" these)

1. All PKs renamed `id` → entity names in DB, services and API JSON.
2. Search filters are now CASE-INSENSITIVE (ILIKE).
3. Unknown actions now consistently return 400 `{error}` (stats used to return 200).
4. Notification ownership violations now return 403 (used to be 400).
5. Every response now flows through the standard envelope helpers.

Everything else (endpoints, query-param style `?id=&action=`, side effects,
notification texts, activity log entries, status codes, error messages) must
behave exactly like the legacy route. Read the legacy file LINE BY LINE.

## 7. Naming conventions

- Files: `<resource>.<layer>.ts` (kebab-case resource).
- Functions: verb-first camelCase (`listBugs`, `createBug`, `updateBugStatus`).
  One action = one validator + one service function (dedicated, no mega-functions).
- Repos: find*/list*/insert*/update*/delete*/count*.
- Booleans read as predicates; constants SCREAMING_SNAKE; types PascalCase.
- Small functions; extract shared logic rather than copy-pasting (DRY).

## 8. Logging

- `logger.info('Business event', { context })` for important service events.
- `logger.warn` for expected failures you want visible; `logger.error` inside
  catch-and-continue paths. Controllers get request logs free via `withApi`.

## 9. Verify your work (mandatory before you report done)

```bash
cd /home/z/my-project
npx tsc --noEmit 2>&1 | grep "<your files>"   # must be EMPTY
npx eslint src/app/api/<resource> src/lib --max-warnings 0  # must pass
```

Legacy OTHER routes still error — ignore errors outside your files.
(Also ignore pre-existing errors under `skills/`.)

## 10. Worklog protocol

- BEFORE working: read `/home/z/my-project/worklog.md` (tail) for context.
- AFTER working: APPEND a section starting with a `---` line, then
  `Task ID: <given id>`, `Agent:`, `Task:`, `Work Log:` bullets, `Stage Summary:`.
  Never overwrite existing content.

## 11. Do NOT touch

- `src/lib/serializers.ts`, `src/types/*` (frozen contract — report gaps back)
- Other resources' `route.ts`/service/validation files
- `prisma/*`, `package.json`, `vercel.json`, docs, frontend components
- The exemplar files (test-cases, auth) except to READ them
