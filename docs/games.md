# Game guide

Avalon includes two hidden-role games. They use the same room, player,
reconnection, and language controls, but each game has its own rules.

The game switcher on the home screen decides what a new room plays. The host
can change the game while the room is in the lobby; the selection locks once a
game starts.

## The Resistance: Avalon

Avalon supports 5–10 players.

- Merlin and the Assassin are always included.
- Percival, Morgana, Mordred, and Oberon are optional. The lobby prevents role
  combinations that do not fit the player count.
- The leader proposes a team and everyone votes on it.
- Five rejected teams in a row give evil the win.
- An approved team secretly plays Success or Fail cards. Good players cannot
  choose Fail.
- Quest four requires two Fail cards with seven or more players.
- Evil wins after three failed quests.
- After three successful quests, the Assassin can still win for evil by
  identifying Merlin. Any player but the Assassin is a legal target; naming
  anyone other than Merlin hands the game to good.
- **Play again** returns the same players to the lobby and deals new roles.

Hidden information is filtered on the server. Merlin does not see Mordred;
Percival cannot distinguish Merlin from Morgana; Oberon and the other evil
players do not see one another. No player's role is revealed to another player
before the game ends.

## One Night Ultimate Werewolf

One Night Ultimate Werewolf supports 3–10 players. The selected deck always
contains three more cards than the number of players. Those extra cards are
placed face down in the center.

Available roles are Werewolf ×2, Minion, Mason ×2, Seer, Robber,
Troublemaker, Drunk, Insomniac, Hunter, Tanner, and Villager.

After the deal, each player inspects their role and marks themselves ready.
The night begins when everyone is ready and follows one shared clock on every
device. The host chooses a brisk, normal, or relaxed pace; narration can be
muted on each device.

The night script follows these privacy rules:

- A role is called when its card is in the selected deck.
- A role is still called if its card is one of the three center cards.
- A role's step never ends early when its player finishes acting.
- Screens never identify who is awake, who has acted, or who is being waited
  on.

Only the player acting in the current step receives controls. Information such
as the Seer's view, the Robber's new card, or the lone Werewolf's center-card
peek is shown while that player is still awake. A reference panel shows the
deck, role descriptions, night order, and current step.

English and Mandarin night announcements are checked into
`public/audio/onuw/`. Their source lines and regeneration command are in
`scripts/generate-onuw-audio.py`.

After the night, players discuss and vote at the same time. The player or
players with the most votes die. If every player receives exactly one vote,
nobody dies. A player's final team is determined by the card they hold at the
end of the night, not the card originally dealt to them.

The vote is then scored:

- The Tanner wins by dying, and a dead Tanner denies the werewolf team the win.
- The village wins if at least one werewolf dies.
- If every werewolf card ended up in the center, the village wins when nobody
  dies, and the Minion wins when anyone other than the Minion dies.
- Otherwise the werewolf team wins.
- Any other ending has no winner: with no werewolf and no Minion in play, a
  table that hangs someone loses together.

The Doppelgänger is intentionally unsupported. Its action depends on a copied
role and night information, which does not fit the shared fixed-step model.

## Language

Every player chooses English or Chinese independently. The server sends
translation keys and parameters instead of user-facing sentences, and each
browser renders them in its selected language.

## Test mode

Turn on **test mode** at the bottom of a room to run a game from one browser.
It can add players and switch between their seats. Each seat is a real player
using the normal join endpoint and filtered event stream, rather than a mocked
view.

Seats are remembered per room, so refreshing the page returns to the last
selected seat.
