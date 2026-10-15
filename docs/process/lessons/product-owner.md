# Lessons — product-owner

Append lessons below (format in README.md). Read this file at the start of every run.

## 2026-10-15 seed (from the TCMS worklog)
- What happened: "first VP comes from seed" contradicted the production guard that blocks seed (startup-guard-1).
- Rule from now on: check every BRD rule against docs/process/decisions.md and the production guards before approval.

## 2026-10-15 REQ-001 BRD
- What happened: the kickoff recommended porting verify-permission-matrix to the demo users, but its "create task report" probe upserts today's report (task-reports.service.ts:199), so it would overwrite real demo-user data.
- Rule from now on: for every test/suite requirement, read each write the suite makes and check the service semantics (upsert, notifications, hard vs soft delete) before choosing whose accounts it runs as.
- What happened: grepping every navigate() call in a view found 3 more ungated links than the QA report listed.
- Rule from now on: when a bug says "buttons not gated", grep all navigation calls in the file, not only the ones the report names; put the extra ones in an open question rather than in scope.

## 2026-10-15 REQ-001 phase 3 review
- What happened: four reviewers returned 50+ change requests. Several v1 ACs could not be observed: R1.AC2 needed data the viewer can never own, R2.AC6 "no pointer cursor" already passed before the fix, and R3.AC7's log lines carry no user id. v1 also missed the 7th demo account, and its "at least N checks" wording would let a dropped check hide.
- Rule from now on: for every AC, write down which account, which data and which artefact (DOM node, log line, script output) proves it, and confirm the artefact can tell "fixed" from "not fixed". Take account lists from the seed, not from a script. Pin exact check counts.
- What happened: one reviewer's count ("48 ok() calls") included the function definition.
- Rule from now on: when accepting a number, re-derive it from the source and note any difference in the answer.
