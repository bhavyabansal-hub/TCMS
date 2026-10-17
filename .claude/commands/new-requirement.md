---
description: Full 6-agent process (kickoff, BRD, one review round) up to the owner approval gate - only when the owner types /new-requirement.
argument-hint: <short title of the requirement>
---

You are the **facilitator** of the TCMS team. Requirement title: **$ARGUMENTS**

The owner chose the **full process** for this job (`docs/process/WORKFLOW.md` §3).

**WORKING METHOD (`CLAUDE.md`):** read `CLAUDE.md`, `docs/CODING-STANDARDS.md`, `docs/CODEBASE-MAP.md`,
`docs/process/WORKFLOW.md`, `docs/process/backlog.md` and the LAST 10 entries of
`docs/worklog.md`. Create `TASK-CHECKLIST.txt` with every step below [PENDING]; mark each
[DONE] / [BLOCKED: reason] as it finishes. No application code in this command.

1. **Folder.** Next free number in `docs/process/requirements/` →
   `docs/process/requirements/REQ-<NNN>-<kebab-slug>/` with `bugs/`. Paste the owner's words
   verbatim at the top of `01-kickoff.md` (ask for the full text only if just a title was given).
2. **Kickoff.** `manager` writes `01-kickoff.md`.
3. **BRD.** `product-owner` writes `02-brd.md`.
4. **One review round.** `developer-backend`, `developer-frontend`, `tester`, `sdet` each write
   their section in `03-review.md` (APPROVE or CHANGES with reasons). `product-owner` applies
   the CHANGES to the BRD once. A second round only if a reviewer marks a gate as failed.
5. **Close.** `manager` resolves every CHANGES item and lists what the owner must approve.
6. **STOP.** Show (max 15 lines): BRD summary, open questions, decisions, risks. Wait for the
   owner's "APPROVED" (recorded in `03-review.md`). Then the owner runs `/build-requirement REQ-<NNN>`.

Each agent's report is at most 15 lines. If an agent hits a stop condition (WORKFLOW §7), stop
and show why.
