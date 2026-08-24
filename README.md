# Avalon

Two self-hosted hidden-role party games in one page — ***The Resistance:
Avalon*** (5–10 players) and ***One Night Ultimate Werewolf*** (3–10) — with a
switcher in the top bar and a one-tap **English / 中文** toggle. No build step,
no dependencies, no database — one `node` process and a browser each.

```bash
node src/server.js          # http://localhost:8420
npm test                    # 43 tests, no network needed
```

Open the page, create a room, and share the four-letter code. Everyone else
enters the code on their own phone.

## Two games, one room

The switcher in the top bar picks the game. On the home screen it decides what
**Create** makes; in a lobby the host uses it to change what the room is
playing, keeping everyone at the table. Once a game starts it locks.

They share a room layer and nothing else. Rooms, joining, reconnection, SSE
fan-out, the bilingual protocol and the deployment are identical and live in
`src/lobby.js`, `src/rooms.js` and `src/server.js`; each game keeps its own
state machine under `src/games/<id>/`. Avalon is five rounds of proposal and
voting; Werewolf is one night and one vote. Trying to unify *those* would have
produced a worse version of both.

### One Night Ultimate Werewolf

3–10 players. The deck is always three cards larger than the table, and the
spare three sit face down in the middle, so some roles are in nobody's hands.
Roles: Werewolf ×2, Minion, Mason ×2, Seer, Robber, Troublemaker, Drunk,
Insomniac, Hunter, Tanner, Villager.

After the cards are dealt, every player can inspect their role and marks
themselves ready. The night starts only once the whole table is ready. It then
runs on a **shared clock**, the way the physical game's companion app does: a
fixed script of role steps, each a fixed length, announced on screen and read
aloud, identical on every player's phone.

The script is built from the deck, and two rules keep it from telling anyone
anything:

- **A role is called when its card is in the deck** — which the lobby already
  showed everyone. Calling roles nobody agreed to play would hide nothing and
  only burn the table's time.
- **A role in the deck is called even if its card is in the centre**, and a
  step **never ends early** once the acting player has chosen. Both of those
  *are* secret, so the clock must not reflect them.

So no screen ever says who is awake, who has acted, or who is being waited on
— an earlier version leaked exactly that, and the shared countdown is what
replaces it. Only the player whose card matches the current step gets controls;
everyone else sees the same clock and the words "eyes closed".

Whatever you look at, you see **while you are still awake** — the Seer's
reading, the card the Robber took, the lone wolf's peek at the centre. A
foldaway pane lists the deck, what each role does, and the night order, with
the current step marked. The host sets the pace (brisk / normal / relaxed) in
the lobby, and voice can be muted per device. Night calls use checked-in neural
voice recordings in both English and Mandarin, so the narrator sounds the same
on every browser and does not depend on the device's speech synthesizer. The
source lines and regeneration command live in `scripts/generate-onuw-audio.py`.

Then you argue, then everyone points at once. Most fingers dies; if every
player collects exactly one vote, nobody does. You belong to the team of the
card you are **holding at the end**, not the one you were dealt.

**The Doppelgänger is deliberately absent.** It copies a role and then acts as
it — a choice that genuinely depends on night information, and the one role
this model cannot represent honestly.

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

## Testing a game on your own

There is a **test mode** toggle at the foot of the page. Switch it on inside a
room and you can add extra players and hop between seats: each one is a real
player joined from this browser, and switching reopens the stream as them, so
what you see is the genuine per-player view rather than a mock of one. That
makes it possible to walk a five-handed Avalon or a whole werewolf night
through alone, and it exercises the same view filtering the real game does.

Seats are remembered per room, so a refresh puts you back where you were.

## Layout

```
.github/           Tests plus the official Pages client deployment.
docs/              Architecture decisions and reversion guides.
deploy/            systemd user unit for the game server.
src/lobby.js       Joining, hosting, logging — what both games do identically.
src/rooms.js       Room registry, subscriber fan-out, idle expiry.
src/server.js      HTTP: static files, JSON actions, one SSE stream per player.
src/games/index.js The registry the room layer dispatches through.
src/games/avalon/  Avalon's rules and state machine.
src/games/onuw/    One Night Werewolf's rules and state machine.
public/app.js      The shell: transport, home, lobby, the switcher.
public/ui.js       DOM helpers shared by every screen.
public/games/      One module of screens per game.
public/audio/onuw/  Pre-generated English and Mandarin night announcements.
public/i18n.js     Every user-visible string, en + zh.
test/              Rules, engines, HTTP, translations, and the rendered UI.
```

No engine touches the network and the server never reasons about a game, so
every rule is testable without a browser or a socket. Adding a third game means
a directory under `src/games/`, a module under `public/games/`, and two
registry lines — the room layer does not change.

## Talking to it

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | liveness and client protocol compatibility |
| `POST` | `/api/rooms` | create a room, returns `{code}` |
| `GET` | `/api/rooms/:code` | `{exists}` |
| `POST` | `/api/rooms/:code/join` | `{name, playerId?}` → `{playerId}` |
| `GET` | `/api/rooms/:code/events?playerId=` | SSE, one filtered view per update |
| `POST` | `/api/rooms/:code/action` | `{type, playerId, …}` |

`POST /api/rooms` takes `{game}`; `setGame` switches a lobby between them.
Common actions: `leave`, `setGame`. Avalon adds `options`, `start`, `confirm`,
`propose`, `vote`, `card`, `assassinate`, `again`; Werewolf adds `options`,
`start`, `night`, `startVote`, `vote`, `again`. Errors come back as
`{error: "<key>", params: {…}}` — a translation key, not a sentence, so the
client shows it in the reader's language.

The browser and server currently speak protocol `1`. The Pages client checks
that number before exposing the lobby, so independently deployed versions fail
clearly when their API contract no longer matches.

## Testing

`npm test` runs the suites with Node's built-in runner:

- **rules** — setup tables, role fitting, and each role's knowledge.
- **game** — deterministic full Avalon games: rejections, the hammer, two-fail
  quests, both assassination outcomes, and an assertion that no view leaks a role.
- **onuw** — deterministic werewolf nights on an owned clock: that the script
  follows the deck, that a role whose card sits in the centre is called anyway,
  that a step does not end early when the actor is done, that no night view
  names who is awake or has acted, that a timed-out Drunk still swaps, every
  win condition, and that no view shows another player's card before the vote.
- **rooms** — that the night advances on the room's own timer with nobody
  pressing anything, that the new step is broadcast, and that a swept room
  takes its timer with it.
- **server** — real HTTP against an ephemeral port, including a five-player
  game played end to end over SSE.
- **i18n-coverage** — every key `app.js` and `index.html` ask for, plus every
  error, win reason and log event the server can emit, exists in *both*
  languages. This is what catches a half-finished translation, since there is
  no browser in the loop.
- **ui** — renders the real client into a tiny DOM shim (`test/dom-shim.js`)
  and drives it: the home screen's structure, an invite link, the language
  toggle, and clicking through to a join request.
- **ui-game** / **ui-onuw** — render every phase of both games from views the
  actual engines produced, in both languages, asserting among other things that
  no untranslated key ever reaches the screen. There is no browser here, so
  this is the substitute. Includes a regression test that a redraw mid-step
  paints the time actually left rather than the step's full length.
- **ui-connect** — joining and reconnecting from a cold module, which is where
  a view hook that throws used to freeze the last screen on display under a
  "connection lost" banner. Also that a first connection reads *connecting*
  rather than *dropped*.
- **ui-testmode** — that the toggle starts off at the foot of the page, that
  adding a seat goes through the ordinary join endpoint with a name that does
  not collide, that switching seats reopens the stream as that player, and
  that a refused join is reported rather than recorded as a phantom seat.
- **deploy** — both supported entry points: the Node-hosted client, the
  fingerprinted Pages artifact, HTTPS backend selection, and protocol checks.

## Deploying

State is in memory: restarting drops in-progress games, and rooms idle for six
hours are swept. That is deliberate for a party game — nothing to back up.

Behind a reverse proxy, disable response buffering on `/api/rooms/*/events` or
the SSE stream will stall (nginx: `proxy_buffering off;`). `PORT` and `HOST`
are read from the environment.

As a user service, `deploy/avalon.service` keeps the unit in the repo rather
than loose in `~/.config/systemd/user`, where a restore would not find it:

```bash
systemctl --user link ~/avalon/deploy/avalon.service
systemctl --user enable --now avalon
loginctl enable-linger "$USER"      # keep it up across logout and reboot
```

Host-specific settings go in `~/.config/avalon.env` (outside the repo):

```sh
PORT=8420
HOST=0.0.0.0
```

The Node process is always a complete deployment: it serves both `public/` and
`/api` from one origin. Point the public URL or reverse proxy at port 8420 and
share that URL. Open games check the Node server's generated `/version.json`
once a minute and offer to reload after a new deployment.

For remote players, put HTTPS in front of the Node process. Common routes are:

| Route | Who can play | Notes |
| --- | --- | --- |
| `tailscale funnel 8420` | anyone with the link | Public HTTPS on your `*.ts.net` name, real certificate, nothing to configure. |
| `tailscale serve 8420` | tailnet members only | Same valid certificate, but reachable only from your tailnet. |
| Cloudflare Tunnel / nginx + Let's Encrypt | anyone | The usual reverse-proxy setup; remember `proxy_buffering off`. |

### Official GitHub Pages client

`https://shengjiex98.github.io/avalon/` is the optional stable client URL.
It uses the repository's Actions variable `API_BASE` as its default HTTPS Node
server. A `?server=` room link or a server saved in the browser overrides that
default, and copied room links carry the active server address. Every Node
deployment accepts requests from this exact Pages origin. Other browser origins
are not supported, and a client served by Node always uses its own same-origin
API.

The Pages workflow tests the repository, writes `API_BASE` into
`public/config.js`, stamps the module graph with the commit SHA, and publishes
`public/`. If maintaining two entry points stops being useful,
[the single-server decision](docs/single-server.md) is the exact reversion
checklist.

## Trust model

Anyone holding a room code can join, and a player's identity is the random id
their browser stores. There are no accounts and no server-side auth: it assumes
the people in the room are friends. Roles are still enforced server-side — a
player cannot read another's role, vote twice, or fail a quest as a good
character by editing the client.
