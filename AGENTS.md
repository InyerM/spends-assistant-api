# Repository instructions for coding agents

Read `CLAUDE.md` and `docs/standards.md` before editing this repository. Treat their backend architecture, security, and validation rules as applicable to every coding agent. Read `docs/usage/token-usage-agent-prompt.md` before assigning models or delegating work.

If delegation is requested, use GPT agents only.

Write all code, comments, documentation, and commit messages in English. Never commit private exports, receipts, statements, credentials, or untracked personal files. Use focused failing tests before behavior changes, then run the relevant tests, typecheck, and lint. Keep document intake and review separate from financial posting; owner-scoped SQL functions are the authority for audited review state.

The web release comes before corresponding mobile implementation. Preserve completed worktree branches and remove clean, unused finished worktrees when safe.
