# TCMS agent team — how to install

1. Unzip this into `C:\dev\tcms` (the project folder). It adds `.claude/` and `docs/process/`.
   It does not overwrite any app code, `CLAUDE.md` or `.env`.
2. Restart Claude Code in `C:\dev\tcms`, then type `/agents` — you should see 6 agents.
3. Start a requirement with: `/new-requirement <describe what you want>`
4. After you approve the BRD: `/build-requirement REQ-001`
5. Fix a bug: `/fix-bug BUG-001`   ·   After release: `/retro REQ-001`
