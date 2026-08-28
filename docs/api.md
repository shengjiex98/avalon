# HTTP API

The browser talks to the Node server through JSON actions and one
server-sent-event stream per player. The route handlers and response shapes in
[`src/server.js`](../src/server.js) are authoritative; integration coverage is
in [`test/server.test.js`](../test/server.test.js).

## Route families

- `/api/health` reports liveness, the served commit, persistence compatibility,
  and browser protocol compatibility.
- `/api/health/update` tells an incompatible updater whether replacing the
  process would interrupt a live game.
- `/api/rooms` creates rooms; `/api/rooms/:code` handles membership, actions,
  and filtered SSE views.
- `/api/avatars` serves immutable player images.

Exact methods, request bodies, status codes, and limits belong in
[`src/server.js`](../src/server.js), with game-specific actions defined by
[`src/games/index.js`](../src/games/index.js) and the individual game modules.

Errors carry a translation key and optional parameters:

```json
{"error": "<translation-key>", "params": {}}
```

This lets each browser render server errors in its selected language.

## Reconnection

A reconnecting browser first asks whether its room and seat still exist. It
then reopens the event stream, retakes a missing seat, or returns home. This
distinction is what lets clients recover cleanly after a deployment restart.
See [`public/app.js`](../public/app.js) and
[`test/ui-reconnect.test.js`](../test/ui-reconnect.test.js).

## Compatibility

The browser and server share `API_PROTOCOL`; the persistence layer uses
`STATE_VERSION`. Change the protocol when an old browser cannot use a new view
or action contract, and change the state version when old snapshots cannot be
restored safely. The canonical values live in
[`src/api-protocol.js`](../src/api-protocol.js),
[`public/app.js`](../public/app.js), and
[`src/state-version.js`](../src/state-version.js).

The updater may restart through a live game only when both compatibility values
match. Otherwise it consults `/api/health/update` and defers on `409`. The
complete decision logic is in [`deploy/updater.sh`](../deploy/updater.sh).
