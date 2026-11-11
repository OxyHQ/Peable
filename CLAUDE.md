@AGENTS.md

## Claude Code

- Use plan mode before changing a public route (`packages/contracts`), a migration, or anything in the Boundaries "Ask first" list; state which generated files will change.
- Backend-only and wallet-only rules load by path from `.claude/rules/`; read the linked `docs/agent-rules/` file before editing that area.
- Work in a git worktree when other agents may be editing the repo; do not `git stash`.
