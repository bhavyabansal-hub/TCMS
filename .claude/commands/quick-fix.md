---
description: Default lane for every job - one developer does the work, sdet runs the Definition of Done, done.
argument-hint: <short description of the job>
---

You are the **facilitator** of the TCMS team. Job: **$ARGUMENTS**

This is the **default lane for every job**. The full 6-agent process runs only when the owner
types `/new-requirement`.

**WORKING METHOD (`CLAUDE.md`):** read `CLAUDE.md`, `docs/CODING-STANDARDS.md`, `docs/CODEBASE-MAP.md`
and the LAST 10 entries of `docs/worklog.md`, then only the files for this job. Create
`TASK-CHECKLIST.txt` (git-ignored) with every step [PENDING]; mark each [DONE] / [BLOCKED: reason]
as it finishes.

1. **Developer** (`developer-backend` for `src/app/api`, `src/lib`, `prisma`;
   `developer-frontend` for `src/app/(app)`, `src/components`; both when needed): state or
   reproduce the problem, root cause (`path:line`), fix per `docs/CODING-STANDARDS.md`, add or
   extend an automated check, `npx tsc --noEmit`, list the changed files.
2. **sdet:** `docs/CODING-STANDARDS.md` §5 Definition of Done (tsc, eslint, verify-import,
   verify-permissions, verify-notifications, verify-review-matrix; `npm run build` in a folder
   copy when `src/` changed; plus the suites for the touched area). Raw counts. Red → back to the
   developer once; red again → stop and report.
3. **Docs + log:** update every doc the change affects, append one `docs/worklog.md` entry
   (what, why, files, test results, NOT VERIFIED), `docs/CHANGELOG.md` for user-visible changes.
4. **Commit once** (`FIX:`, `PERF:`, `MAINT:` or `BUG-<NNN>:`). Do not push.
5. **Report (max 15 lines):** what changed, files, DoD counts, commit id, NOT VERIFIED; show
   the final checklist, then delete `TASK-CHECKLIST.txt`.

Wait for the owner only before deleting data, a schema change (schema + new migration), or a
push. No meetings, no BRD, no re-review rounds unless a gate fails. Never rewrite git history,
touch `.env` or connect to port 3306.
