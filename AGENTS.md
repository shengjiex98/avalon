# Working in this repository

See [README.md](README.md) for what the project is, [docs/architecture.md](docs/architecture.md)
for how it fits together, and [docs/deployment.md](docs/deployment.md) for how it ships.

## The checkout on the game server is not the live deployment

No running service reads `~/avalon`. The application runs from an immutable
release under `~/.local/lib/avalon`, selected by a `current` symlink, and the
deployment control plane is installed under
`~/.local/libexec/avalon-deploy/` plus `~/.config/systemd/user/`. The updater,
pointer verifier, listener, and four units are static host files; candidate
releases contain application bytes only as far as the updater is concerned.

So `~/avalon` on that host is an ordinary development clone with no special
status. Nothing resets it, and editing it directly is fine. A worktree
(`git worktree add ~/avalon-dev -b some-feature`) is still convenient when a
branch deserves its own directory, and Git will refuse to check out a branch
that is already active in another worktree.

Changes under `deploy/` do not install themselves. After such a change reaches
the host, a human runs `deploy/install-updater.sh` from the clone and reloads
systemd. Application releases never execute or overwrite candidate deployment
code.

## Verification

```bash
npm test
```

That is the whole gate — `node --test` over `test/**/*.test.js`. CI packages the
release first, validates it with trusted checked-out code, and runs the same
suite from the exact extracted archive. Tests are fast; run them after each
change rather than once at the end.

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
curl -s localhost:8420/api/health
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
game ends. The installed updater requires both the running and target
`STATE_VERSION` and `API_PROTOCOL` to match before restarting through a live
game. Otherwise `/api/health/update` decides whether the table is idle; a `409`
exits 75 without stopping the server or moving `current`, and the listener or
hourly timer retries later. Failed exact-commit health restores the previous
release and snapshot. A host that is not on Node v24 is refused before anything
moves. Open the PR, merge it, and let the host sort out the timing.
