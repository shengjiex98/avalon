# Claude Code notes

Read [AGENTS.md](AGENTS.md) first — verification, the compatibility numbers,
merging, and the deployment checkout all apply here. This file adds only what is
specific to Claude Code.

Claude Code creates worktrees under `.claude/worktrees/`, which is where the
`gh pr merge --delete-branch` failure described in AGENTS.md's merging section
turns up. It reports a stale checkout, not a failed merge — verify the PR state
rather than retrying the merge.
