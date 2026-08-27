# Claude Code notes

[AGENTS.md](AGENTS.md) carries the working rules for this repository — the
deployment checkout, verification, and the constraints to know before writing
code. Read it first; everything there applies here. This file adds only what is
specific to Claude Code.

## Merging

Open a PR and merge it. Do not stall on whether a game is in progress, and do
not ask the user to pick a safe moment: `deploy/gate.sh` decides whether the
running process may be replaced, the controller asks it before selecting a
release, and a refusal exits 75 for the hourly retry. A commit whose tests fail
never becomes visible, and a release that fails its health check is rolled
back. Low friction is the intended design, not a corner being cut.

If the session is in a worktree, `gh pr merge --delete-branch` can end in
`fatal: 'main' is already checked out at ...` -- gh tries to switch some other
checkout back to `main`. The merge itself has already gone through: confirm
with `gh pr view <n> --json state` rather than retrying, and drop the remote
branch with `gh api -X DELETE repos/<owner>/<repo>/git/refs/heads/<branch>`.

## Deployment changes

`deploy/` ships inside the release, so a change there deploys itself through
CI, the host test run, and the health gate like any other change. The one
exception is `deploy/bootstrap.sh`, which is installed on the host: it needs
`deploy/install-bootstrap.sh` run from a clone, and until then a deployment
warns about the drift.
