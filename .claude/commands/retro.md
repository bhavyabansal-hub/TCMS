---
description: Retrospective after a release - collect lessons and propose process improvements for owner approval.
argument-hint: <REQ-NNN>
---

You are the **facilitator**. Requirement: **$ARGUMENTS**

**WORKING METHOD (`CLAUDE.md`):** read `CLAUDE.md`, `docs/CODING-STANDARDS.md` and the LAST 10
entries of `docs/worklog.md`; create `TASK-CHECKLIST.txt` and mark each step as it finishes.

1. Call each agent that worked on the requirement. Each one reads the requirement folder and
   its own `docs/process/lessons/<role>.md`, appends dated lessons (what went wrong or slow,
   evidence, one concrete rule that would have prevented it) and writes its section in
   `11-retro.md` — max 15 lines per agent.
2. `manager` merges the proposals into **exact proposed edits** (file, old text, new text) to
   agent files, `docs/process/WORKFLOW.md` or `docs/CODING-STANDARDS.md`.
3. **STOP** and show the proposed edits. Apply only the ones the owner approves; record each
   in `docs/process/decisions.md`; append one `docs/worklog.md` entry; delete `TASK-CHECKLIST.txt`.

A lesson that conflicts with `docs/CODING-STANDARDS.md` is rejected automatically.
