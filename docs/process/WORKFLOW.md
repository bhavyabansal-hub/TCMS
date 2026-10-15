# TCMS Team Workflow (binding for every agent)

Six agents build and maintain TCMS together: **manager**, **product-owner**,
**developer-backend**, **developer-frontend**, **tester**, **sdet**.
The human owner has the final say on scope, BRD approval and release.

Every agent reads this file, `docs/process/coding-standards.md`, `CLAUDE.md`,
`agent.md` and its own `docs/process/lessons/<role>.md` before doing anything.

---

## 1. How the team actually runs in Claude Code (read this once)

- Each agent is a **subagent** (`.claude/agents/<role>.md`). Subagents cannot call
  each other. The **main Claude Code session is the facilitator**: it calls the
  agents in the order below, passes the requirement folder path, and stops at
  every gate that needs the owner.
- A "meeting" = every required agent writes its own section into the same
  requirement document. Nobody edits another agent's section; they reply below it.
- Agents keep **no memory between runs**. Everything they need lives in files:
  the requirement folder, `worklog.md`, `docs/process/decisions.md` and
  `docs/process/lessons/`. If it is not written down, it did not happen.
- Commands: `/new-requirement <title>`, `/build-requirement <REQ-ID>`,
  `/fix-bug <BUG-ID or description>`, `/retro <REQ-ID>` (see `.claude/commands/`).

## 2. Requirement folder

Every requirement gets `docs/requirements/REQ-<NNN>-<slug>/`:

| File | Written by | Phase |
|---|---|---|
| `01-kickoff.md` | manager | 1 |
| `02-brd.md` | product-owner | 2 |
| `03-review.md` | all six, one section each; manager closes it | 3 |
| `04-design.md` (LLD) | developer-backend + developer-frontend | 5 |
| `05-test-plan.md` | tester (manual) + sdet (automated) | 5 |
| `06-dev-report.md` | developers | 6 |
| `07-test-report.md` | tester + sdet | 7 |
| `08-uat.md` | product-owner | 8 |
| `bugs/BUG-<NNN>.md` | tester / sdet (found), developers (fix notes) | 7–9 |
| `10-release.md` | manager | 10 |
| `11-retro.md` | manager (all contribute) | 11 |

Templates: `docs/process/templates/`.

## 3. Phases and gates

| # | Phase | Who | Gate to pass before the next phase |
|---|---|---|---|
| 0 | Intake | facilitator | Owner's request copied verbatim into `01-kickoff.md` |
| 1 | Kickoff meeting | manager | Scope in/out written; affected files verified by reading them |
| 2 | BRD | product-owner | Every requirement has acceptance criteria; every page has a route + permission |
| 3 | BRD review meeting | all six | Each role wrote APPROVE or CHANGES with reasons; manager resolved every CHANGES |
| 4 | **Owner approval** | human owner | Owner writes "APPROVED" in `03-review.md`. **No code before this.** |
| 5 | Design (LLD) + test plan | developers, tester, sdet | Design maps every BRD item to files/layers; test plan maps every acceptance criterion to a test |
| 6 | Development | developers | Definition of Done in `agent.md` §3 passes (raw output pasted) |
| 7 | Testing | tester + sdet | Every acceptance criterion tested; new automated tests added; `agent.md` §3 suites green |
| 8 | UAT | product-owner | Every acceptance criterion marked PASS with evidence |
| 9 | Bug loop | all | No open S1/S2 bugs; every fix re-tested; `agent.md` §3 suites green again |
| 10 | Release review | manager → owner | Every gate PASS with evidence; owner says "RELEASE" |
| 11 | Retrospective | all | Lessons written; proposed process edits listed for owner approval |

**A gate fails if any item is missing evidence.** Missing evidence = "NOT VERIFIED", never "probably fine".

## 4. Ground rules (no exceptions)

### Truth and evidence (anti-hallucination)
1. Never claim a file, function, route, column, endpoint or test exists unless you
   opened it in this run. Cite `path:line`.
2. Never claim something works without pasting the command and its raw output.
3. Unknown → write "UNKNOWN" and add an open question. Never guess numbers, names or results.
4. If two documents disagree, stop and report both; do not pick silently.
5. Every report ends with a **NOT VERIFIED** list (empty only if truly empty).

### Scope
6. Work only on the approved BRD. New ideas go to `docs/process/backlog.md`.
7. Each agent edits only the paths its agent file allows.

### Code and data safety
8. Coding standards (`agent.md`; owner's wording in `coding-standards.md`) are mandatory.
   A deviation needs the owner's written approval in `docs/process/decisions.md`.
9. Never delete data, drop tables, edit `.env` secrets or touch production. Ask first.
10. Never print secrets, passwords or tokens in docs, logs or output.
11. Schema changes, commits and git history: `agent.md` §2a and §4 (step 6).
12. Database, Windows and secrets rules: `agent.md` §6 (port 5500 only, never 3306).

### Communication
13. Every agent ends its run with the STATUS block from its agent file.
14. Disagreement is written, with reasons, in the review section. The manager decides;
    the owner can overrule.

## 5. Bug severity

| Severity | Meaning | Release rule |
|---|---|---|
| S1 Blocker | Data loss, security hole, crash, cannot log in | Must fix before release |
| S2 Major | Feature broken, wrong data shown, permission wrong | Must fix before release |
| S3 Minor | Works with a workaround, confusing message | Owner decides |
| S4 Cosmetic | Layout, wording | Backlog |

## 6. Self-improvement (how agents get better without breaking things)

- After every requirement (phase 11), each agent appends dated, concrete lessons to
  `docs/process/lessons/<role>.md` (what went wrong, the rule that would have
  prevented it). Each agent reads its own lessons file first in every run.
- Changes to agent files, this workflow or the coding standards are **proposed** in
  `11-retro.md` and applied **only after the owner approves**. No agent edits its own
  or another agent's definition.
- A lesson that contradicts the coding standards is invalid; standards win.

## 7. Stop conditions (any agent, any phase)

Stop, write why, and hand back to the facilitator when:
- a needed file is outside your allowed paths,
- the BRD is ambiguous or contradicts the code,
- a suite fails for a reason you did not cause,
- anything would change real data, secrets, git history or production,
- you are about to state something you have not verified.
