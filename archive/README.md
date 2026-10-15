# archive/ — moved-out files (2026-10-15)

Files here were **moved, not deleted**, during a cleanup pass. Each item had **no
references** in `src/`, `scripts/`, `package.json` or `docs/` at the time of the move.
Paths mirror the original location (`archive/<original path>`), so restoring an item
is a single `mv` back.

`archive/` is excluded from type-checking (`tsconfig.json` → `exclude`) and linting
(`eslint.config.mjs` → `ignores`), so nothing here affects the build or the
Definition of Done.

| Item | Original location | Why it was archived |
|---|---|---|
| `POST` | repo root | Stray file containing only `{"error":"Cross-site request blocked"}`, an accidental curl output (`-o POST`). |
| `examples/websocket/` (`frontend.tsx`, `server.ts`) | `examples/websocket/` | Template socket.io example; the real realtime service is `mini-services/notifications/`. Not imported anywhere. The now-empty `examples/` folder was removed. |
| `scripts/dark-dashboard.png`, `detail-debug.png`, `list-debug.png` | `scripts/` | Debug screenshots left behind by past UI checks. |
| `download/*.png` (14 files) | `download/` | Preview/deploy-audit screenshots from earlier sessions; not part of the app or the canonical zip contract. |

## Not archived (still referenced; left in place on purpose)

- `src/components/views/dashboard.tsx`: mentioned in a comment in
  `src/app/(app)/dashboard/page.tsx` and documented in `docs/06-page-login-and-dashboard.md`.
- `src/app/(app)/dashboard-preview/`: mentioned in comments in
  `src/app/(app)/dashboard/page.tsx` and `src/components/views/dashboard-v2.tsx`.
- `docs/CODE-QUALITY-ROADMAP.md`, `docs/REFACTOR-CHARTER.md`, `docs/CHANGELOG.md`,
  `docs/DEPLOYMENT-GUIDE.md`, `docs/REFACTORING-REPORT.md`: linked from `docs/README.md`
  (and some from docs 15/17 and `docs/CHANGELOG.md`).

To archive those, update the referencing comments and doc links first.
