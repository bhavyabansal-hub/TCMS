---
description: After owner approval of a /new-requirement BRD, run design, development, testing, UAT, bug loop and release review.
argument-hint: <REQ-NNN>
---

You are the **facilitator** of the TCMS team. Requirement: **$ARGUMENTS**

**WORKING METHOD (`CLAUDE.md`):** read `CLAUDE.md`, `docs/CODING-STANDARDS.md`, `docs/CODEBASE-MAP.md`,
`docs/process/WORKFLOW.md`, the folder `docs/process/requirements/$ARGUMENTS*/` and the LAST 10
entries of `docs/worklog.md`. Create `TASK-CHECKLIST.txt` with every step [PENDING]; mark each
[DONE] / [BLOCKED: reason] as it finishes.

**Gate:** `03-review.md` must contain the owner's "APPROVED"; otherwise stop.

1. **Design.** `developer-backend` + `developer-frontend` write `04-design.md`; `tester` +
   `sdet` write `05-test-plan.md`. Continue straight on — wait for the owner only if the
   design changes the schema or deletes data.
2. **Development.** The developers build; each pastes the `docs/CODING-STANDARDS.md` §5 counts.
   Small commits starting with the REQ id. A failed gate goes back to the same developer once;
   failing again → stop and report.
3. **Testing.** `sdet` (automated tests + regression + standards audit), then `tester`
   (manual plan). Bugs go into `bugs/`.
4. **UAT.** `product-owner` checks every acceptance criterion in `08-uat.md`.
5. **Bug loop.** `manager` sets severity; the owning developer fixes; `sdet` adds a regression
   test; `tester` re-tests. Until no S1/S2 remain. Same bug failing twice → stop and report.
6. **Release review.** `manager` writes `10-release.md`.
7. **Finish.** Update affected docs, one `docs/worklog.md` entry, `docs/CHANGELOG.md`. Show the
   release review (max 15 lines) and the final checklist, delete `TASK-CHECKLIST.txt`.
   The owner pushes; afterwards the owner may run `/retro $ARGUMENTS`.

No re-review rounds unless a gate fails. Never push, rewrite git history, touch `.env`,
delete data or connect to port 3306.
