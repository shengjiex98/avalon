# Deployment

The simplest deployment is one Node process serving both the browser client
and API from the same origin.

```bash
npm start
```

The server reads these environment variables:

```sh
PORT=8420
HOST=0.0.0.0
# Optional override; normally supplied by systemd's StateDirectory.
AVALON_STATE_FILE=/path/to/rooms.json
```

Point a public URL or reverse proxy at that port and share the URL with
players. The server generates `/version.json`; open clients check it once a
minute and offer to reload after a new deployment.

## Important operating behavior

Live state is held in memory and atomically snapshotted to `rooms.json`. The
checked-in systemd unit stores it at `~/.local/state/avalon/rooms.json`; outside
systemd the default is `$XDG_STATE_HOME/avalon/rooms.json` (or
`~/.local/state/avalon/rooms.json`). `AVALON_STATE_FILE` overrides the path.
Rooms idle for six hours are removed.

Keep `/api/health` as the container or service liveness check. It reports both
`activeGames` and `stateVersion`. A restart on code with the same state version
restores live games, including their timers. A missing, corrupt, or differently
versioned snapshot starts empty, so an updater must call `/api/health/update`
before a restart whenever running and target state versions are not known to be
equal. A `409` then means an incompatible update must wait. Lobby rooms do not
block it, and a finished game stops blocking three minutes after the last
interaction.

SSE response buffering must be disabled for `/api/rooms/*/events`. For nginx,
use `proxy_buffering off;`; otherwise clients will not receive room updates
promptly.

What a restart looks like in an open browser: the stream drops, the banner says
the connection was lost, and the client retries with a backoff -- asking
`/api/rooms/:code?playerId=` each time, so it can tell a server that is still
booting from a room the restart did not restore. A restored room reconnects
without anyone touching the page, and a room that is gone says so once and
returns to the home screen rather than promising a reconnection that cannot
happen. Reloading for a new client build keeps the seat: the room code lives in
the URL fragment and in `localStorage`, and only the server saying the seat is
gone gives it up.

## Remote players and HTTPS

Use HTTPS when players connect remotely. Common options are:

| Route | Access | Notes |
| --- | --- | --- |
| `tailscale funnel 8420` | Anyone with the link | Public HTTPS on the host's `*.ts.net` name. |
| `tailscale serve 8420` | Tailnet members | HTTPS limited to the tailnet. |
| Cloudflare Tunnel | Anyone allowed by the tunnel | Configure the tunnel for port 8420. |
| nginx and Let's Encrypt | Anyone allowed by the proxy | Disable proxy buffering for SSE. |

## systemd user service

The checked-in `deploy/avalon.service` keeps the service definition with the
repository:

```bash
systemctl --user link ~/avalon/deploy/avalon.service
systemctl --user daemon-reload
systemctl --user enable --now avalon
loginctl enable-linger "$USER"
```

Put host-specific values in `~/.config/avalon.env`, outside the repository:

```sh
PORT=8420
HOST=0.0.0.0
```

## Optional GitHub Pages client

[The official Pages client](https://shengjiex98.github.io/avalon/) provides a
stable browser-client URL but still needs a reachable HTTPS Node server for
rooms and game state.

Its default server comes from the repository Actions variable `API_BASE`. A
server supplied through a `?server=` room link or saved in the browser takes
priority, and copied room links preserve the active server address. Node
accepts cross-origin requests from this exact Pages origin; other browser
origins are unsupported. A client served by Node always uses its own origin.

The `deploy-pages` job runs after the server has taken the same commit. It
writes `API_BASE` to `public/config.js`, stamps the JavaScript module graph with
the commit SHA, and publishes `public/`.

If maintaining both entry points is no longer useful, follow the
[single-server reversion checklist](single-server.md).

## Continuous deployment

### Release artifact contract

`scripts/package-release.sh` can package any commit as a deterministic,
architecture-neutral `avalon-<sha>.tar.gz` plus a SHA-256 checksum. The archive
contains only tracked files and a generated `release.json` with the commit,
`STATE_VERSION`, `API_PROTOCOL`, required Node major, and deployer schema.

The server reads the commit from that manifest when it is not running from a
Git checkout, so `/api/health.commit` keeps the same deployment-proof contract
for a release directory, tarball, or image.

`deploy/install-controller.sh` installs a separately versioned control plane at
`~/.local/libexec/avalon-deploy/current`. Its `prepare <sha>` operation exports
that exact commit into `~/.local/lib/avalon/releases/<sha>`, validates the
manifest with controller-owned code, runs the host test suite from the staged
tree, and makes the result read-only. The source checkout is never moved.

`avalon.service` runs the release selected by the atomic
`~/.local/lib/avalon/current` symlink. `avalon-update.service` invokes the
external controller, which prepares and tests the candidate before asking the
same state-version gate used by the checkout updater. Once allowed, it stops
the old process so its final room snapshot is complete, backs that snapshot up,
switches `current`, starts Avalon, and requires the target commit from
`/api/health`. Failed health verification restores the previous release pointer
and snapshot and proves the rollback commit is serving.

The source checkout is still fetched in this migration stage, but it is never
reset and the application does not execute or serve files from it. A later step
replaces the locally exported commit with the exact artifact published by CI.

`.github/workflows/deploy.yml` runs on every push to `main` as three ordered
jobs: `test`, then `deploy-server`, then `deploy-pages`. The order is the point.
A client newer than its server fails the protocol check and closes the lobby, so
the server takes each commit first and the client is published only if it did.
The workflow and production host both use Node 24, so the test gate exercises
the runtime family the server will actually execute.

CI never connects to this host. The two sides meet on an ntfy topic:

```text
CI  --"deploy <sha>"-->  ntfy topic  -->  avalon-listen  -->  avalon-update
CI  <--"deployed|busy|failed <sha>"--  release controller
CI  confirms GET $API_BASE/api/health .commit == <sha>
```

The notification only makes the deployment prompt; it is never what convinces
CI that anything happened. A run succeeds when the **server itself** reports the
commit, so the topic can be public without granting anyone the ability to
publish a client against a server that never updated. The worst a stranger who
learns the topic can do is make this host run `git fetch` and find nothing new.

`deploy/listen.mjs` holds the subscription, started by `avalon-listen.service`.
It never interprets a message: a body must match `deploy <40 hex>` exactly, and
the only thing a match does is start `avalon-update.service`. Reconnection is
`Restart=always`.

The external release controller publishes what happened, each message carrying
the target commit so concurrent runs cannot read each other's results:

| Message | Meaning | What CI does |
| --- | --- | --- |
| `deployed <sha>` | Restarted on the new commit | Confirms via health, then publishes the client |
| `busy <sha>` | A state-incompatible update found a game in progress | Logs it and keeps waiting |
| `failed <sha> …` | Update failed and rolled back | Fails the run immediately |

CI re-sends the trigger every five minutes for up to an hour, so a
state-incompatible deployment refused mid-game lands as soon as the table
clears. State-compatible deployments restart immediately and restore the game.
If the hour runs out, the run fails and **nothing** is published, leaving client
and server together on the older commit; re-run it from the Actions tab.

`deploy/gate.sh` answers one question -- *may the running process be replaced
right now?* -- and it is the only place that knows what makes a replacement
safe. It says yes when the running and target `STATE_VERSION` values are both
known and equal, because the snapshot then restores every room, so a game in
progress is no reason to wait. Otherwise the rooms would be lost and it asks
`/api/health/update` on localhost: `409` means a game is in progress and the
gate exits 75. An unknown version on either side is not equal, so it fails
closed through that check.

The target version arrives as `TARGET_STATE_VERSION`, never as a commit:
nothing in the gate knows about git, so an image-based deployment can pass a
label or a build arg and keep using it unchanged. `AVALON_FORCE=1` skips the
question entirely, for when a restart cannot wait. A server that does not
answer within five seconds is treated as down -- nothing to protect.

The release controller is the mechanism around that decision. It prepares and
tests a read-only candidate without changing either the running release or the
source checkout. It reads `STATE_VERSION` from the verified manifest, asks the
gate, then performs the stop, snapshot backup, atomic pointer switch, start,
and health proof described above. A candidate never becomes visible before it
passes host tests, and a failed start restores the previous code and snapshot.
`deploy/update.sh` remains only as the one-time bootstrap path for hosts that
have not installed the external controller yet.

### Repository configuration

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `NTFY_TOPIC` | The deployment topic. On a public server the name is the only thing gating access, so treat it as a secret |
| Variable | `API_BASE` | The server's public base URL, used both as the Pages client's default backend and as the deployment's proof of success |

This host needs the same `NTFY_TOPIC` (and optionally `NTFY_SERVER`) in
`~/.config/avalon.env`, next to `PORT`:

```bash
systemctl --user link ~/avalon/deploy/avalon-listen.service
systemctl --user enable --now avalon-listen
```

Because `API_BASE` doubles as the health URL, the server has to be reachable
from the internet for CI to confirm a deployment. That is already true here via
`tailscale funnel`; a tailnet-only server would need a different proof.

### Developing on the server host

`~/avalon` belongs to the deployment control plane. The external controller
fetches it as a source repository, and the listener and linked unit files are
still addressed there during this migration. The application does not run from
the checkout and the controller does not reset it, but local edits can still
change deployment infrastructure outside review.

Give development its own directory instead:

```bash
git worktree add ~/avalon-dev -b some-feature
```

One clone, one object store, shared history, and a working tree isolated from
the deployment control plane. Git also refuses to check out a branch that is
already active in another worktree, preventing accidental coupling between a
feature branch and the source repository the controller fetches.

Keep `~/avalon` as the primary worktree -- some systemd units still address it
by path -- and create the development one alongside. A second full clone works too, with
stronger isolation and a second remote to keep in step; at this size the
worktree is less to think about.

### Hourly fallback

A host that was rebooting or offline when the trigger was published never sees
it, and would otherwise stay stale indefinitely. The `avalon-update.timer` unit
runs the same external controller hourly to close that gap:

```bash
systemctl --user link ~/avalon/deploy/avalon-update.service
systemctl --user link ~/avalon/deploy/avalon-update.timer
systemctl --user enable --now avalon-update.timer
```

The timer treats exit 75 as success, because "a game was running, try later" is
a healthy outcome rather than a failure worth alerting on.
