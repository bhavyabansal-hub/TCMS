# TCMS Coding Standards (mandatory)

Owner-defined. Every agent follows these. `agent.md` remains the detailed contract;
if this file and `agent.md` disagree, stop and report it to the manager.

## 1. Owner's standards (verbatim)

- Follow consistent naming conventions for files, variables, and functions.
- Every function/class name should define its purpose clearly.
- Keep functions and components small and focused on a single responsibility.
- Every feature should be decoupled and modular, promoting reusability and maintainability.
- Use DRY (Don't Repeat Yourself) principles to avoid code duplication.
- All DB queries must be raw SQL queries.
- Use standard helper response objects for API responses to maintain consistency.
- Use Controller → Validation → Service → Repository pattern to organize the flow of data and business logic consistently.
- The controller only handles the incoming request, invokes the appropriate validation and service methods, and returns the response.
- The service layer contains the core business logic and orchestrates calls to the repository layer.
- The repository layer is responsible for direct data access, such as database queries, and must not contain business logic.
- Validation is performed before reaching the service layer to ensure data integrity and prevent unnecessary processing.
- Errors and exceptions are handled gracefully at the appropriate layer, with meaningful messages returned to the client.
- Each controller function has its own dedicated validation and service methods.
- Every page has a proper route, and every route has matching permissions.
- The `docs/` folder is updated with every new requirement and change; proper logs are maintained.
- Use basic and best LLD principles to keep the application stable and fast.
- Use proper caching, load management and the singleton pattern.

## 2. How these apply in TCMS (concrete rules)

### 2.1 API layering (per resource folder `src/app/api/<resource>/`)
| File | Allowed | Forbidden |
|---|---|---|
| `route.ts` (controller) | parse request, `requireUser`, call one validator + one service, return via `ok()` / `paginate()` inside `withApi` | SQL, business rules, `NextResponse.json` directly |
| `<resource>.validation.ts` | zod schemas, one `validate<Action>()` per controller action, throws `ApiError.badRequest` | DB access |
| `<resource>.service.ts` | permissions (`ensurePermission`), business rules, orchestration, logging, notifications | SQL, `next/server` imports, HTTP objects |
| `<resource>.repository.ts` | parameterized raw SQL via `$queryRaw` / `$executeRaw` tagged templates | business logic, permission checks, `$queryRawUnsafe` |

- Cross-resource data: call the other resource's repository or service, never write ad-hoc SQL against its tables.
- Every raw SQL write sets timestamps with `UTC_TIMESTAMP(3)`.
- No `INSERT IGNORE`; duplicates use `ON DUPLICATE KEY UPDATE <pk> = <pk>`.
- Aggregates wrapped in `Number()`, booleans normalized at the repository boundary.

### 2.2 Errors
- Throw `ApiError` with a clear message; `withApi` converts it to the response envelope.
- Never return stack traces, SQL or secrets to the client.

### 2.3 Routes and permissions
- Every page is a real App Router route under `src/app/(app)/...` with its own URL.
- Every page that needs a permission is wrapped in the client gate (`RequirePermission`)
  **and** its API service calls `ensurePermission`. The server check is the law; the UI gate is UX.
- The sidebar shows a link only when the user holds the permission.
- New permissions go into the permission matrix and are documented in `docs/` (route → permission table).

### 2.4 Naming
| Thing | Style | Example |
|---|---|---|
| Files | kebab-case | `test-cases.service.ts` |
| Functions | verb-first camelCase | `listTestCasesPaginated` |
| Types / components | PascalCase | `TestCaseDetail` |
| Constants | SCREAMING_SNAKE | `RECENT_ACTIVITY_LIMIT` |
| Booleans | predicate | `isActive`, `canDelete` |
| DB tables / columns | snake_case, entity-named PKs | `test_cases.test_case_id` |

### 2.5 LLD principles
- Single responsibility per function, component and file.
- Dependencies point one way: controller → validation → service → repository → db.
- Depend on small interfaces; keep modules replaceable.
- No duplicate logic: shared helpers live in `src/lib/` or `src/components/shared/`.

### 2.6 Performance, caching, load
- One Prisma client per process (`src/lib/db.ts` singleton). Never create another.
- Bounded connection pool via `DATABASE_URL` (`connection_limit`, `pool_timeout`).
- Cache only read-heavy, shareable data via `src/lib/server/cache.ts` (TTL, coalescing);
  invalidate on write. Never cache per-user secrets or failed loads.
- Add indexes through migrations when a new query filters or sorts on a column.
- Lists are paginated with a server-side cap.

### 2.7 Logs
- Use `src/lib/logger.ts` only (writes `logs/app-*.log` and `logs/error-*.log`).
- Log business events (create/update/delete, failures) with ids, never secrets or passwords.
- Every write is also recorded through `logActivity`.

### 2.8 Database changes
- Change `prisma/schema.prisma`, then create a migration; production runs only `prisma migrate deploy`.
- Collation `utf8mb4_unicode_ci`; secrets columns `utf8mb4_bin`; JSON defaults in the migration SQL.

## 3. Definition of Done (every change)

- [ ] Standards audit: `node scripts/audit-standards.mjs` → 0 violations (if the script exists; if not, report it)
- [ ] `npx tsc --noEmit` → 0 errors
- [ ] `npx eslint .` → 0 errors
- [ ] All existing test suites green (raw counts pasted)
- [ ] New behavior covered by an automated test
- [ ] Routes + permissions table updated in `docs/`
- [ ] `worklog.md` entry appended (what changed, evidence, NOT VERIFIED list)
- [ ] `CHANGELOG.md` updated for user-visible changes
