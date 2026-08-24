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
```

Point a public URL or reverse proxy at that port and share the URL with
players. The server generates `/version.json`; open clients check it once a
minute and offer to reload after a new deployment.

## Important operating behavior

State is stored in memory. Restarting the process ends games in progress, and
rooms idle for six hours are removed. There is no database or state to back up.

Use `/api/health` as the container or service liveness check.

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

The Pages workflow runs the tests, writes `API_BASE` to `public/config.js`,
stamps the JavaScript module graph with the commit SHA, and publishes `public/`.

If maintaining both entry points is no longer useful, follow the
[single-server reversion checklist](single-server.md).
