# Game behavior

Avalon supports The Resistance: Avalon and One Night Ultimate Werewolf. They
share rooms, seats, reconnection, test mode, and per-player language selection,
but each game has its own state machine and filtered player views.

The host chooses a game and its options in the lobby. Starting locks the player
count and game choice; **Play again** returns the same seats to a fresh lobby.

## The Resistance: Avalon

Avalon supports 5–10 players. Players propose and approve quest teams, then the
selected team secretly submits quest cards. Evil wins through failed quests;
after three successful quests, the Assassin can still win by identifying
Merlin.

Optional roles and house rules change information, seating, or voting without
changing the room model. Exact decks, quest sizes, knowledge rules, rejection
behavior, and win conditions are defined in
[`src/games/avalon/rules.js`](../src/games/avalon/rules.js) and enforced by
[`src/games/avalon/game.js`](../src/games/avalon/game.js). The corresponding UI
is [`public/games/avalon.js`](../public/games/avalon.js).

## One Night Ultimate Werewolf

One Night Ultimate Werewolf supports 3–10 players and always uses three center
cards. Players receive private night actions on a shared clock, discuss after
the night, and vote simultaneously. The final card held by each player—not the
original deal—determines their team.

Exact roles, night order, timing, house rules, and winner calculation are in
[`src/games/onuw/rules.js`](../src/games/onuw/rules.js) and
[`src/games/onuw/game.js`](../src/games/onuw/game.js). The corresponding UI is
[`public/games/onuw.js`](../public/games/onuw.js), and checked-in narration is
under [`public/audio/onuw/`](../public/audio/onuw/).

## Privacy and language

Only the acting player receives private controls or knowledge. The server
derives every player's view independently; the browser never receives the full
game state. Tests under [`test/`](../test/) exercise role knowledge, hidden
actions, and post-game disclosure.

English and Chinese strings are rendered by the browser from translation keys.
The canonical catalog is [`public/i18n.js`](../public/i18n.js), with coverage in
[`test/i18n-coverage.test.js`](../test/i18n-coverage.test.js).

Test mode creates real seats through the normal API and lets one browser switch
between them. It does not bypass server rules or view filtering.
