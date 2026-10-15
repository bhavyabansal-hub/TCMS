# CLAUDE.md — pointer for AI coding assistants

**Read [`agent.md`](./agent.md) first — it is the canonical, binding coding-standards
contract for this repository** (layered Controller → Validation → Service → Repository
APIs, raw-SQL-only data access, standard response helpers, naming conventions, error
handling, definition of done, task workflow). Follow it for every task.

Read CODEBASE-MAP.md before exploring; update it when structure changes.

Fast orientation:

- **Project:** TCMS — Test Case Management System (Next.js 16 App Router, React 19,
  TypeScript, Tailwind v4 + shadcn/ui, Zustand, React Query, MySQL 8.4 via raw SQL,
  JWT auth, 6-role RBAC with a runtime-togglable permission matrix).
- **Study hub:** `docs/README.md` — numbered docs 01–18 (architecture, database,
  permissions, API reference, frontend, per-page guides, end-to-end flows, file index,
  CSV import, standards, scaling, runbook, Crew Desk) + `docs/migration/` (PG→MySQL)
  plus the compiled `TCMS-ARCHITECTURE-GUIDE.pdf` and refactor reports.
- **Engineering log:** `worklog.md` (append-only).
- **Definition of done:** `agent.md` §3 — tsc 0 errors, eslint clean, verification
  battery green, worklog appended, canonical zip refreshed.
