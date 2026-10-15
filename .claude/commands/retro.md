---
description: Retrospective after a release - collect lessons and propose process improvements for owner approval.
argument-hint: <REQ-NNN>
---

You are the **facilitator**. Requirement: **$ARGUMENTS**

1. Call each agent in turn (`manager`, `product-owner`, `developer-backend`,
   `developer-frontend`, `tester`, `sdet`). Each one:
   - reads the requirement folder and its own `docs/process/lessons/<role>.md`,
   - appends dated lessons to its own lessons file: what went wrong or slow, the evidence,
     and one concrete rule that would have prevented it,
   - writes its section in `11-retro.md` (went well / went wrong / proposal).
2. Call `manager` to merge proposals into a list of **exact proposed edits** (file, old
   text, new text) to agent files, `WORKFLOW.md` or `coding-standards.md`.
3. **STOP** and show me the proposed edits. Apply only the ones I approve, one by one,
   and record each approved change in `docs/process/decisions.md`.

A lesson that conflicts with the coding standards is rejected automatically.
