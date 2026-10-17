# TCMS agent team — how to use it

The team is already in the repo: `.claude/agents/` (6 roles) and `.claude/commands/`.

1. Open Claude Code in `C:\dev\tcms` and type `/agents` — you should see 6 agents.
2. **Any normal job** (fix, change, cleanup, performance): just ask, or use
   `/quick-fix <what>` — one developer does the work, sdet runs the Definition of Done, done.
3. **A bug:** `/fix-bug <BUG id or description>`.
4. **A new feature with the full 6-agent process:** `/new-requirement <what you want>`;
   after you write "APPROVED": `/build-requirement REQ-<NNN>`; after release: `/retro REQ-<NNN>`.

Every job follows the WORKING METHOD in `CLAUDE.md` and the rules in `docs/CODING-STANDARDS.md`.
The team waits for you only before deleting data, a schema change, or a push.
