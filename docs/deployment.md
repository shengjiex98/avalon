# Deployment

The simplest deployment is one Node process serving both the browser client
and API:

```bash
npm start
```

The server reads:

```sh
PORT=8420
HOST=0.0.0.0
AVALON_STATE_FILE=/path/to/rooms.json
CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef
CLOUDFLARE_API_TOKEN=...
AVALON_AVATAR_GENERATIONS_PER_HOUR=30
AVALON_AVATAR_GENERATIONS_PER_DAY=200
AVALON_AVATAR_MIN_INTERVAL_MS=1000
```

`AVALON_STATE_FILE` is normally supplied by systemd's `StateDirectory`.
Cloudflare credentials are optional and enable background name-based avatars;
never expose the token. Generated names are cached and rate-limited, and joins
never wait on generation.

## Operating behavior

Live state is held in memory and atomically snapshotted to
`~/.local/state/avalon/rooms.json`. A restart restores rooms and timers when
`STATE_VERSION` is compatible. A missing, corrupt, or differently versioned
snapshot starts empty. Uploaded and generated avatars are content-addressed
beside the snapshot and are not copied during deployment rollback.

Keep `/api/health` as the liveness check. It reports `commit`, `activeGames`,
`stateVersion`, and `protocol`. Disable response buffering for
`/api/rooms/*/events`; for nginx, use `proxy_buffering off;`.

An open browser retries after a restart and first checks whether its room and
seat survived. A restored room reconnects without interaction. A missing room
returns to the home screen. Reloading for a new client build keeps the seat
through the room fragment and `localStorage`.

## Remote players and HTTPS

| Route | Access | Notes |
| --- | --- | --- |
| `tailscale funnel 8420` | Anyone with the link | Public HTTPS on the host's `*.ts.net` name |
| `tailscale serve 8420` | Tailnet members | HTTPS limited to the tailnet |
| Cloudflare Tunnel | Configured audience | Point the tunnel at port 8420 |
| nginx and Let's Encrypt | Configured audience | Disable proxy buffering for SSE |

Only the Avalon application belongs behind Funnel. The updater, systemd, and
host shell have no public inbound endpoint.

## Static host control plane

The control plane is installed outside source checkouts and releases:

```text
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

Install or upgrade it from a trusted clone:

```bash
~/avalon/deploy/install-updater.sh
systemctl --user daemon-reload
systemctl --user enable --now avalon-update.timer avalon-listen avalon
loginctl enable-linger "$USER"
```

On a new host with no selected release, reconcile first:

```bash
~/avalon/deploy/install-updater.sh
systemctl --user daemon-reload
systemctl --user start avalon-update.service
systemctl --user enable --now avalon avalon-listen avalon-update.timer
```

The installer is idempotent, atomically replaces each installed file, never
overwrites `~/.config/avalon.env`, and never starts a deployment. Releases do
not upgrade these static files; rerun the installer after a reviewed change
under `deploy/`.

Host values and secrets live outside the repository:

```sh
PORT=8420
HOST=0.0.0.0
NTFY_TOPIC=unguessable-topic-name
NTFY_SERVER=https://ntfy.sh
CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef
CLOUDFLARE_API_TOKEN=...
```

The updater also accepts `AVALON_RELEASE_ROOT`, `AVALON_ARTIFACT_BASE`,
`AVALON_NODE`, `AVALON_SYSTEMCTL`, `AVALON_STATE_FILE`,
`AVALON_HEALTH_TIMEOUT_SECONDS`, `AVALON_KEEP_RELEASES`, and `PORT`.
`updater.sh reconcile --force` is an explicit operator escape hatch; release
metadata, ntfy, and ambient force variables cannot invoke it.

## Optional GitHub Pages client

[The official Pages client](https://shengjiex98.github.io/avalon/) provides a
stable browser URL but still needs a reachable HTTPS Node server. Its default
server is the repository Actions variable `API_BASE`. A `?server=` room link
or saved browser choice takes priority.

`deploy-pages` runs only after the public server reports the exact workflow
commit. It writes `API_BASE` to `public/config.js`, stamps the JavaScript
module graph, and publishes `public/`. Server-before-client ordering preserves
`API_PROTOCOL` compatibility for old browser sessions.

See [the single-server reversion checklist](single-server.md) if the Pages
entry point is no longer useful.

## Release artifact contract

`scripts/package-release.sh` produces one deterministic asset:

```text
avalon-<40-character-commit>.tar.gz
```

There is no standalone checksum file. The archive contains tracked files plus
`release.json` with the commit, `STATE_VERSION`, `API_PROTOCOL`, required Node
major, and deployer schema.

The fixed `deployment-artifacts` GitHub Release also carries the mutable
publication pointer:

```text
https://github.com/shengjiex98/avalon/releases/download/deployment-artifacts/latest.json
```

```json
{
  "schema": 1,
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

The pointer contains no URL or filename. The updater validates the lowercase
commit and digest and derives `avalon-<commit>.tar.gz`.

## GitHub Actions ordering

Every push to `main` runs:

```text
test → publish-artifact → deploy-server → deploy-pages
```

The test job packages first, extracts that exact archive outside the checkout,
validates it with trusted checked-out code, and runs `npm test` from the
extracted tree on Node 24. Candidate deployment scripts are never executed.

The publication job downloads the tested bytes, recomputes SHA-256, and asks
the GitHub API whether `main == GITHUB_SHA`. A superseded run publishes
nothing. It uploads the immutable archive and replaces `latest.json` last;
pointer replacement is the publication commit point. Only this default-branch
job has `contents: write`.

CI then sends the exact body `deploy` to ntfy. The installed listener accepts
no SHA, URL, whitespace variant, or command; it only starts
`avalon-update.service`. The topic is an untrusted wake-up channel. CI reads no
result messages and instead polls `$API_BASE/api/health` until
`health.commit == GITHUB_SHA`, re-waking every five minutes for up to an hour.
Only that proof permits Pages publication.

The hourly `avalon-update.timer` recovers missed wakes and offline hosts. Exit
75 is a healthy incompatible-game deferral.

## Host reconciliation

`updater.sh reconcile`:

1. Loads operator-owned configuration, requires Node 24, and takes a
   nonblocking `flock`.
2. Fetches `latest.json` with no-cache headers, cache busting, retries, and
   timeouts; the installed verifier parses it.
3. Exits without a download when the target is selected and serving.
4. Reuses a valid release or downloads the derived archive, verifies SHA-256
   before extraction, rejects unsafe paths and links, validates the embedded
   manifest and required files, seals the tree read-only, and atomically
   installs `releases/<commit>`.
5. Compares running `(stateVersion, protocol)` with target
   `(stateVersion, apiProtocol)`.
6. Once safe, stops Avalon, copies its final snapshot, atomically replaces
   `current`, starts Avalon, and requires the exact target commit from health.
7. Prunes only after successful activation.

The updater never runs `npm`, lifecycle hooks, candidate verifiers, or
candidate `deploy/` files.

### Compatibility decisions

| Condition | Result |
| --- | --- |
| Target already serving | No-op |
| Server unavailable | Deploy; nothing is running to protect |
| Active games and both versions equal | Deploy and restore them |
| Active games and either version differs or is unknown | Exit 75 without stopping Avalon |
| No active games | Deploy |
| Malformed or unexpected health | Fail closed |

For a nonmatching or unknown tuple, `/api/health/update` returns `409` while a
game is active and `200` when safe. Lobby rooms do not block deployment. A
finished game stops blocking three minutes after its last interaction.

### Activation and rollback

```text
~/.local/lib/avalon/
├── current -> releases/<commit>
├── releases/<commit>/
└── rollback/<target-commit>/
```

The updater validates the rollback release before stopping the service and
copies `rooms.json` only after the old process makes its final write. If the
target misses exact-commit health, it restores the old `current` pointer and
snapshot, restarts the old service, and verifies the rollback commit. A failed
target never remains selected.

Successful activation retains the current and immediate rollback releases plus
`AVALON_KEEP_RELEASES` additional recent releases.

## Repository configuration

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `NTFY_TOPIC` | Wake-up topic shared with the host |
| Variable | `API_BASE` | Public server base URL used by Pages and deployment proof |

`API_BASE` must be reachable from GitHub Actions. Production uses Tailscale
Funnel for the application.

## Server-host checkout

Nothing reads `~/avalon` at runtime. The application comes from the immutable
selected release; the control plane comes from the installed libexec and user
units. The clone is an ordinary development checkout and a trusted place to
run `deploy/install-updater.sh` after static control-plane changes.

## Migration history

The pointer path was introduced without stranding the old bootstrap:

1. Add and install the static updater while preserving legacy publication.
2. Publish `latest.json`, make ntfy wake-only, and verify pointer-driven
   production deployment.
3. Remove host-side `main` resolution, candidate controllers, standalone
   checksums, release-owned units, and the commit-specific update service.

That migration is complete; only the static path above is supported.
