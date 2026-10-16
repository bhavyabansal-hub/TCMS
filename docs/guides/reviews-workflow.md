# Pages — the Review workflow (queue → detail → verdicts)

> Files: `views/reviews.tsx` (253), `views/review-detail.tsx` (347),
> `views/module-review-detail.tsx` (415). Together they implement the quality gate of
> the whole system. Read the state machine first — the three screens are just its UI.

---

## 1. The review state machine (server-enforced)

### Single test-case review

```
 submit-review                    verdict
┌────────────┐  PUT ?action=   ┌──────────┐ approved ─────▶ ReviewRequest: completed
│ TestCase   │  submit-review  │ReviewReq │                 TestCase: approved
│ draft or   │────────────────▶│ pending  │ failed ───────▶ ReviewRequest: completed
│ needs_     │  cycle = max+1  │          │                 TestCase: needs_revision
│ revision   │                 │          │ needs_revision ▶ ReviewRequest: in_progress
└────────────┘                 └──────────┘                 TestCase: needs_revision
                                    ▲   │ resubmit (author edits + submit-review
                                    └───┘  again → next cycle; version keeps rising)
```

Key invariants:
- Submitting is only possible from `draft`/`needs_revision`: the UI hides the button and
  the API answers 400 for a case that is `in_review` or `approved`.
- A case has **one open review at a time**: a resubmit (single case or module submit)
  closes the case's old open review in the same transaction.
- **Verdicts may only be recorded by the assigned reviewer** (no VP bypass) —
  `perform_review` permission + ownership check.
- `needs_revision` keeps the ReviewRequest open (`in_progress`) so the same request
  carries the rework conversation; the **cycle** counter increments per resubmission.
- A verdict always notifies the **author** (a bulk module verdict sends one notification
  per person, even when the author is also the requester); comments are mandatory unless `approved`;
  flagged fields are structured labels chosen from a fixed list.

### Module (bulk) review

```
submit-review on module ─▶ ModuleReviewRequest(pending, cycle N)
                            └─▶ ReviewRequest per eligible case (same cycle,
                                moduleReviewId set) — all cases → in_review
first child verdict ─────▶ parent → in_progress
ALL children completed ──▶ parent → completed (+ notify requester)
"Approve All" ───────────▶ every pending child → approved event,
                            case → approved, parent → completed (one shot)
```

---

## 2. Reviews queue (`'reviews'`) — the reviewer's home

### Tabs
| Tab | Data | Who sees it |
|---|---|---|
| **Module Reviews** (default) | `['module-reviews','queue']` — mine, open | everyone |
| **Single Test Cases** | `['reviews','queue']` **filtered to `!r.moduleReviewId`** (children of module reviews are handled on their parent's page) | everyone |
| **All Reviews** | `['reviews','all']` (pageSize 100) + `['module-reviews','all']`, `enabled: tab==='all'` | **`perform_review` holders only** — the tab isn't rendered otherwise; the API also enforces 403 |

Both queue queries poll every 30 s and are the same keys the **sidebar badge** uses —
one fetch feeds two UIs (badge count = standalone queue length + module queue length).

### Cards
- **ModuleReviewCard** (green left border): module name, `Module review · Cycle N`,
  status badge, case-count badge, requester, due date with **overdue detection** (red
  + `AlertCircle` when `due < now && status !== 'completed'`).
- **ReviewCard**: case title + module, status/priority badges, `Cycle N`, requester,
  same due/overdue logic.
- Click → `navigate('module-review-detail' | 'review-detail', { id })`.

Empty states: *"No pending module reviews / You're all caught up!"*, *"No individual
test-case reviews pending"*. Loading: `StateLoadingCards`.

---

## 3. Review detail (`'review-detail'`) — judge one case

Opened with `params.id`. One query: `['reviews','detail',id]` → `GET /api/reviews?id=`
which embeds the full serialized test case + events.

### Who can act
```
canDecide  = can('perform_review') && review.reviewerId === user.userId
canAct     = canDecide && review.status !== 'completed'
canForward = can('perform_review') && review.status !== 'completed'
```
Non-reviewers (and everyone after completion) see the same page read-only — content
plus history, but no verdict buttons.

### Layout
Header: case title, Cycle / review-status / priority badges, submitted-by and reviewer
avatars, due date. Body: read-only Description / Preconditions / **Steps table** /
Expected Result. Below: **Review History** — every ReviewEvent with verdict-colored
left border, reviewer, `timeAgo`, comment, and `flaggedFields` chips (guarded by
`Array.isArray`). Buttons: **"View Test Case"** → `test-case-detail {id}`, **"Back to
Reviews"**.

### VerdictDialog
Opened by three buttons: **Approve** (green) / **Fail** (red) / **Needs Revision**
(outline). Dialog title adapts (`Approve Test Case` / `Fail Test Case` /
`Request Revision`).

| Field | Rules |
|---|---|
| **Flagged Issues** checkbox grid | rendered **only when verdict ≠ approved**; fixed options: `Steps unclear, Wrong expected result, Missing preconditions, Missing tags, Incomplete description, Ambiguous title` |
| Comment textarea | **required unless approved** (client blocks submit + toast) |

Submit → `reviewsApi.verdict(id, { verdict, comment, flaggedFields })` →
`POST /api/reviews?id=` → server does the full state-machine step (event + statuses +
module aggregation + notifications, see `docs/architecture/api-reference.md` §7). Client toasts
`Verdict submitted: needs revision`, invalidates `['reviews']` + `['test-cases']`,
navigates back to the queue.

---

## 4. Module review detail (`'module-review-detail'`) — the bulk workspace

Opened with `params.id`. One query: `['module-reviews','detail',id]` — the payload
embeds every child case review **with its full test case** (this is the one screen
where a reviewer can do everything without leaving the page).

### Header stats (derived client-side)
`Total Cases` (slate) · `Approved` (emerald — children with an `approved` event) ·
`Needs Attention` (amber — `failed`/`needs_revision`), plus pending count.

### Actions
| Control | Behaviour |
|---|---|
| **Approve All ({pendingCount})** | visible only to `canAct` users when pending > 0. Dialog explains consequences ("each test case will move to 'approved' status and the module review will be marked completed"), optional comment (placeholder *Bulk approved with module review.*). `POST /api/module-reviews?id=…&action=approve-all` → toast `Approved {N} test case(s)`; invalidates detail + `['test-cases']` + `['reviews']` |
| Case row chevron | expands an inline panel: read-only Description / Preconditions / **Steps as ordered list** (action → expected) / Expected Result + per-case review history |
| Per-case **Approve** | immediate `reviewsApi.verdict(cr.id, { verdict: 'approved' })` — no dialog needed; toast `Test case approved`; invalidate detail + test-cases. (Server aggregation may complete the parent — surfaced on refetch) |
| Per-case **Fail** / **Needs Revision** | `window.prompt` for the comment (required; toast error if empty) → verdict `failed` / `needs_revision`. *Quirk: prompt-based, unlike the rich dialog on review-detail.* |

Permissions mirror review-detail exactly (`can('perform_review') && reviewerId === me`, and the parent
must not be `completed`). After the last pending child is resolved anywhere, the
parent flips to `completed` server-side; the header then renders fully read-only.

### Why the two-level design exists
A module review is *one reviewer, one due date, one conversation* for up to dozens of
cases: the umbrella row carries the deadline/cycle, the children carry the per-case
verdicts, and aggregation (automatic completion + requester notification) removes the
need to manually close anything. The All-Reviews tab (`docs/guides/reviews-workflow.md` §2) lets leads audit both
levels afterwards.
