# HTTP API and client protocol

The browser uses JSON actions and one server-sent event stream per player.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness, client protocol compatibility, and the commit being served. |
| `GET` | `/api/health/update` | Deployment gate; returns `409` while a game is outside its lobby. |
| `POST` | `/api/rooms` | Create a room and return `{code}`. |
| `GET` | `/api/rooms/:code` | Return `{exists}`. |
| `POST` | `/api/rooms/:code/join` | Send `{name, playerId?}` and receive `{playerId}`. |
| `GET` | `/api/rooms/:code/events?playerId=` | Open an SSE stream of filtered views. |
| `POST` | `/api/rooms/:code/action` | Send `{type, playerId, …}`. |

`POST /api/rooms` accepts `{game}`. The shared `setGame` action changes the
game while a room is in its lobby.

Shared actions are `leave` and `setGame`.

Avalon actions are `options`, `start`, `confirm`, `propose`, `vote`, `card`,
`assassinate`, and `again`.

One Night Ultimate Werewolf actions are `options`, `start`, `night`,
`startVote`, `vote`, and `again`.

Errors use this shape:

```json
{"error": "<translation-key>", "params": {}}
```

The server sends a translation key rather than a sentence so each browser can
show the error in its selected language.

## Protocol compatibility

The current client protocol is `1`. `/api/health` reports it, and the optional
GitHub Pages client checks it before opening a lobby. This makes independently
deployed incompatible clients and servers fail with a clear error.

The `commit` field reports the checkout this process started from, or `null`
when the source is not a git checkout. A deployment pipeline compares it with
the commit it published to confirm the server actually restarted.

The `stateVersion` field reports the snapshot compatibility version. An
updater may restart during a live game only when the running and target
versions are both known and equal.

## Update gate

Automatic deployment systems should use `/api/health` for ordinary liveness
and compare its `stateVersion` with the target code. Known-equal versions can
restart directly because the snapshot is compatible. If either version is
unknown or they differ, call `/api/health/update` before replacing the process.
A `409` response means at least one game has started and that incompatible
deployment should be retried later. Rooms still in the lobby never block an
update. A finished game blocks only while its result is fresh: three minutes
after the last interaction, the results screen stops holding up a deployment.
