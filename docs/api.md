# HTTP API and client protocol

The browser uses JSON actions and one server-sent event stream per player.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness, client protocol compatibility, and the commit being served. |
| `GET` | `/api/health/update` | Deployment gate; returns `409` while a game is outside its lobby. |
| `POST` | `/api/rooms` | Create a room and return `{code}`. |
| `GET` | `/api/rooms/:code` | Return `{exists, seated}`; pass `?playerId=` to ask about a seat. |
| `POST` | `/api/rooms/:code/join` | Send `{name, playerId?, avatar?}` and receive `{playerId}`. |
| `GET` | `/api/avatars/:file` | Fetch an immutable uploaded or generated player avatar. |
| `GET` | `/api/rooms/:code/events?playerId=` | Open an SSE stream of filtered views. |
| `POST` | `/api/rooms/:code/action` | Send `{type, playerId, …}`. |

`POST /api/rooms` accepts `{game}`. The shared `setGame` action changes the
game while a room is in its lobby.

Shared actions are `leave` and `setGame`.

For a new seat, `avatar` may be a PNG, JPEG, or WebP data URL up to 256 KiB
after decoding. When it is omitted and the server has both
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, the seat is returned
immediately and a name-based avatar is generated in the background. A later SSE
view adds `avatar` to that player. The value in views is a same-server
`/api/avatars/…` path, not image data; clients served from a different origin
resolve it against their configured game server. Missing `avatar` remains valid
and is rendered as the player's initial, so this is an additive protocol change.

Avalon actions are `options`, `start`, `confirm`, `propose`, `vote`, `card`,
`assassinate`, and `again`.

One Night Ultimate Werewolf actions are `options`, `start`, `night`,
`startVote`, `vote`, and `again`. Its `options` action carries optional role
keys, `pace`, and `houseRules`, an object of variant switches; the view reports
the switches in force under `houseRules`. Both are additive, so a client that
predates a variant simply never sends or shows it, and a room whose stored
state predates one plays without it.

Errors use this shape:

```json
{"error": "<translation-key>", "params": {}}
```

The server sends a translation key rather than a sentence so each browser can
show the error in its selected language.

## Reconnecting

`GET /api/rooms/:code?playerId=` is what a browser asks after its event stream
drops, before it reopens one. `exists` says whether the room is still on the
server and `seated` whether that player is still in it, which is what separates
the three outcomes a restart can produce: reopen the stream, take the seat again
with `POST /join`, or stop and tell the player the room has ended. Reopening a
stream blindly cannot tell them apart, so a restart that began with no snapshot
leaves every client retrying a room that will never answer. The probe does not
renew the room's six-hour idle clock, so polling cannot keep a dead room alive.

The same question backs the home screen's rejoin offer. A browser that arrives
without a room in its URL, but with a remembered seat, asks before mentioning
it: a room that has ended leaves no trace on the home screen, and a server that
will not answer produces no offer rather than a false one.

## Protocol compatibility

The current client protocol is `2`. `/api/health` reports it, and the optional
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
