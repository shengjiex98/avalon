# Deployment

`npm start` runs a single Node process that serves both the browser client and
API. Production adds an immutable-release updater and, optionally, a GitHub
Pages client.

## Runtime state

Rooms live in memory and are atomically snapshotted to a private state
directory. A clean restart restores rooms and timers only when `STATE_VERSION`
is compatible and the complete snapshot validates; otherwise it starts empty.
The persistence contract is implemented in
[`src/persistence.js`](../src/persistence.js) and
[`src/state-version.js`](../src/state-version.js).

Use `/api/health` for liveness and exact-version checks. SSE proxies must not
buffer `/api/rooms/*/events`. Server configuration defaults and optional avatar
settings live in [`src/server.js`](../src/server.js),
[`src/persistence.js`](../src/persistence.js), and
[`src/avatars.js`](../src/avatars.js).

## Static host control plane

The running application and deployment authority are separate:

```text
~/.local/lib/avalon/
├── current -> releases/<commit>
├── releases/<commit>/
└── rollback/<target-commit>/

~/.local/libexec/avalon-deploy/
├── updater.sh
├── verify-pointer.mjs
└── listen.mjs

~/.config/systemd/user/
├── avalon.service
├── avalon-listen.service
├── avalon-update.service
└── avalon-update.timer
```

Install or refresh the static files from a trusted clone:

```bash
~/avalon/deploy/install-updater.sh
systemctl --user daemon-reload
systemctl --user enable --now avalon avalon-listen avalon-update.timer
```

On a new host, start `avalon-update.service` once before enabling Avalon so a
release is selected. The installer is idempotent and does not deploy or restart
the application. Changes under [`deploy/`](../deploy/) therefore require this
manual installation step after merge. Exact installed paths and modes are
defined by [`deploy/install-updater.sh`](../deploy/install-updater.sh); service
behavior belongs to the adjacent unit files.

Production requires Node 24. Host configuration and secrets live outside the
repository in `~/.config/avalon.env`; consult the unit files and
[`deploy/updater.sh`](../deploy/updater.sh) for accepted values.

## Release flow

```text
push main
  -> package and test one immutable archive
  -> publish archive, then latest.json
  -> send an untrusted "deploy" wake-up
  -> installed updater reconciles the host
  -> prove the exact server commit
  -> publish the Pages client
```

The archive contains application bytes plus `release.json`. `latest.json`
selects a commit and supplies the archive's SHA-256 digest. Publishing the
archive before the pointer prevents selection of missing bytes.

A published run then prunes every asset except `latest.json` and the archive it
names. Nothing else is reachable.

The archive is reproducible: the same commit packages to the same bytes, which
is what lets the host trust the digest in `latest.json`. That requires GNU tar,
so packaging refuses to start on a BSD tar rather than producing an archive the
host would reject.

The workflow definition is authoritative for publication and ordering:
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml). Packaging and
manifest rules live in [`scripts/package-release.sh`](../scripts/package-release.sh),
[`scripts/write-release-manifest.mjs`](../scripts/write-release-manifest.mjs),
and [`scripts/verify-packaged-release.mjs`](../scripts/verify-packaged-release.mjs).

## Reconciliation and rollback

The installed listener treats ntfy only as a wake-up and starts the generic
update service. The updater validates the pointer, archive, manifest, and
rollback release before it stops Avalon. It deploys through an active game only
when both state and API compatibility match; otherwise the server's update gate
may defer it with exit 75. A failed exact-commit health check restores the
previous release and snapshot.

The transaction, safety decisions, retention policy, supported overrides, and
operator force option are defined in [`deploy/updater.sh`](../deploy/updater.sh)
and covered by [`test/updater.test.js`](../test/updater.test.js). Candidate
release scripts are never executed.

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
