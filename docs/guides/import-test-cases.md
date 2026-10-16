# Import Test Cases (CSV) — feature guide

> Added in Task 17. Lets any user with the **`create_test_case`** permission bulk-create
> test cases by uploading a CSV file into a chosen module or submodule. This doc covers
> the user flow, the CSV format, the API contract, and the code path layer by layer.

---

## 1. What the user sees

The **Test Cases** view now has two tabs: **All Test Cases** and **Import CSV**
(the second tab only renders when `can('create_test_case')` is true — everyone else,
including viewers, sees no tab at all and the API would return `403` anyway).

The Import panel walks the user through four steps:

1. **Choose destination** — a module tree picker (submodules indented under their
   parents) selects where the imported cases will land. One import = one destination.
2. **Download sample CSV** — grabs the template from the backend (button triggers a
   real file download `tcms-test-case-import-template.csv`).
3. **Fill it in** — the user writes one test case per row in the downloaded file.
4. **Upload & Import** — after choosing the file, the result card reports
   `imported / failed` counts **per row**, with a *View in module* shortcut that jumps
   to the Test Cases table pre-filtered to the target module so the new drafts are
   immediately visible.

Imported cases are created as **drafts** authored by the importing user, exactly as if
they had been typed into the create dialog one by one (same versioning, activity log,
notification side effects).

## 2. The CSV format (exact contract)

The template itself teaches the format — it starts with `#` instruction lines (ignored
by the parser) followed by a header row and three example rows:

```csv
title,description,preconditions,priority,expected_result,tags,steps
Verify login with valid credentials,Check that a registered user can sign in,User exists and active,P1,User lands on the dashboard,smoke;login,"Open the login page => Login form is displayed;;Enter valid credentials => Fields accept the input;;Click Sign in => Dashboard opens within 2s"
```

| Column | Required | Rules |
|---|---|---|
| `title` | **yes** | non-empty after trim; duplicates are allowed but each row creates its own case |
| `description` | no | free text |
| `preconditions` | no | free text |
| `priority` | no | must be `P0` `P1` `P2` `P3` (empty → default `P2`; anything else = row error) |
| `expected_result` | no | case-level expected result (per-step expected results live in `steps`) |
| `tags` | no | separated by `;` (`,` also accepted); deduplicated by the parser |
| `steps` | no | each step is `action => expected`, steps separated by `;;` (a newline also separates steps) |

Key behaviours worth remembering:

- **Column order does not matter** — the parser maps columns by *name*, with aliases
  (`expected`, `expected_result`, `expectedresult` all map to `expectedResult`;
  `step`/`steps` both map to `steps`). Only the *names* are fixed.
- **Multi-step cases** are just multi-step strings: `action => expected;;action => expected`.
- `#` lines can be deleted or kept; they never become data rows.
- Quoting follows **RFC 4180**: wrap a cell in double quotes when it contains commas,
  newlines or quotes (`""` inside quotes escapes a quote).
- A single file imports **at most 100 rows** (larger files are rejected with a 400).

## 3. API contract

Both actions hang off the existing test-cases resource and require
`Authorization: Bearer <token>` + `create_test_case` permission.

### `GET /api/test-cases?action=import-template`

Returns the sample file for download.

```json
{ "success": true, "data": { "fileName": "tcms-test-case-import-template.csv", "csv": "# TCMS - Test Case Import Template\n..." } }
```

Errors: `401` (no session) · `403` (no `create_test_case`).

### `POST /api/test-cases?action=import`  (multipart/form-data)

| Field | Type | Validation |
|---|---|---|
| `file` | file | must end with `.csv`, size 1 B – 1 MB |
| `moduleId` | string | must be an existing module **or** submodule id |

Response `200`:

```json
{ "success": true, "data": {
  "moduleId": "…", "moduleName": "Authentication",
  "totalRows": 5, "imported": 3, "failed": 2,
  "results": [
    { "row": 1, "title": "Verify login", "status": "created", "testCaseId": "…" },
    { "row": 2, "title": "(untitled)",  "status": "failed",
      "error": "priority must be one of P0, P1, P2, P3" }
  ] } }
```

Errors: `400` (missing file/field, wrong extension, no header/data rows, >100 rows) ·
`401` · `403` · `404` (unknown `moduleId`).

Rows are **independent**: a bad row never blocks the others, and the summary names the
exact row number (as seen by the user, header excluded) plus reason for every failure.

## 4. Code path (layer by layer)

```
Frontend
  views/test-cases.tsx            → tabs: All Test Cases | Import CSV (can()-gated)
  views/test-case-import.tsx      → ImportTestCasesPanel: picker + uploader + result card
  lib/client/api.ts               → testCasesApi.importTemplate() / importCsv()
  lib/client/download.ts          → shared browser download helper (DRY with CSV export)

API (Controller → Validation → Service → Repository)
  route.ts                        → two thin branches, one per action (≈30 lines each)
  test-cases.validation.ts        → validateImportTestCasesBody: moduleId, .csv name, 1 B–1 MB
  test-cases.service.ts           → getTestCasesImportTemplate / importTestCasesFromCsv:
                                    ensurePermission → module lookup → parse → per-row
                                    validate → delegate each row to createTestCase (DRY:
                                    one creation path = versioning, history, activity,
                                    notifications all stay identical to manual creation)
  test-cases.repository.ts        → raw-SQL INSERTs (via createTestCase's repository call)

Shared helpers (no business logic)
  lib/server/csv.ts               → pure RFC-4180 parser (parseCsvDocument) +
                                    parseCsvSteps ('action => expected;;') + parseCsvTags
```

Why per-row delegation to `createTestCase` instead of a bulk INSERT: the import then
**cannot drift** from the manual create flow — permissions, version snapshot, activity
log entry and notifications behave identically, and a failing row surfaces the same
error message a manual create would give. Trade-off (N inserts instead of 1) is
irrelevant at ≤100 rows.

## 5. Verification

`scripts/verify-import.mjs` (32 checks) covers: template 200/403/401 + content shape;
mixed-CSV import (3 created / 2 failed with exact row errors); imported cases land in
the target module with steps, tags, draft status and correct author; developer-without-
permission 403; unknown module 404; no-title-column / no-data-rows / wrong-extension
400s. Run it with the server up:

```bash
node scripts/verify-import.mjs
```

Browser proof: log in as VP → Test Cases → Import CSV → download → fill → upload →
result card → *View in module* shows the imported drafts.
