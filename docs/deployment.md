# Deployment

`npm start` compiles the browser client, then runs the native server source for
checkout development. Production releases contain both emitted runtime
outputs, so the host installs nothing and runs no compiler. Production adds an
immutable-release updater and, optionally, a GitHub Pages client.

## Runtime state

Rooms live in memory and are atomically snapshotted to a private state
directory. A clean restart restores rooms and timers only when `STATE_VERSION`
is compatible and the complete snapshot validates; otherwise it starts empty.
The persistence contract is implemented in
[`src/server/persistence.ts`](../src/server/persistence.ts) and
[`src/contracts/state-version.ts`](../src/contracts/state-version.ts).

Use `/api/health` for liveness and exact-version checks. SSE proxies must not
buffer `/api/rooms/*/events`. Server configuration defaults and optional avatar
settings live in [`src/server/main.ts`](../src/server/main.ts),
[`src/server/persistence.ts`](../src/server/persistence.ts), and
[`src/server/avatars.ts`](../src/server/avatars.ts).
The admin console's **Player UI theme** controls the appearance for both
self-hosted and Pages clients. Appearance is saved separately beside the room
snapshot and survives releases and restarts; path configuration and storage
behavior live in [`src/server/main.ts`](../src/server/main.ts) and
[`src/server/ui-settings.ts`](../src/server/ui-settings.ts).

## Host control plane

The running application and deployment authority are separate:

```text
~/.local/lib/avalon/          releases the updater downloads
├── current -> releases/<commit>
├── releases/<commit>/
└── rollback/<target-commit>/

~/avalon/                     a trusted clone on main: the control plane
├── deploy/                   updater.sh, verify-pointer.mjs, listen.mjs, start.mjs
└── homelab/tasks/            the server, listener and updater, as tasks
```

On the game host, the [homelab](https://github.com/shengjiex98/homelab) stack
runs the three tasks in [`homelab/tasks/`](../homelab/tasks/) from this clone:
the server, the trigger listener, and an hourly updater. Their manifests set
every path, socket and unit name below. Homelab's app list does not
auto-update this clone, so a change under `deploy/` or `homelab/` goes live
only when someone pulls the clone on the host and runs `./homelab apply` in the
homelab checkout. Application releases never execute or overwrite this code.

On a new host, run the updater once (`./homelab tasks run avalon-update`)
before the server starts, so a release is selected.

### Running by hand

Nothing above is required. Each piece takes its settings from the environment:

| Piece | Command | Settings |
|---|---|---|
| Server | `node ~/avalon/deploy/start.mjs`, from the release directory | `PORT` and `HOST`, or `LISTEN_SOCKET`; `AVALON_STATE_FILE` (default `$XDG_STATE_HOME/avalon/rooms.json`); `ALLOW_ORIGIN`; `ADMIN_USERS`, `ADMIN_SOCKET`; `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` |
| Updater | `deploy/updater.sh reconcile` | `AVALON_UNIT` (default `avalon`), `AVALON_ENV_FILE` (default `~/.config/avalon.env`), `AVALON_RELEASE_ROOT`, `AVALON_STATE_FILE`, `LISTEN_SOCKET` or `PORT`, `NTFY_SERVER`, `NTFY_TOPIC` |
| Listener | `node deploy/listen.mjs` | `NTFY_SERVER`, `NTFY_TOPIC`, `AVALON_UPDATE_UNIT` (default `avalon-update.service`) |

The updater stops and starts the server's systemd unit around a switch, so a
hand-run server needs a unit of its own with that name.

Production requires Node 24. Host configuration and secrets live outside the
repository: on the game host homelab supplies them to the tasks, and run by
hand they come from the environment or `AVALON_ENV_FILE`. Consult
[`deploy/updater.sh`](../deploy/updater.sh) for accepted values.

Setting `ADMIN_USERS` to a comma-separated list of Tailscale logins enables
the admin listener. It uses a private Unix socket beside the room snapshot
unless `ADMIN_SOCKET` selects another path. Put a Tailscale Serve proxy in
front of that socket; do not expose it through the public listener. The
authentication and response rules are implemented in
[`src/server/admin.ts`](../src/server/admin.ts).

## Release flow

```text
push main
  -> install and build both runtime outputs once
  -> stage and test one immutable archive and one Pages tree
  -> publish archive, then latest.json
  -> send an untrusted "deploy" wake-up
  -> installed updater reconciles the host
  -> prove the exact server commit
  -> publish the Pages client
```

The archive contains only `release.json`, the bundled Node entry, and the
emitted self-hosted client. `latest.json` selects a commit and supplies the
archive's SHA-256 digest. Publishing the archive before the pointer prevents
selection of missing bytes. The host compares its download with the digest of
the exact file CI published; it never rebuilds the archive. The Pages job
downloads the client artifact already tested beside that archive and performs
no install, compilation, configuration, or stamping.

A published run then prunes every asset except `latest.json` and the archive it
names. Nothing else is reachable.

Packaging uses ordinary `tar`, writes a partial archive, reads it back, and
only then publishes it under its final name.

The workflow definition is authoritative for publication and ordering:
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml). Packaging and
manifest rules live in [`scripts/package-release.sh`](../scripts/package-release.sh),
[`scripts/stage-browser-artifacts.mjs`](../scripts/stage-browser-artifacts.mjs),
[`scripts/write-release-manifest.mjs`](../scripts/write-release-manifest.mjs),
[`scripts/verify-packaged-release.mjs`](../scripts/verify-packaged-release.mjs),
and [`scripts/test-packaged-release.mjs`](../scripts/test-packaged-release.mjs).

## Reconciliation and rollback

The installed listener treats inbound ntfy messages only as a wake-up and
starts the generic update service. The updater publishes best-effort status
messages for the operator watching the same topic; CI continues to prove
success through the public health endpoint. The updater validates the pointer,
archive, manifest, and rollback release before it stops Avalon. It deploys
through an active game only when both state and API compatibility match;
otherwise the server's update gate may defer it with exit 75. A failed
exact-commit health check restores the previous release and snapshot.

The transaction, safety decisions, retention policy, supported overrides, and
operator force option are defined in [`deploy/updater.sh`](../deploy/updater.sh)
and covered by [`test/updater.test.js`](../test/updater.test.js). Application
releases contain no deployment scripts; candidate code is never used to make a
safety decision.

## Public access

Expose only the application through an HTTPS reverse proxy, Tailscale Funnel,
or an equivalent tunnel. Deployment uses outbound GitHub and ntfy connections
and needs no public inbound control endpoint.

The optional [public Pages client](https://shengjiex98.github.io/avalon/) uses
the repository `API_BASE` variable. Its server-before-client ordering and
generated configuration are defined in the deployment workflow.

The checkout at `~/avalon` is not live. It is an ordinary clone used for
development and as the trusted source for manually installing control-plane
changes.
