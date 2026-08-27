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

Install the deployment bootstrap and the service units outside the checkout:

```bash
~/avalon/deploy/install-bootstrap.sh
systemctl --user daemon-reload
systemctl --user enable --now avalon
loginctl enable-linger "$USER"
```

On a host with no release yet, let a deployment create one before enabling the
services that run from it:

```bash
~/avalon/deploy/install-bootstrap.sh
systemctl --user daemon-reload
systemctl --user enable --now avalon-update.timer
systemctl --user start avalon-update.service     # creates the first release
systemctl --user enable --now avalon avalon-listen
```

The listener's working directory is the selected release, so it needs
`~/.local/lib/avalon/current` to exist first.

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

### Two layers, split by what changes

The control plane is split by mutability rather than by subject. One static
script is installed on the host; everything else rides in the release it
deploys.

`deploy/bootstrap.sh` is the static layer, installed once at
`~/.local/libexec/avalon-deploy/bootstrap.sh` by `deploy/install-bootstrap.sh`
and expected never to change. Both update units call it. It takes an exclusive
lock so a trigger and the hourly timer cannot deploy at once, resolves `main`
through GitHub's HTTPS API, downloads that commit's `avalon-<sha>.tar.gz` and
checksum, verifies the checksum, extracts the archive to a temporary directory,
and runs the controller it finds there. Nothing downloaded runs before its
checksum verifies. The controller is invoked through an explicit environment
allowlist, so host values such as `TARGET_STATE_VERSION` and `AVALON_FORCE`
cannot answer the safety gate on the deployment's behalf.

`deploy/controller.sh`, `gate.sh`, `lib.sh`, `listen.mjs`, `verify-release.mjs`,
`wait-for-health.mjs`, and the five unit files are the versioned layer. They
ship inside the artifact, because `scripts/package-release.sh` archives every
tracked file. A change to deployment logic therefore goes through the same CI,
the same test run, and the same health-gated rollout as a change to the game:
no version file, no install step on the host, nothing that can drift from the
repository.

The candidate commit's own controller performs its deployment, rollback
included. CI runs the deploy tests from the exact artifact before publishing
it, and a controller that is broken anyway strands *deployments*, never the
running server -- the next fix commit heals it through the same bootstrap.

`controller.sh prepare <sha>` downloads the archive and checksum again into
`~/.local/lib/avalon/releases/.staging-*`, verifies checksum and manifest,
reruns the host test suite from the extracted tree, and makes
`~/.local/lib/avalon/releases/<sha>` read-only. The second download keeps that
directory holding only bytes this host verified, tested, and sealed itself.
Application files never come from the source checkout.

`avalon.service` runs the release selected by the atomic
`~/.local/lib/avalon/current` symlink. `controller.sh deploy <sha>` prepares and
tests the candidate, asks the state-version gate, and once allowed copies the
target release's unit files into `~/.config/systemd/user`, reloads systemd,
stops the old process so its final room snapshot is complete, backs that
snapshot up, switches `current`, starts Avalon, and requires the target commit
from `/api/health`. Failed health verification restores the previous release's
pointer, snapshot, and unit files, and proves the rollback commit is serving.
A successful deployment also restarts `avalon-listen`, so the listener runs the
release it just installed.

The one file a release cannot replace is the bootstrap that is executing it. The
controller compares the installed copy with the one in the release and warns --
in the journal and on the ntfy topic -- when they differ; installing the new one
is a human running `deploy/install-bootstrap.sh` from a clone.

`.github/workflows/deploy.yml` runs on every push to `main` as four ordered
jobs: `test`, `publish-artifact`, `deploy-server`, then `deploy-pages`. The test
job packages first and runs the full suite from the extracted tarball; the next
job promotes those exact bytes to durable release assets before the host is
notified. A client newer than its server fails the protocol check and closes
the lobby, so the server takes each commit first and the client is published
only if it did. The workflow and production host both use Node 24, so the test
gate exercises the runtime family the server will actually execute.

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
learns the topic can do is make the controller compare a supplied SHA with
GitHub's current `main`.

`deploy/listen.mjs` holds the subscription, started by `avalon-listen.service`
from the selected release. It never interprets a message: a body must match
`deploy <40 hex>` exactly, and the only thing a match does is start
`avalon-update@<sha>.service`. The bootstrap independently requires that SHA to
equal GitHub's current `main`; an old or forged trigger is ignored.
Reconnection is `Restart=always`.

The release controller publishes what happened, each message carrying
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
tests a read-only candidate without changing the running release. It reads
`STATE_VERSION` from the verified manifest, asks the
gate, then performs the stop, snapshot backup, atomic pointer switch, start,
and health proof described above. A candidate never becomes visible before it
passes host tests, and a failed start restores the previous code and snapshot.

### Repository configuration

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `NTFY_TOPIC` | The deployment topic. On a public server the name is the only thing gating access, so treat it as a secret |
| Variable | `API_BASE` | The server's public base URL, used both as the Pages client's default backend and as the deployment's proof of success |

This host needs the same `NTFY_TOPIC` (and optionally `NTFY_SERVER`) in
`~/.config/avalon.env`, next to `PORT`:

```bash
~/avalon/deploy/install-bootstrap.sh
systemctl --user daemon-reload
systemctl --user enable --now avalon-listen
```

Because `API_BASE` doubles as the health URL, the server has to be reachable
from the internet for CI to confirm a deployment. That is already true here via
`tailscale funnel`; a tailnet-only server would need a different proof.

### Developing on the server host

Nothing on the host reads `~/avalon`. The application runs from an immutable
release under `~/.local/lib/avalon`, and the only installed piece of the
control plane is `~/.local/libexec/avalon-deploy/bootstrap.sh`, which a human
puts there from a clone. So `~/avalon` is an ordinary development clone with no
special status: work in it directly, or give a branch its own directory with
`git worktree add ~/avalon-dev -b some-feature`, whichever suits the change.

Its one remaining job is being somewhere to run `deploy/install-bootstrap.sh`
from when the bootstrap itself changes, and a deployment says so in the journal
and on the topic when the installed copy has drifted.

### Hourly fallback

A host that was rebooting or offline when the trigger was published never sees
it, and would otherwise stay stale indefinitely. The `avalon-update.timer` unit
runs the same bootstrap hourly to close that gap:

```bash
~/avalon/deploy/install-bootstrap.sh
systemctl --user daemon-reload
systemctl --user enable --now avalon-update.timer
```

The timer treats exit 75 as success, because "a game was running, try later" is
a healthy outcome rather than a failure worth alerting on.
