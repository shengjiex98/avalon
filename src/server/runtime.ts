import type {
  AvalonAction, ClientAction, GameId, OnuwAction,
} from '../contracts/actions.ts';
import type {
  AvalonState, OnuwState, PersistedRoom,
} from '../contracts/persistence.ts';
import type { PublicView, PublicViewBase, PublicViewFor } from '../contracts/views.ts';

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

export type AvalonCommand = AvalonAction;
export type OnuwCommand = OnuwAction;
type InternalJoinCommand = { type: 'join'; id: string; name: string; playerId?: string };
export type RoomCommand = ClientAction | InternalJoinCommand;

export type SharedViewFor<C extends GameContext> = PublicViewBase<C['room']['game']['id'], C['state']['phase']>;

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
