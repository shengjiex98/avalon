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

**Room state lives in memory.** Restarting the server ends every game in
progress; there is no database and nothing to recover from. This is why
`deploy/gate.sh` exists and why the deployment refuses to restart while a game
is being played. Before restarting the service by hand, check that nobody is
mid-game:

```bash
curl -s localhost:8420/api/health | jq '.activeGames'
```

**The browser and server negotiate on `API_PROTOCOL`.** It is declared in both
`src/server.js` and `public/app.js` and the two must agree. Bump it only for a
genuine wire-format break; within a version, server changes must stay backward
compatible, because the client and server are deployed as separate steps and
briefly disagree during every release.

**Pushing to `main` deploys.** There is no separate release step. A merge
reaches the live server in seconds, so `main` is expected to be deployable at
all times.
