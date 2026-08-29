# Architecture

One Node process serves the browser client and API, keeps rooms in memory,
snapshots them to JSON, and sends player-specific updates over server-sent
events. Runtime request and persistence contracts live under
[`src/contracts/`](../src/contracts/) and use the production schema package;
the browser remains dependency-free output.

## Boundaries

The shared room layer owns identity, membership, hosting, revisions, replay
records, randomness, persistence, timers, and event fan-out. A selected game is
stored as an engine id plus engine-only state. Each game owns its state machine,
legal actions, hidden information, and player views. The HTTP server translates
requests into room actions but does not implement game rules.

```text
browser
  ├── public/app.js
  ├── public/storage.js, public/transport.js, public/room-session.js
  ├── public/rendering.js and public/test-seats.js
  └── public/games/* (constructed renderers)
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

The browser entrypoint composes owners for durable storage, HTTP and stream
transport, the active room session, shared rendering, and test seats. A game
renderer receives an explicit context and owns its disposable resources; One
Night countdowns and audio therefore end with that renderer rather than living
as module globals.

## State and secrecy

All randomness used by game engines comes from a seeded stream stored with the
room, and successful player inputs are recorded with the room. A snapshot is
validated as one unit before any room is restored, so malformed state or broken
roster references cannot leave a partial registry. Snapshots can resume the
same stream and timers after a restart. Persistence and restore rules are in
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
