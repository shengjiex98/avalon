# Architecture

Avalon has no build-time or runtime dependencies. One Node process serves the
browser client and API, keeps rooms in memory, snapshots them to JSON, and
sends player-specific updates over server-sent events.

## Boundaries

The shared room layer owns membership, hosting, persistence, timers, and event
fan-out. Each game owns its state machine, legal actions, hidden information,
and player views. The HTTP server translates requests into room actions but
does not implement game rules.

```text
browser
  ├── public/app.js and public/ui.js
  └── public/games/*
          │ JSON + SSE
          ▼
src/server.js
          ▼
src/rooms.js ──> src/persistence.js
          │
          └──> src/games/*
```

The game registry is [`src/games/index.js`](../src/games/index.js). Shared room
behavior is in [`src/lobby.js`](../src/lobby.js) and
[`src/rooms.js`](../src/rooms.js); each server game module has a matching
browser module under [`public/games/`](../public/games/).

## State and secrecy

All randomness used by game engines comes from a seeded stream stored with the
room, and successful player inputs are recorded with the state. Snapshots can
therefore resume the same stream and timers after a restart. Persistence and
restore rules are implemented in
[`src/persistence.js`](../src/persistence.js).

Game state is never broadcast directly. Each engine derives a filtered view
for the requesting seat, so hidden roles and actions remain server-side. The
rules and view functions under [`src/games/`](../src/games/) are the canonical
privacy boundary.

## Client compatibility

The Node-hosted client and server move together. The optional GitHub Pages
client moves only after the server, so it checks the server's API protocol
before joining a room. Compatibility constants and checks live in
[`src/api-protocol.js`](../src/api-protocol.js) and
[`public/app.js`](../public/app.js).

## Deployment boundary

GitHub Actions publishes an immutable application archive and updates a stable
pointer. A permanently installed host updater validates and activates the
selected archive; it never executes deployment code from that archive. Pages
is published only after the server reports the exact commit.

See [deployment](deployment.md) for the operating model and the authoritative
implementation in [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)
and [`deploy/`](../deploy/).
