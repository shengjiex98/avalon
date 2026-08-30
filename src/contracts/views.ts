import type { GameId } from './actions.ts';
import type { AvalonState, GameEvent, LogEntry, OnuwState } from './persistence.ts';

export type AvalonPhase = AvalonState['phase'];
export type OnuwPhase = OnuwState['phase'];
export type GamePhase = AvalonPhase | OnuwPhase;

export interface PublicViewBase<G extends GameId, P extends GamePhase> {
  code: string;
  gameId: G;
  phase: P;
  version: number;
  hostId: string | null;
  me: null | { id: string; name: string; avatar: string | null };
  log: LogEntry[];
}

interface ViewPerson {
  id: string;
  name: string;
  avatar: string | null;
}

interface ViewPlayer extends ViewPerson {
  seat: number;
}

interface GameSetup {
  minPlayers: number;
  maxPlayers: number;
  options: string[];
  houseRules: string[];
}

type WithSeats<Y, P> = {
  you: Y | null;
  players: P[];
};

type AvalonSetup = GameSetup;
type AvalonLobbyPlayer = ViewPlayer;
interface AvalonActivePlayer extends ViewPlayer { isLeader: boolean }
interface AvalonTeamPlayer extends AvalonActivePlayer { onTeam: boolean }
interface AvalonVotePlayer extends AvalonTeamPlayer { hasVoted: boolean }
interface AvalonQuestPlayer extends AvalonTeamPlayer { hasPlayed?: boolean }
interface AvalonRevealPlayer extends AvalonActivePlayer { ready: boolean }
interface AvalonOverPlayer extends AvalonActivePlayer { role: string | undefined }

type AvalonYou = ViewPerson & { role: string | null; side: string | null };
type AvalonCommon<P extends AvalonPhase, Y, Player> = PublicViewBase<'avalon', P>
  & WithSeats<Y, Player>
  & { setup: AvalonSetup };
type AvalonInGame<P extends Exclude<AvalonPhase, 'lobby'>, Player> = AvalonCommon<P, AvalonYou, Player> & {
  houseRules: Record<string, boolean>;
  roleCounts: Record<string, number>;
  round: number;
  rejects: number;
  maxRejects: number;
  boardSizes: Array<{ size: number | undefined; twoFails: boolean }>;
  quests: Array<{ round: number; success: boolean; fails: number; team: string[] }>;
  lastVote: AvalonState['lastVote'];
  voteTally: null | { round: number; attempt: number; approved: boolean; yes: number; no: number };
  knowledge: Array<{ playerId: string; hint: string }>;
  evilCount: number;
};

export type AvalonLobbyView = AvalonCommon<'lobby', ViewPerson, AvalonLobbyPlayer> & {
  options: Record<string, boolean>;
  houseRules: Record<string, boolean>;
  deck: Record<string, number> | null;
};
export type AvalonRevealView = AvalonInGame<'reveal', AvalonRevealPlayer> & { waitingFor: string[] };
export type AvalonTeamView = AvalonInGame<'team', AvalonTeamPlayer> & {
  team: string[];
  teamSize: number | undefined;
  failsRequired: number;
  waitingFor: string[];
};
export type AvalonVoteView = AvalonInGame<'vote', AvalonVotePlayer> & {
  team: string[];
  teamSize: number | undefined;
  waitingFor: string[];
};
export type AvalonQuestView = AvalonInGame<'quest', AvalonQuestPlayer> & {
  team: string[];
  failsRequired: number;
  waitingFor: string[];
};
export type AvalonAssassinView = AvalonInGame<'assassin', AvalonActivePlayer> & {
  assassinTarget: string | null;
  waitingFor: string[];
};
export type AvalonOverView = AvalonInGame<'over', AvalonOverPlayer> & {
  assassinTarget: string | null;
  winner: 'good' | 'evil' | null;
  winReason: string | null;
};
export type AvalonView = AvalonLobbyView | AvalonRevealView | AvalonTeamView
  | AvalonVoteView | AvalonQuestView | AvalonAssassinView | AvalonOverView;

interface OnuwSetup extends GameSetup { paces: string[] }
interface OnuwRevealPlayer extends ViewPlayer { ready: boolean }
interface OnuwVotePlayer extends ViewPlayer { voted: boolean }
interface OnuwOverPlayer extends ViewPlayer {
  votedFor: string | null;
  dead: boolean;
  startRole: string | undefined;
  finalRole: string | undefined;
}
type OnuwYou = ViewPerson & { role: string | null; team: string | null };
type OnuwNightYou = OnuwYou & {
  awake: boolean;
  action?: 'loneWolf' | 'seer' | 'robber' | 'troublemaker' | 'drunk';
  acted: boolean;
};
type OnuwVoteYou = OnuwYou & { voted: boolean };
type OnuwOverYou = OnuwYou & { finalRole: string | undefined };
type OnuwCommon<P extends OnuwPhase, Y, Player> = PublicViewBase<'onuw', P>
  & WithSeats<Y, Player>
  & { setup: OnuwSetup };
type OnuwInGame<P extends Exclude<OnuwPhase, 'lobby'>, Y, Player> = OnuwCommon<P, Y, Player> & {
  houseRules: Record<string, boolean>;
  deck: Record<string, number>;
  centreCount: number;
  nightScript: string[];
  info: GameEvent[];
};

export type OnuwLobbyView = OnuwCommon<'lobby', ViewPerson, ViewPlayer> & {
  options: Record<string, boolean>;
  houseRules: Record<string, boolean>;
  optionRoom: number;
  deck: Record<string, number> | null;
  pace: string;
  nightScript: string[];
  nightSeconds: number;
};
export type OnuwRevealView = OnuwInGame<'reveal', OnuwYou, OnuwRevealPlayer> & { waitingFor: string[] };
export type OnuwNightView = OnuwInGame<'night', OnuwNightYou, ViewPlayer> & {
  night: null | { index: number; total: number; key: string; msLeft: number; msTotal: number };
};
export type OnuwDayView = OnuwInGame<'day', OnuwYou, ViewPlayer>;
export type OnuwVoteView = OnuwInGame<'vote', OnuwVoteYou, OnuwVotePlayer> & { waitingFor: string[] };
export type OnuwOverView = OnuwInGame<'over', OnuwOverYou, OnuwOverPlayer> & {
  centre: string[];
  swaps: GameEvent[];
  dead: string[];
  winners: string[];
  youWon?: boolean;
};
export type OnuwView = OnuwLobbyView | OnuwRevealView | OnuwNightView
  | OnuwDayView | OnuwVoteView | OnuwOverView;
export type PublicView = AvalonView | OnuwView;
export type PublicViewFor<G extends GameId> = G extends 'avalon' ? AvalonView : OnuwView;
