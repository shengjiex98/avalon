# Working in this repository

[README.md](README.md) is what the project is. The maintained reference lives
in [docs/](docs/README.md) — [architecture](docs/architecture.md) for how it
fits together, [deployment](docs/deployment.md) for how it ships,
[testing](docs/testing.md) for what the suite covers. This file carries only
what changes how you work.

## Verification

```bash
npm test
```

That is the whole gate. The suite is fast and needs no network or browser, so
run it after each change rather than once at the end. CI runs the same tests
from the extracted release archive on Node 24.

## Documentation

Docs carry the core idea and nothing else. Where a detail matters, name the file
that holds it and let the code be authoritative. Restating flags, ordering, or
retention rules in prose creates a second copy that goes stale silently and
gives the reader two answers. [`docs/deployment.md`](docs/deployment.md)
pointing at [`deploy/updater.sh`](deploy/updater.sh) for the safety decisions is
the shape to copy. Comments follow the same rule: say why, not what.

## Constraints worth knowing before you write code

**No dependencies, deliberately.** `package.json` declares none, the server is
Node standard library only, and the browser client is plain ES modules with no
build step. Adding a dependency is a design decision, not an implementation
detail — raise it rather than assuming it.

**Two compatibility numbers gate deployment.** `STATE_VERSION`
(`src/state-version.js`) covers persisted room state; `API_PROTOCOL`
(`src/api-protocol.js` and `public/app.js`, which must agree) covers views and
actions. Renaming or re-typing persisted state bumps the first. Changing a view
or action so an old client cannot handle it bumps the second. Within either
version, stay backward compatible — releases land during live games, not just
lobbies.

**Room state is memory-first and snapshotted.** Rooms are restored with their
timers when `STATE_VERSION` matches. A missing, corrupt, or differently
versioned snapshot starts empty and ends any game in progress. Before a manual
restart on changed code, check activity and the running version at
`/api/health`.

**`main` deploys.** There is no separate release step, so `main` is expected to
be deployable at all times.

## Merging

Open a PR and merge it. Do not inspect `activeGames` first, do not hold a merge
until a game ends, and do not ask the user to pick a safe moment — the host
decides the timing. The installed updater defers an incompatible release while
a game is active and retries later, a commit whose tests fail never publishes,
and a release that fails exact-commit health is rolled back. The safety
decisions themselves live in [`deploy/updater.sh`](deploy/updater.sh) and are
covered by [`test/updater.test.js`](test/updater.test.js); see
[Reconciliation and rollback](docs/deployment.md#reconciliation-and-rollback)
for the shape of it. Low friction is the intended design, not a corner being
cut.

`gh pr merge --delete-branch` run from a worktree can end in `fatal: 'main' is
already checked out at ...`, because gh tries to switch another checkout back
to `main`. The merge itself already succeeded: confirm with
`gh pr view <n> --json state` rather than retrying, then drop the remote branch
with `gh api -X DELETE repos/<owner>/<repo>/git/refs/heads/<branch>`.

## The checkout on the game server is not the live deployment

No running service reads `~/avalon`. The application runs from an immutable
release chosen by a symlink, and the deployment control plane is installed
outside every checkout — see
[Static host control plane](docs/deployment.md#static-host-control-plane). So
`~/avalon` is an ordinary development clone with no special status: nothing
resets it, and editing it directly is fine. A worktree is still convenient when
a branch deserves its own directory.

Changes under `deploy/` do not install themselves. They go through CI and the
normal release rollout like any other change, but a human must then run
`deploy/install-updater.sh` from the host clone and reload systemd. Application
releases never execute or overwrite deployment code.
