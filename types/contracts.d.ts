export type GameId = 'avalon' | 'onuw';
export type AvalonPhase = 'lobby' | 'reveal' | 'team' | 'vote' | 'quest' | 'assassin' | 'over';
export type OnuwPhase = 'lobby' | 'reveal' | 'night' | 'day' | 'vote' | 'over';
export type GamePhase = AvalonPhase | OnuwPhase;

export interface Player {
  id: string;
  name: string;
  avatar?: string;
}

export interface LogEntry {
  key: string;
  params: Record<string, unknown>;
  at: number;
}

export interface JournalEntry {
  t: string;
  p: string;
  b: Record<string, unknown>;
  at: number;
}

export interface EngineShared {
  code: string;
  gameId: GameId;
  createdAt: number;
  players: Player[];
  hostId: string | null;
  log: LogEntry[];
  seed: number;
  rng: number;
  version: number;
  actions: JournalEntry[];
  actionsDropped?: true;
}
export type BaseGameState<G extends GameId = GameId> = EngineShared & { gameId: G; phase: 'lobby' };

export interface AvalonState {
  phase: AvalonPhase;
  options: Record<string, boolean>;
  optionsTouched: boolean;
  houseRules: Record<string, boolean>;
  roles: Record<string, string>;
  round: number;
  leaderIndex: number;
  rejects: number;
  team: string[];
  votes: Record<string, boolean>;
  lastVote: null | {
    round: number;
    attempt: number;
    team: string[];
    votes: Record<string, boolean>;
    approved: boolean;
  };
  cards: Record<string, boolean>;
  quests: Array<{ round: number; team: string[]; fails: number; success: boolean }>;
  assassinTarget: string | null;
  winner: 'good' | 'evil' | null;
  winReason: string | null;
  ready?: Record<string, boolean>;
}

export interface OnuwScriptStep {
  key: string;
  role?: string;
  seconds: number;
}

export interface GameEvent {
  key: string;
  params: Record<string, unknown>;
}

export interface OnuwNightAction {
  skip?: true;
  centre?: number;
  target?: string;
  targets?: string[];
  mode?: 'player' | 'centre';
  centres?: number[];
}

export interface OnuwState {
  phase: OnuwPhase;
  options: Record<string, boolean>;
  optionsTouched: boolean;
  houseRules: Record<string, boolean>;
  pace: string;
  script: OnuwScriptStep[];
  step: number;
  stepEndsAt: number;
  ready: Record<string, boolean>;
  startRoles: Record<string, string>;
  centreStart: string[];
  finalRoles: Record<string, string>;
  centre: string[];
  nightActions: Record<string, OnuwNightAction>;
  info: Record<string, GameEvent[]>;
  swaps: GameEvent[];
  votes: Record<string, string>;
  dead: string[];
  winners: string[];
}

export type AvalonContext = EngineShared & AvalonState & { gameId: 'avalon' };
export type OnuwContext = EngineShared & OnuwState & { gameId: 'onuw' };
export type GameContext = AvalonContext | OnuwContext;

interface PersistedRoomBase {
  code: string;
  createdAt: number;
  players: Player[];
  hostId: string | null;
  log: LogEntry[];
  seed: number;
  rng: number;
  revision: number;
  journal: JournalEntry[];
  journalDropped?: true;
  touchedAt: number;
}

export type PersistedRoom = PersistedRoomBase & (
  | { game: { id: 'avalon'; state: AvalonState } }
  | { game: { id: 'onuw'; state: OnuwState } }
);
export type CreatedRoom = Omit<PersistedRoom, 'touchedAt'>;

export interface Subscription {
  playerId: string;
  send: (view: PublicView) => void;
}

export type RuntimeRoom = PersistedRoom & {
  subscribers: Set<Subscription>;
  timer: NodeJS.Timeout | null;
};

export interface SnapshotFile {
  stateVersion: number;
  savedAt: number;
  rooms: PersistedRoom[];
}

/** A seat this browser holds, remembered so a reload can offer it back. */
export type StoredSeat = { id: string; name: string };

export type CreateRoomCommand = { game?: string };
export type JoinCommand = { name: string; playerId?: string; avatar?: string | false };
type PlayerCommand<T extends string> = { type: T; playerId: string };
export type SharedCommand =
  | (PlayerCommand<'setGame'> & { game: string })
  | PlayerCommand<'join'> & { id: string; name: string }
  | PlayerCommand<'leave'>;
export type AvalonCommand =
  | (PlayerCommand<'options'> & { options: Record<string, unknown> })
  | PlayerCommand<'start' | 'confirm' | 'reset' | 'again'>
  | (PlayerCommand<'propose'> & { team: string[] })
  | (PlayerCommand<'vote'> & { approve: boolean })
  | (PlayerCommand<'card'> & { success: boolean })
  | (PlayerCommand<'assassinate'> & { target: string });
export type OnuwCommand =
  | (PlayerCommand<'options'> & { options: Record<string, unknown> })
  | PlayerCommand<'start' | 'confirm' | 'startVote' | 'reset' | 'again'>
  | (PlayerCommand<'night'> & { action: Record<string, unknown> })
  | (PlayerCommand<'vote'> & { target: string });
export type ValidatedAction = SharedCommand | AvalonCommand | OnuwCommand;
export interface RoomCommand {
  type: string;
  playerId?: string;
  id?: string;
  name?: string;
  game?: GameId;
  options?: Record<string, unknown>;
  team?: string[];
  approve?: boolean;
  success?: boolean;
  target?: string;
  action?: Record<string, unknown>;
}

export interface PublicViewBase<G extends GameId, P extends GamePhase> {
  code: string;
  gameId: G;
  phase: P;
  version: number;
  hostId: string | null;
  me: null | { id: string; name: string; avatar: string | null };
  log: LogEntry[];
}
export type SharedViewFor<C extends GameContext> = PublicViewBase<C['gameId'], C['phase']>;

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

export interface GameEntry {
  id: GameId;
  minPlayers: number;
  maxPlayers: number;
  create(code: string, options?: { now?: () => number; seed?: number }): CreatedRoom;
  rosterChange(
    room: RuntimeRoom,
    type: 'join' | 'leave',
    player: { id: string; name?: string; avatar?: string },
  ): unknown;
  command(
    room: RuntimeRoom,
    playerId: string,
    body: RoomCommand,
    operationContext: { now: () => number },
  ): unknown;
  view(room: RuntimeRoom, playerId: string, now: number): PublicView;
  deadline(room: RuntimeRoom): number | null;
  tick(room: RuntimeRoom, now: number): boolean;
  validateRestore(room: PersistedRoom): boolean;
}

export interface RoomRegistry {
  snapshot(): PersistedRoom[];
  restore(entries: unknown): boolean;
}
