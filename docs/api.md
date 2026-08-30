# HTTP API

The browser talks to the Node server through JSON actions and one
server-sent-event stream per player. The route handlers and response shapes in
[`src/server/main.ts`](../src/server/main.ts) are authoritative; integration coverage is
in [`test/server.test.ts`](../test/server.test.ts).

## Route families

- `/api/health` reports liveness, the served commit, persistence compatibility,
  and browser protocol compatibility.
- `/api/health/update` tells an incompatible updater whether replacing the
  process would interrupt a live game.
- `/api/rooms` creates rooms; `/api/rooms/:code` handles membership, actions,
  and filtered SSE views.
- `/api/avatars` serves immutable player images.

Exact methods, status codes, and limits belong in
[`src/server/main.ts`](../src/server/main.ts). Request bodies are treated as unknown
input and validated by [`src/server/commands.ts`](../src/server/commands.ts)
against schemas in [`src/contracts/actions.ts`](../src/contracts/actions.ts)
before dispatch; game-specific actions remain defined by
[`src/server/games/index.ts`](../src/server/games/index.ts) and the individual game modules.

Errors carry a translation key and optional parameters:

```json
{"error": "<translation-key>", "params": {}}
```

This lets each browser render server errors in its selected language.

Room views are discriminated by `gameId` and `phase`. Each phase carries only
the state meaningful to it, while lobby option keys, house-rule keys, pace
choices, and player limits come from server-owned `setup` metadata. The view
builders in the individual game modules are the authoritative contracts.

## Reconnection

A reconnecting browser first asks whether its room and seat still exist. It
then reopens the event stream, retakes a missing seat, or returns home. This
distinction is what lets clients recover cleanly after a deployment restart.
See [`src/client/app.ts`](../src/client/app.ts) and
[`test/ui-reconnect.test.js`](../test/ui-reconnect.test.js).

## Compatibility

The browser and server share `API_PROTOCOL`; the persistence layer uses
`STATE_VERSION`. Change the protocol when an old browser cannot use a new view
or action contract, and change the state version when old snapshots cannot be
restored safely. The canonical values live in
[`src/contracts/api-protocol.ts`](../src/contracts/api-protocol.ts) and
[`src/contracts/state-version.ts`](../src/contracts/state-version.ts). Browser
staging copies the protocol into generated runtime configuration.

The updater may restart through a live game only when both compatibility values
match. Otherwise it consults `/api/health/update` and defers on `409`. The
complete decision logic is in [`deploy/updater.sh`](../deploy/updater.sh).
