# Claude Code notes

[AGENTS.md](AGENTS.md) carries the working rules for this repository — the
deployment checkout, verification, and the constraints to know before writing
code. Read it first; everything there applies here. This file adds only what is
specific to Claude Code.

## Merging

Open a PR and merge it. Do not stall on whether a game is in progress, and do
not ask the user to pick a safe moment: `deploy/update.sh` gates the deployment
itself, rolls back a commit whose tests fail, and retries hourly, as
[AGENTS.md](AGENTS.md) describes. Low friction is the intended design, not a
corner being cut.

One mechanical snag when the session is in a worktree: `gh pr merge
--delete-branch` ends in `fatal: 'main' is already checked out at ...`, because
gh tries to switch the *deployment* checkout back to `main`. The merge itself
has already gone through at that point — confirm with `gh pr view <n> --json
state` rather than retrying, and drop the remote branch with `gh api -X DELETE
repos/<owner>/<repo>/git/refs/heads/<branch>`.

## Worktrees

On the game server host, `~/avalon` is a live deployment that
`deploy/update.sh` resets to `origin/main` without warning, so work goes in a
worktree rather than in the checkout itself.

Claude Code has this built in: use the **EnterWorktree** tool rather than
running `git worktree add` by hand, and **ExitWorktree** when the work is done.
It creates the worktree, switches the session into it, and offers to remove it
on the way out.

One consequence worth knowing: EnterWorktree places worktrees under
`.claude/worktrees/`, which on the server host is *inside* the deployment
directory. That is safe — `git reset --hard` does not remove untracked
directories — and `.gitignore` keeps them out of the deployment's status. It
does mean a stray `git clean -fd` in `~/avalon` would delete work in progress.
`deploy/update.sh` never cleans, so this only matters if you run it yourself.

For work that should outlive the session, `git worktree add ~/avalon-dev` in a
sibling directory sits outside the deployment entirely and is the better home.
