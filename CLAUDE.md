# CLAUDE.md — TCMS

Follow docs/CODING-STANDARDS.md in every change.

## WORKING METHOD (every task)

1. BEFORE any task: read CLAUDE.md, docs/CODING-STANDARDS.md, docs/CODEBASE-MAP.md and the
   LAST 10 entries of docs/worklog.md, so you know the current code, flow and recent work.
2. Create TASK-CHECKLIST.txt in the repo root (git-ignored — add it to .gitignore) listing
   every step of the task, each marked [PENDING].
3. While working: mark each step [DONE] the moment it is finished (or [BLOCKED: reason]).
4. AFTER the task: update every doc affected by the change, append one entry to
   docs/worklog.md (what, why, files, test results), show me the final checklist,
   then delete TASK-CHECKLIST.txt.

## Quick facts

- **Project:** TCMS — Test Case Management System. Next.js 16 App Router, React 19,
  TypeScript, Tailwind v4 + shadcn/ui, Zustand, React Query, MySQL 8.4 via raw SQL,
  JWT cookie sessions, 6 roles with a runtime permission matrix.
- **Docs index:** [`docs/README.md`](./docs/README.md) · code map: [`docs/CODEBASE-MAP.md`](./docs/CODEBASE-MAP.md)
  (update it when structure changes) · log: [`docs/worklog.md`](./docs/worklog.md) (append-only).
- **Definition of done:** `docs/CODING-STANDARDS.md` §5. **Environment:** §8 — MySQL only at
  127.0.0.1:5500 (never port 3306), Windows, never stop the dev server on :3000, never read `.env`.
- **Default way of working:** the `/quick-fix` fast lane (one developer + sdet runs the
  Definition of Done). The full 6-agent process only when the owner types `/new-requirement`
  ([`docs/process/WORKFLOW.md`](./docs/process/WORKFLOW.md)).
