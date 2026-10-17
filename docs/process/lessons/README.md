# Lessons (agent self-improvement)

Each role has one file here: `manager.md`, `product-owner.md`, `developer-backend.md`,
`developer-frontend.md`, `tester.md`, `sdet.md`. Every agent reads its own file at the start
of every run and appends lessons at the retrospective.

Format (append only, newest at the bottom):

```
## <YYYY-MM-DD> REQ-<NNN>
- What happened: <fact with evidence path>
- Rule from now on: <one concrete, checkable rule>
```

Rules:
- A lesson must be specific and checkable ("run the build before claiming a page works"),
  never vague ("be more careful").
- A lesson that conflicts with `coding-standards.md` or `WORKFLOW.md` is invalid.
- Changes to agent files themselves go through the retro proposal and owner approval.
