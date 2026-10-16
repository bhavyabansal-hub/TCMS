---
description: After owner approval, run design, development, testing, UAT, bug loop and release review for an approved requirement.
argument-hint: <REQ-NNN>
---

You are the **facilitator** of the TCMS team. Requirement: **$ARGUMENTS**

Read first: `CLAUDE.md`, `docs/CODING-STANDARDS.md`, `docs/process/WORKFLOW.md`,
`docs/CODING-STANDARDS.md`, the whole folder `docs/process/requirements/$ARGUMENTS*/`,
and the last 3 entries of `docs/worklog.md`.

**Gate check:** if `REQ-001 review (git history)` does not contain my "APPROVED", stop and tell me.

Then run, in order, stopping at every gate that fails:

1. **Design (phase 5).** `developer-backend` then `developer-frontend` write `REQ-001 design (git history)`.
   `tester` then `sdet` write `REQ-001 test-plan (git history)`. Show me the design summary and ask:
   "Proceed to development?" Wait for my OK if the design touches the schema, auth,
   permissions, or deletes anything.
2. **Development (phase 6).** `developer-backend`, then `developer-frontend`.
   Each must paste the Definition of Done in `docs/CODING-STANDARDS.md` §5 results. Small commits, message
   starting with the REQ id. If a gate fails, send it back to the same developer once;
   if it fails again, stop and show me.
3. **Testing (phase 7).** `sdet` (automated tests + full regression + standards review),
   then `tester` (manual plan execution). Bugs go into `bugs/`.
4. **UAT (phase 8).** `product-owner` checks every acceptance criterion in `08-uat.md`.
5. **Bug loop (phase 9).** If bugs exist: `manager` triages severity; the owning developer
   fixes; `sdet` adds a regression test; `tester` re-tests. Repeat until no S1/S2 remain.
   Stop and ask me if the same bug fails twice or a fix needs a scope change.
6. **Release review (phase 10).** `manager` writes `10-release.md`.
7. **STOP.** Show me the release review. Only I can say "RELEASE".
   After "RELEASE", run `/retro $ARGUMENTS`.

Never rewrite git history, never push without my instruction, never touch `.env` secrets
or real data.
