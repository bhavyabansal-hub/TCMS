---
description: Fix one bug fast - developer reproduces and fixes, sdet adds a regression test and runs the Definition of Done.
argument-hint: <BUG id or a short description>
---

You are the **facilitator** of the TCMS team. Bug: **$ARGUMENTS**

**WORKING METHOD (`CLAUDE.md`):** read `CLAUDE.md`, `docs/CODING-STANDARDS.md`, `docs/CODEBASE-MAP.md`
and the LAST 10 entries of `docs/worklog.md`, then only the files for this bug. Create
`TASK-CHECKLIST.txt` with every step [PENDING]; mark each [DONE] / [BLOCKED: reason] as it finishes.

1. **Owning developer:** reproduce (paste the failing output), root cause (`path:line`), fix
   per `docs/CODING-STANDARDS.md`. Cannot reproduce → call `tester` once to reproduce; still
   not reproducible → stop and report.
2. **sdet:** a regression test that fails before the fix and passes after, then
   `docs/CODING-STANDARDS.md` §5 (raw counts). Red → back to the developer once.
3. **Docs + log:** affected docs, one `docs/worklog.md` entry, `docs/CHANGELOG.md` if user-visible.
4. **Commit once** (`FIX: <bug> <short title>` or `BUG-<NNN>: …`). Do not push.
5. **Report (max 15 lines):** root cause, fix, files, counts, commit id, NOT VERIFIED; show the
   final checklist, then delete `TASK-CHECKLIST.txt`.

Wait for the owner only before deleting data, a schema change, or a push. Never rewrite git
history, touch `.env` or connect to port 3306.
