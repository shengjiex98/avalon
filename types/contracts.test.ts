import type {
  AvalonLobbyView, AvalonQuestView, AvalonTeamView, AvalonView,
  OnuwLobbyView, OnuwNightView, OnuwOverView, OnuwView,
} from './contracts.js';

declare const avalonLobby: AvalonLobbyView;
declare const avalonQuest: AvalonQuestView;
declare const avalonTeam: AvalonTeamView;
declare const avalonView: AvalonView;
declare const onuwLobby: OnuwLobbyView;
declare const onuwNight: OnuwNightView;
declare const onuwOver: OnuwOverView;
declare const onuwView: OnuwView;

// Representative construction fixtures keep the authored wire shapes honest.
const avalonLobbyFixture = {
  code: 'ABCD', gameId: 'avalon', phase: 'lobby', version: 1, hostId: 'p0',
  me: { id: 'p0', name: 'Ann', avatar: null },
  you: { id: 'p0', name: 'Ann', avatar: null },
  players: [{ id: 'p0', name: 'Ann', avatar: null, seat: 0 }],
  log: [],
  setup: { minPlayers: 5, maxPlayers: 10, options: [], houseRules: [] },
  options: {}, houseRules: {}, deck: null,
} satisfies AvalonLobbyView;

const onuwNightFixture = {
  code: 'WXYZ', gameId: 'onuw', phase: 'night', version: 2, hostId: 'p0',
  me: { id: 'p0', name: 'Bo', avatar: null },
  you: {
    id: 'p0', name: 'Bo', avatar: null, role: 'seer', team: 'village',
    awake: true, action: 'seer', acted: false,
  },
  players: [{ id: 'p0', name: 'Bo', avatar: null, seat: 0 }],
  log: [],
  setup: { minPlayers: 3, maxPlayers: 10, options: [], houseRules: [], paces: [] },
  houseRules: {}, deck: { seer: 1 }, centreCount: 3, nightScript: [], info: [],
  night: { index: 0, total: 1, key: 'wake.seer', msLeft: 1_000, msTotal: 5_000 },
} satisfies OnuwNightView;

avalonLobbyFixture.deck;
onuwNightFixture.night;

// Representative positive consumers prove useful narrowing.
if (avalonView.phase === 'quest') avalonView.players[0]?.hasPlayed;
if (onuwView.phase === 'night') onuwView.you?.action;
avalonLobby.deck;
avalonQuest.waitingFor;
onuwLobby.nightSeconds;
onuwOver.players[0]?.finalRole;

// @ts-expect-error a lobby never exposes the viewer's role
avalonLobby.you?.role;
// @ts-expect-error another Avalon player's role is private until game over
avalonTeam.players[0]?.role;
// @ts-expect-error another One Night player's starting role is private until game over
onuwNight.players[0]?.startRole;
// @ts-expect-error another One Night player's final role is private until game over
onuwNight.players[0]?.finalRole;
// @ts-expect-error quest-card progress exists only during a quest
avalonTeam.players[0]?.hasPlayed;
// @ts-expect-error the team size is not part of the quest view
avalonQuest.teamSize;
// @ts-expect-error the night clock does not exist in the One Night lobby
onuwLobby.night;
