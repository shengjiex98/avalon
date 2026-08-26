# Working in this repository

See [README.md](README.md) for what the project is, [docs/architecture.md](docs/architecture.md)
for how it fits together, and [docs/deployment.md](docs/deployment.md) for how it ships.

## The checkout on the game server is a live deployment

`~/avalon` on the server host is not a development directory. It is what
`deploy/update.sh` manages, and that script runs `git reset --hard origin/main`
whenever a deployment is triggered — within seconds of a commit landing on
`main`, and again every hour as a fallback. It discards uncommitted work without
warning and gives no notice first.

So on that host, never edit files in `~/avalon` directly. Use a worktree:

```bash
git worktree add ~/avalon-dev -b some-feature
```

One clone, one object store, shared history, and a directory the updater will
never touch. Git also refuses to check out a branch that is already active in
another worktree, so the deployment cannot be dragged onto your branch by
accident — which is a real failure mode here, not a hypothetical: a reset that
lands while the deployment checkout sits on a feature branch moves *that*
branch, and the running server ends up serving code from a commit the tree no
longer points at.

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
and `deploy/update.sh` asks it *before* touching the working tree. When running
and target `STATE_VERSION` values match the restart is lossless and happens
immediately, live rooms and all. Otherwise a game in progress exits 75,
publishes `busy`, and leaves the deployment exactly where it was for the hourly
retry. The updater then tests the target and rolls back if the tests fail; a
host that is not on Node v24 is refused before anything moves. Open the PR,
merge it, and let the host sort out the timing.
