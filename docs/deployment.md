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

`.github/workflows/deploy.yml` runs on every push to `main` as three ordered
jobs: `test`, then `deploy-server`, then `deploy-pages`. The order is the point.
A client newer than its server fails the protocol check and closes the lobby, so
the server takes each commit first and the client is published only if it did.

CI never connects to this host. The two sides meet on an ntfy topic:

```text
CI  --"deploy <sha>"-->  ntfy topic  -->  avalon-listen  -->  avalon-update
CI  <--"deployed|busy|failed <sha>"--  update.sh
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

`deploy/update.sh` publishes what happened, each message carrying the target
commit so concurrent runs cannot read each other's results:

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

`deploy/gate.sh` is what answers "is a game in progress", by calling
`/api/health/update` on localhost. It knows nothing about how the server is
deployed, so it stays usable if the server later ships as a container image.
`AVALON_FORCE=1` skips it, for when a restart cannot wait.

`deploy/update.sh` reads the running and target `STATE_VERSION` values before it
touches the checkout. Known-equal versions bypass the live-game gate; every
unknown or unequal case fails closed through the gate first. It then
fast-forwards the checkout, checks the Node major version, runs the tests, and
restarts the service. It compares the commit the *running server* reports as
well as the one in the working tree, so a tree moved by anything other than
this script -- a manual pull, or a checkout whose restart failed -- still gets
the process restarted rather than being mistaken for up to date. A server that
is down or reports no commit is left alone, so an unreadable commit cannot turn
the hourly timer into an hourly restart. If the tests fail it restores the
previous commit, so a bad `main` cannot take the server down. The checkout it
manages is deploy-only: it discards local edits without warning.
See [developing on the server host](#developing-on-the-server-host) for how to
work on the same machine anyway.

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

`~/avalon` belongs to the updater. A deployment can land seconds after a commit
reaches `main`, and the hourly timer runs whether or not anyone is watching, so
uncommitted work left there is discarded without warning.

Give development its own directory instead:

```bash
git worktree add ~/avalon-dev -b some-feature
```

One clone, one object store, shared history, and a working tree the updater
never touches. Git also refuses to check out a branch that is already active in
another worktree, which rules out the sharper version of this failure: if the
deployment checkout is sitting on a feature branch when a reset lands, that
branch is moved instead, and the running server ends up serving code from a
commit its own tree no longer points at.

Keep `~/avalon` as the primary worktree -- the systemd units address it by path
-- and create the development one alongside. A second full clone works too, with
stronger isolation and a second remote to keep in step; at this size the
worktree is less to think about.

### Hourly fallback

A host that was rebooting or offline when the trigger was published never sees
it, and would otherwise stay stale indefinitely. The `avalon-update.timer` unit
runs the same script hourly to close that gap:

```bash
systemctl --user link ~/avalon/deploy/avalon-update.service
systemctl --user link ~/avalon/deploy/avalon-update.timer
systemctl --user enable --now avalon-update.timer
```

The timer treats exit 75 as success, because "a game was running, try later" is
a healthy outcome rather than a failure worth alerting on.
