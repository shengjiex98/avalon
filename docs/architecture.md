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
  └── build/public/* (fingerprinted browser artifact and copied public assets)
          │ JSON + SSE
          ▼
src/server/main.ts
          ▼
src/server/rooms.ts ──> src/server/persistence.ts
          │
          └──> src/server/games/*
```

Authored browser modules and styles live under [`src/client/`](../src/client/),
Node-only code under [`src/server/`](../src/server/), and contracts used across
that boundary under [`src/contracts/`](../src/contracts/). The browser entry is
[`index.html`](../index.html); [`public/`](../public/) holds only runtime
configuration and copy-only art and audio.

The game registry is [`src/server/games/index.ts`](../src/server/games/index.ts).
Shared room behavior is in [`src/server/lobby.ts`](../src/server/lobby.ts) and
[`src/server/rooms.ts`](../src/server/rooms.ts); each server game module has a
matching browser module under [`src/client/games/`](../src/client/games/).

The browser entrypoint composes owners for durable storage, HTTP and stream
transport, the active room session, shared rendering, and test seats. A game
renderer receives an explicit context and owns its disposable resources; One
Night countdowns and audio therefore end with that renderer rather than living
as module globals. `npm run build:browser` uses
[`vite.config.ts`](../vite.config.ts) to emit the browser-loadable tree and its
manifest under `build/public/`; the generated directory is never authored or
committed.

## State and secrecy

All randomness used by game engines comes from a seeded stream stored with the
room, and successful player inputs are recorded with the room. A snapshot is
validated as one unit before any room is restored, so malformed state or broken
roster references cannot leave a partial registry. Snapshots can resume the
same stream and timers after a restart. Persistence and restore rules are in
[`src/server/persistence.ts`](../src/server/persistence.ts).

Game state is never broadcast directly. Each engine derives a filtered view
for the requesting seat, so hidden roles and actions remain server-side. The
rules and view functions under [`src/server/games/`](../src/server/games/) are the canonical
privacy boundary.

## Client compatibility

The Node-hosted client and server move together. The optional GitHub Pages
client moves only after the server, so it checks the server's API protocol
before joining a room. Compatibility constants and checks live in
[`src/contracts/api-protocol.ts`](../src/contracts/api-protocol.ts), generated
browser configuration, and [`src/client/app.ts`](../src/client/app.ts).

## Deployment boundary

GitHub Actions publishes an immutable application archive and updates a stable
pointer. A permanently installed host updater validates and activates the
selected archive; it never executes deployment code from that archive. Pages
is published only after the server reports the exact commit.

See [deployment](deployment.md) for the operating model and the authoritative
implementation in [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)
and [`deploy/`](../deploy/).
