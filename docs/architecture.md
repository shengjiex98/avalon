# Architecture

Avalon has no build-time or runtime dependencies. A Node process serves the
browser client and JSON API, stores rooms in memory, and sends filtered updates
over server-sent events (SSE).

The games share room infrastructure but not state machines. Joining, hosting,
reconnection, logging, language-independent events, and subscriber fan-out are
common. Avalon and One Night Ultimate Werewolf implement their rules under
separate game modules.

## Repository layout

```text
.github/            Tests and the GitHub Pages client deployment.
deploy/             Statically installed updater, listener, verifier, and systemd units.
docs/               Design, operations, and reference documentation.
src/lobby.js        Shared joining, hosting, and logging behavior.
src/rooms.js        Room registry, SSE fan-out, timers, snapshots, and idle expiry.
src/persistence.js  Atomic snapshot save and version-checked restore.
src/state-version.js  Compatibility number for persisted room state.
src/server.js       Static files, JSON endpoints, and SSE endpoints.
src/games/index.js  Game registry used by the room layer.
src/games/avalon/   Avalon rules and state machine.
src/games/onuw/     One Night Ultimate Werewolf rules and state machine.
public/app.js       Transport, home, lobby, and game switcher.
public/ui.js        Shared DOM helpers.
public/games/       Browser screens for each game.
public/audio/onuw/  English and Mandarin night announcements.
public/i18n.js      English and Chinese user-visible strings.
test/               Engine, HTTP, translation, deployment, and UI tests.
```

## Game boundary

Game engines do not access the network, and the HTTP server does not implement
game rules. This keeps rules deterministic and testable without a browser or
socket.

Adding another game requires a state-machine directory under `src/games/`, a
screen module under `public/games/`, and registration in the server and client
game registries. The shared room layer does not need game-specific branches.

## State and events

Live room and game state is kept in memory. Every successful player input is
recorded in that state, and randomness comes from a seeded stream whose current
position is stored with the game. Neither the input record nor hidden game data
is included in player views: each room asks its active game for the view allowed
for that player before broadcasting through SSE.

Mutations are debounced into an atomic JSON snapshot, with a final synchronous
save on clean shutdown. Boot restores rooms before listening and reconstructs
runtime-only clocks from their deadlines. A restart therefore preserves live
games when the snapshot's `STATE_VERSION` matches the code. An incompatible or
unreadable snapshot is discarded and the server starts empty. Rooms idle for
six hours are still removed.

## Rooms, seats, and the URL

The URL fragment is the only thing that puts a browser into a room. What the
browser stores — the room it last held a seat in, and the player id for that
room — is an offer rather than a destination: a bare URL lands on the home
screen, which asks the server whether that seat is still real and shows a
rejoin card if it is. Clearing the address bar is therefore a way out of a game,
and a fragment that simply went missing, as it does from a home-screen shortcut,
still costs nobody their seat.

Leaving is local. A room removes a player only while it is in its lobby: once
roles are dealt the head count fixes the quest sizes and the deck, so the server
refuses and the seat stays where the rules need it. A player who leaves mid-game
stops watching, keeps the seat id, and is offered the way back until they refuse
it or the room ends. Refusing stops the offer without discarding the id, so the
room's own link still lands them in their own seat: nothing but the server
saying the seat is gone throws one away, which is what keeps a mis-tap from
ending someone's game.

## Client versions

The Node-hosted client and server are deployed together. The optional GitHub
Pages client can be deployed independently, so it probes `/api/health` and
compares the reported protocol before opening a lobby. A protocol mismatch is
shown as an explicit compatibility error.

The current browser/server protocol is `2`. See [the API reference](api.md)
for endpoint details and [deployment](deployment.md) for the two supported
entry points.

## Deployment boundary

GitHub Actions packages and tests one immutable commit archive, uploads it, and
then replaces a stable `latest.json` pointer containing its SHA-256. The host's
installed listener treats ntfy as a wake-up only. Its installed updater fetches
the pointer, verifies and prepares inert application bytes, checks state and API
compatibility, atomically switches `current`, and health-verifies the exact
commit. Candidate releases never execute deployment code or replace the static
control plane.

The public Pages client is published only after the server reports that same
commit, keeping server and browser protocol changes ordered.
