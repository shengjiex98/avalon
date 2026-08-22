# Avalon

A self-hosted, multiplayer web version of *The Resistance: Avalon* for 5–10
players, with a one-tap **English / 中文** toggle. No build step, no
dependencies, no database — one `node` process and a browser each.

```bash
node src/server.js          # http://localhost:8420
npm test                    # 43 tests, no network needed
```

Open the page, create a room, and share the four-letter code. Everyone else
enters the code on their own phone.

## What it does

- **Rooms** — a four-character code; players join, reconnect after a refresh,
  and drop out of the lobby without breaking the game.
- **Roles** — Merlin and the Assassin are always in play. Percival, Morgana,
  Mordred and Oberon are lobby toggles, validated against the player count.
- **Hidden information** — the server sends each browser only what that player
  is entitled to see. Merlin's view omits Mordred, Percival cannot tell Merlin
  from Morgana, Oberon is invisible to the other evil players and they to him.
  Nobody's role appears in anyone else's payload until the game ends.
- **Full round loop** — leader proposes, everyone votes, five rejections in a
  row hand the game to evil; approved teams play secret Success/Fail cards, and
  quest 4 needs two fails at 7+ players.
- **Endgame** — three failed quests and evil wins outright; three successes and
  the Assassin gets one shot at naming Merlin. Then "play again" returns the
  same table to the lobby with fresh roles.
- **Bilingual** — every player picks their own language, so an English reader
  and a Chinese reader can sit in the same game. The server never sends prose:
  it sends keys and parameters, and each browser renders them.

## Layout

```
src/rules.js    Setup tables, role definitions, who-sees-whom. Pure data.
src/game.js     The state machine, and the per-player view filter.
src/rooms.js    Room registry, subscriber fan-out, idle expiry.
src/server.js   HTTP: static files, JSON actions, one SSE stream per player.
public/i18n.js  Every user-visible string, en + zh.
public/app.js   The client: no framework, no bundler.
test/           Rules, engine, HTTP, and translation coverage.
```

The engine never touches the network and the server never reasons about the
game, so the rules are testable without a browser or a socket.

## Talking to it

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/rooms` | create a room, returns `{code}` |
| `GET` | `/api/rooms/:code` | `{exists}` |
| `POST` | `/api/rooms/:code/join` | `{name, playerId?}` → `{playerId}` |
| `GET` | `/api/rooms/:code/events?playerId=` | SSE, one filtered view per update |
| `POST` | `/api/rooms/:code/action` | `{type, playerId, …}` |

Actions: `options`, `start`, `confirm`, `propose`, `vote`, `card`,
`assassinate`, `leave`, `again`. Errors come back as
`{error: "<key>", params: {…}}` — a translation key, not a sentence, so the
client shows it in the reader's language.

## Testing

`npm test` runs four suites with Node's built-in runner:

- **rules** — setup tables, role fitting, and each role's knowledge.
- **game** — deterministic full games: rejections, the hammer, two-fail quests,
  both assassination outcomes, and an assertion that no view leaks a role.
- **server** — real HTTP against an ephemeral port, including a five-player
  game played end to end over SSE.
- **i18n-coverage** — every key `app.js` and `index.html` ask for, plus every
  error, win reason and log event the server can emit, exists in *both*
  languages. This is what catches a half-finished translation, since there is
  no browser in the loop.

## Deploying

State is in memory: restarting drops in-progress games, and rooms idle for six
hours are swept. That is deliberate for a party game — nothing to back up.

Behind a reverse proxy, disable response buffering on `/api/rooms/*/events` or
the SSE stream will stall (nginx: `proxy_buffering off;`). `PORT` and `HOST`
are read from the environment.

As a user service:

```ini
# ~/.config/systemd/user/avalon.service
[Unit]
Description=Avalon
After=network-online.target

[Service]
ExecStart=/usr/bin/node %h/avalon/src/server.js
Environment=PORT=8420
Restart=on-failure

[Install]
WantedBy=default.target
```

## Trust model

Anyone holding a room code can join, and a player's identity is the random id
their browser stores. There are no accounts and no server-side auth: it assumes
the people in the room are friends. Roles are still enforced server-side — a
player cannot read another's role, vote twice, or fail a quest as a good
character by editing the client.
