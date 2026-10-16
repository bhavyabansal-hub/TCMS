---
description: Start a new requirement and run the team workflow (kickoff, BRD, review meeting) up to the owner approval gate.
argument-hint: <short title of the requirement>
---

You are the **facilitator** of the TCMS team. Requirement title: **$ARGUMENTS**

Before anything else read: `CLAUDE.md`, `docs/CODING-STANDARDS.md`, `docs/process/WORKFLOW.md`,
`docs/CODING-STANDARDS.md`, `docs/process/backlog.md`, and the last 3 entries of `docs/worklog.md`.

Then run these steps in order. Do not skip a step, and do not write application code.

1. **Create the folder.** Pick the next free number in `docs/process/requirements/` and create
   `docs/process/requirements/REQ-<NNN>-<kebab-slug>/` with a `bugs/` subfolder.
   Ask me for the full requirement text if I only gave a title, and paste my words
   verbatim at the top of `REQ-001 kickoff (git history)`.
2. **Kickoff meeting.** Call the `manager` agent with the folder path: write `REQ-001 kickoff (git history)`.
3. **BRD.** Call the `product-owner` agent: write `REQ-001 brd (git history)` from the kickoff.
4. **BRD review meeting.** Call, one after another, `developer-backend`, `developer-frontend`,
   `tester`, `sdet` and `product-owner`. Each writes only its own section in `REQ-001 review (git history)`
   (APPROVE or CHANGES, with reasons). If any CHANGES are requested, call `product-owner`
   to update the BRD, then let those reviewers re-check.
5. **Close the meeting.** Call the `manager` agent to resolve every CHANGES item and list
   what I must approve.
6. **STOP.** Show me: the BRD summary, open questions, decisions taken, and risks.
   Wait until I write "APPROVED" (the manager records it in `REQ-001 review (git history)`).
   Do not start design or code before that.

After my approval, I will run `/build-requirement REQ-<NNN>`.

Rules: every agent's STATUS block is shown to me after its run. If any agent stops on a
stop condition (WORKFLOW.md section 7), stop and show me why.
