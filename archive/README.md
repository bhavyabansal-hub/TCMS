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
| `examples/websocket/` (`frontend.tsx`, `server.ts`) | `examples/websocket/` | Template socket.io example; the real realtime service is `mini-services/notifications/`. Not imported anywhere. The now-empty `examples/` folder was removed. |

## Repo cleanup, 2026-10-15 (second pass)

| Item | Original location | Why |
|---|---|---|
| `postgres/scripts/*` (14), `postgres/scripts/migration/schema.pg.prisma`, `schema.prisma.pg-backup` | `scripts/` | PostgreSQL-era scripts and schema copies. **Rollback plan until production go-live — do not delete.** Never run them against MySQL. |
| `postgres/prisma/cleanup-old-tables.sql` | `prisma/` | PG pre-restructure DROP script. |
| `postgres/DEPLOYMENT-GUIDE.md`, `postgres/docs/DEPLOYMENT-GUIDE.md` | repo root, `docs/` | Historical Vercel + Neon/Supabase deployment guide (two versions). Current guide: `DEPLOYMENT.md`. |
| `scripts/*` (45), `scripts/migration/add-status-column.mjs` | `scripts/` | One-off audits, repros, probes, cleanups and round-specific verifiers; no references in `package.json`, `src/`, other scripts or docs. |
| `src/components/views/dashboard.tsx` | same | Classic dashboard; never imported. Live view: `dashboard-v2.tsx`. |
| `src/app/(app)/dashboard-preview/page.tsx` | same | `/dashboard-preview` side-by-side review route; the redesign is live at `/dashboard`. |
| `REFACTORING-REPORT.md` | repo root | Older copy of `docs/REFACTORING-REPORT.md`. |

Deleted in the same pass (still in git history): the 17 screenshot PNGs that were
here, the stray `POST` curl output, `mini-services/.gitkeep`, and the root copies of
`CODE-QUALITY-ROADMAP.md` / `REFACTOR-CHARTER.md` (identical to the `docs/` copies).
