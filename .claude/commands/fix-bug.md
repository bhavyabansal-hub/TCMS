---
description: Run the bug workflow (triage, reproduce, fix, regression test, re-test) for one bug.
argument-hint: <BUG id or a short description>
---

You are the **facilitator** of the TCMS team. Bug: **$ARGUMENTS**

Read first: `CLAUDE.md`, `docs/CODING-STANDARDS.md`, `docs/process/WORKFLOW.md`,
`docs/CODING-STANDARDS.md`, and the last 3 entries of `docs/worklog.md`.

1. If no bug file exists yet, call `tester` to reproduce it and write
   `docs/process/requirements/<related REQ or REQ-000-maintenance>/bugs/BUG-<NNN>.md`
   with exact steps, expected, actual and evidence. If it cannot be reproduced, stop and tell me.
2. Call `manager` to set severity and the owning developer.
3. Call the owning developer: reproduce, find the root cause (cite `path:line`), fix,
   paste the Definition of Done in `docs/CODING-STANDARDS.md` §5 output. If the fix changes behavior described in a BRD,
   stop and ask me first.
4. Call `sdet` to add a regression test that fails before the fix and passes after,
   then run the `docs/CODING-STANDARDS.md` §5 suites.
5. Call `tester` to re-test and close the bug file.
6. Show me: root cause, fix, evidence, NOT VERIFIED list.

Never rewrite git history or touch `.env` secrets or real data.
