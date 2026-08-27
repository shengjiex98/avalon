# Working in this repository

See [README.md](README.md) for what the project is, [docs/architecture.md](docs/architecture.md)
for how it fits together, and [docs/deployment.md](docs/deployment.md) for how it ships.

## The checkout on the game server is not the live deployment

No running service or deployment controller reads `~/avalon`. The application
runs from an immutable release under `~/.local/lib/avalon`, and the versioned
controller, listener, and systemd units live under
`~/.local/libexec/avalon-deploy`. The checkout is retained only as an audited
recovery and administration clone.

So on that host, never edit files in `~/avalon` directly. Use a worktree:

```bash
git worktree add ~/avalon-dev -b some-feature
```

One clone, one object store, shared history, and a directory isolated from the
recovery checkout. Git also refuses to check out a branch that is already
active in another worktree, so repository administration cannot be
accidentally coupled to a feature branch.

Anywhere other than the server host, an ordinary clone is fine.

## Verification

```bash
npm test
```

That is the whole gate — `node --test` over `test/**/*.test.js`, and CI runs
exactly the same command. Tests are fast; run them after each change rather than
once at the end.

## Constraints worth knowing before you write code

**The project has no dependencies, deliberately.** `package.json` lists none,
the server is Node standard library only, and the browser client is plain ES
modules with no build step. Adding a dependency is a design decision, not an
implementation detail — raise it rather than assuming it.

**Room state is memory-first and snapshotted.** The server saves rooms to a
versioned JSON snapshot and restores them, timers included, when
`STATE_VERSION` is unchanged. A missing, corrupt, or differently versioned
snapshot starts empty and ends any game that was in progress. Before a manual
restart involving changed code, inspect both activity and the running version:

```bash
curl -s localhost:8420/api/health | jq '{activeGames, stateVersion}'
```

**The browser and server negotiate on `API_PROTOCOL`.** It is declared in both
`src/server.js` and `public/app.js` and the two must agree. Deployments now land
during live games, so compatibility applies to in-flight state, views, and
actions, not only lobbies. Renaming or re-typing persisted game state bumps
`STATE_VERSION`; changing a view or action so an old client cannot handle it
bumps `API_PROTOCOL`. Within either version, changes stay backward compatible.

**Pushing to `main` deploys.** There is no separate release step. A merge
reaches the live server in seconds, so `main` is expected to be deployable at
all times.

**Merge without waiting for a quiet moment.** The protection is server-side and
automatic, so do not check `activeGames` before merging or hold a merge until a
game ends. `deploy/gate.sh` decides whether the running process may be replaced,
and the release controller asks it *before* selecting a release. When running
and target `STATE_VERSION` values match the restart is lossless and happens
immediately, live rooms and all. Otherwise a game in progress exits 75,
publishes `busy`, and leaves the deployment exactly where it was for the hourly
retry. The controller tests the target before selection and rolls back code and
snapshot if the new process fails its health check; a host that is not on Node
v24 is refused before anything moves. Open the PR, merge it, and let the host
sort out the timing.
