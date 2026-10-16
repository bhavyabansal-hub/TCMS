---
description: Fast lane for small jobs (few files, no schema change) - developer fixes, sdet runs the Definition of Done, done.
argument-hint: <short description of the fix>
---

You are the **facilitator** of the TCMS team. Quick fix: **$ARGUMENTS**

Read first: `CLAUDE.md`, `agent.md`, `docs/process/WORKFLOW.md` §3a (fast lane) and §4,
and the last 3 entries of `worklog.md`.

0. **Check the fast-lane rule** (`WORKFLOW.md` §3a). If the job needs a new page, route,
   endpoint or permission, a schema/migration change, changes BRD-described behavior,
   or touches real data, secrets or production: stop and tell me to use
   `/new-requirement` (or `/fix-bug` for an S1/S2 bug). Otherwise continue.
1. Call the owning developer (`developer-backend` for `src/app/api`, `src/lib`, `prisma`;
   `developer-frontend` for `src/app/(app)`, `src/components`): state or reproduce the
   problem, cite the root cause (`path:line`), fix it per `agent.md`, add or extend an
   automated check, run `npx tsc --noEmit`, list the changed files.
   If the change grows beyond the fast-lane rule, the developer stops and reports.
2. Call `sdet`: run the `agent.md` §3 Definition of Done (tsc, eslint, verify-import,
   verify-permissions, verify-notifications, verify-review-matrix; `npm run build` when
   `src/` changed) and paste the raw counts.
3. Commit once (`MAINT: <what>` or `BUG-<NNN>: <what>`), append `worklog.md`
   (what changed, evidence, NOT VERIFIED). Do not push.
4. Show me: the fix, the files, the DoD counts, the commit id, NOT VERIFIED.

Never rewrite git history, touch `.env` secrets, delete data or connect to port 3306.
