import type {
  AvalonAction, CreateRoomCommand, GameId, JoinCommand, OnuwAction,
  OnuwNightAction, ValidatedAction,
} from './actions.ts';
import type {
  GameEvent, JournalEntry, LogEntry, PersistedRoom, Player, SnapshotFile,
} from './persistence.ts';

export type {
  GameEvent, JournalEntry, LogEntry, OnuwNightAction, PersistedRoom, Player, SnapshotFile,
};
export type { GameId };
export type AvalonPhase = 'lobby' | 'reveal' | 'team' | 'vote' | 'quest' | 'assassin' | 'over';
export type OnuwPhase = 'lobby' | 'reveal' | 'night' | 'day' | 'vote' | 'over';
export type GamePhase = AvalonPhase | OnuwPhase;

export type AvalonRole = 'merlin' | 'percival' | 'servant' | 'assassin'
  | 'morgana' | 'mordred' | 'oberon' | 'minion';
export interface AvalonState {
  phase: AvalonPhase;
  options: { percival: boolean; morgana: boolean; mordred: boolean; oberon: boolean };
  optionsTouched: boolean;
  houseRules: { randomLeader: boolean; hiddenVotes: boolean; resetRejects: boolean };
  roles: Record<string, AvalonRole>;
  round: number;
  leaderIndex: number;
  rejects: number;
  team: string[];
  votes: Record<string, boolean>;
  lastVote: null | {
    round: number; attempt: number; team: string[];
    votes: Record<string, boolean>; approved: boolean;
  };
  cards: Record<string, boolean>;
  quests: Array<{ round: number; team: string[]; fails: number; success: boolean }>;
  assassinTarget: string | null;
  winner: 'good' | 'evil' | null;
  winReason: string | null;
  ready?: Record<string, boolean> | undefined;
}

export type OnuwRole = 'werewolf' | 'minion' | 'mason' | 'seer' | 'robber'
  | 'troublemaker' | 'drunk' | 'insomniac' | 'hunter' | 'tanner' | 'villager';
export interface OnuwScriptStep { key: string; role?: OnuwRole | undefined; seconds: number }
export interface OnuwState {
  phase: OnuwPhase;
  options: {
    minion: boolean; mason: boolean; drunk: boolean; insomniac: boolean;
    hunter: boolean; tanner: boolean;
  };
  optionsTouched: boolean;
  houseRules: { decisiveVote: boolean };
  pace: 'brisk' | 'normal' | 'relaxed';
  script: OnuwScriptStep[];
  step: number;
  stepEndsAt: number;
  ready: Record<string, boolean>;
  startRoles: Record<string, OnuwRole>;
  centreStart: OnuwRole[];
  finalRoles: Record<string, OnuwRole>;
  centre: OnuwRole[];
  nightActions: Record<string, OnuwNightAction>;
  info: Record<string, GameEvent[]>;
  swaps: GameEvent[];
  votes: Record<string, string>;
  dead: string[];
  winners: Array<'village' | 'werewolf' | 'tanner'>;
}

type PersistedRoomFor<G extends GameId> = Extract<PersistedRoom, { game: { id: G } }>;
type StateFor<G extends GameId> = G extends 'avalon' ? AvalonState : OnuwState;
type RoomWithRuntimeState<G extends GameId> = Omit<PersistedRoomFor<G>, 'game'> & {
  game: { id: G; state: StateFor<G> };
};
export type CreatedRoomFor<G extends GameId> = Omit<RoomWithRuntimeState<G>, 'touchedAt'>;
export type CreatedRoom = CreatedRoomFor<'avalon'> | CreatedRoomFor<'onuw'>;

export interface Subscription {
  playerId: string;
  send: (view: PublicView) => void;
}

export type RuntimeRoomFor<G extends GameId> = RoomWithRuntimeState<G> & {
  subscribers: Set<Subscription>;
  timer: NodeJS.Timeout | null;
};
export type RuntimeRoom = RuntimeRoomFor<'avalon'> | RuntimeRoomFor<'onuw'>;

type ContextRoom<G extends GameId> = Omit<RuntimeRoomFor<G>, 'touchedAt' | 'subscribers' | 'timer'>
  & { touchedAt?: number; subscribers?: Set<Subscription>; timer?: NodeJS.Timeout | null };
export type AvalonContext = {
  room: ContextRoom<'avalon'>;
  state: AvalonState;
};
export type OnuwContext = {
  room: ContextRoom<'onuw'>;
  state: OnuwState;
};
export type GameContext = AvalonContext | OnuwContext;

/** A seat this browser holds, remembered so a reload can offer it back. */
export type StoredSeat = { id: string; name: string };

export type { CreateRoomCommand, JoinCommand, ValidatedAction };
export type AvalonCommand = AvalonAction;
export type OnuwCommand = OnuwAction;
type ActorOptional<T> = T extends { playerId: string }
  ? Omit<T, 'playerId'> & { playerId?: string }
  : T;
type InternalJoinCommand = { type: 'join'; id: string; name: string; playerId?: string };
export type RoomCommand = ActorOptional<ValidatedAction> | InternalJoinCommand;

export interface PublicViewBase<G extends GameId, P extends GamePhase> {
  code: string;
  gameId: G;
  phase: P;
  version: number;
  hostId: string | null;
  me: null | { id: string; name: string; avatar: string | null };
  log: LogEntry[];
}
export type SharedViewFor<C extends GameContext> = PublicViewBase<C['room']['game']['id'], C['state']['phase']>;

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
type OnuwNightYou = OnuwYou & { awake: boolean; action?: string; acted: boolean };
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
type PublicViewFor<G extends GameId> = G extends 'avalon' ? AvalonView : OnuwView;

export interface GameEntry<G extends GameId> {
  id: G;
  minPlayers: number;
  maxPlayers: number;
  create(code: string, options?: { now?: () => number; seed?: number }): CreatedRoomFor<G>;
  rosterChange(
    room: RuntimeRoomFor<G>,
    type: 'join' | 'leave',
    player: { id: string; name?: string; avatar?: string },
  ): unknown;
  command(
    room: RuntimeRoomFor<G>,
    playerId: string,
    body: RoomCommand,
    operationContext: { now: () => number },
  ): unknown;
  view(room: RuntimeRoomFor<G>, playerId: string, now: number): PublicViewFor<G>;
  deadline(room: RuntimeRoomFor<G>): number | null;
  tick(room: RuntimeRoomFor<G>, now: number): boolean;
}

export interface RoomRegistry {
  snapshot(): PersistedRoom[];
  restore(entries: unknown): boolean;
}
