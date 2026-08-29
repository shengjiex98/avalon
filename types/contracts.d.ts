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
  /**
   * The viewer's own seat. Optional because `baseView` does not build it: each
   * game adds its own wider `you` on top, and that is what reaches the client.
   */
  you?: null | ({ id: string; name: string; avatar: string | null } & Record<string, unknown>);
  /** Every seat in the room, in seat order. Added by each game, like `you`. */
  players?: ({ id: string; name: string; avatar: string | null; seat: number }
    & Record<string, unknown>)[];
  log: LogEntry[];
  [field: string]: unknown;
}
export type SharedViewFor<C extends GameContext> = PublicViewBase<C['gameId'], C['phase']>;

export type AvalonView = PublicViewBase<'avalon', AvalonPhase>;
export type OnuwView = PublicViewBase<'onuw', OnuwPhase>;
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
