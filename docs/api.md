# HTTP API and client protocol

The browser uses JSON actions and one server-sent event stream per player.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness and client protocol compatibility. |
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

## Update gate

Automatic deployment systems should use `/api/health` for ordinary liveness
checks and call `/api/health/update` immediately before replacing the process.
A `409` response means at least one game has started and deployment should be
retried later. Rooms that are still in the lobby do not block an update.
