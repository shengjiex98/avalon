// The registry is the room/game boundary. It gives game modules an explicit
// view of the shared room and the engine-owned state while an operation runs.

import { parseAction } from '../commands.ts';
import { GameError } from '../errors.ts';
import * as avalon from './avalon/game.ts';
import { MAX_PLAYERS as AVALON_MAX, MIN_PLAYERS as AVALON_MIN } from './avalon/rules.ts';
import * as onuw from './onuw/game.ts';
import { MAX_PLAYERS as ONUW_MAX, MIN_PLAYERS as ONUW_MIN } from './onuw/rules.ts';
import type { GameId } from '../../contracts/actions.ts';
import type {
  AvalonCommand, AvalonContext, CreatedRoomFor, GameEntry, OnuwCommand, OnuwContext,
  RoomCommand, RuntimeRoomFor,
} from '../runtime.ts';
import type { AvalonView, OnuwView } from '../../contracts/views.ts';

type OperationContext = { now: () => number };
type PlayerInput = { id: string; name?: string; avatar?: string };
type AvalonBody<T extends AvalonCommand['type']> = Extract<AvalonCommand, { type: T }>;
type OnuwBody<T extends OnuwCommand['type']> = Extract<OnuwCommand, { type: T }>;
type AvalonEntry = GameEntry<'avalon'> & {
  view: (room: RuntimeRoomFor<'avalon'>, playerId: string, now: number) => AvalonView;
  addPlayer: typeof avalon.addPlayer;
  removePlayer: typeof avalon.removePlayer;
  viewFor: typeof avalon.viewFor;
  actions: typeof avalonActions;
};
type OnuwEntry = GameEntry<'onuw'> & {
  view: (room: RuntimeRoomFor<'onuw'>, playerId: string, now: number) => OnuwView;
  addPlayer: typeof onuw.addPlayer;
  removePlayer: typeof onuw.removePlayer;
  viewFor: typeof onuw.viewFor;
  nextDeadline: typeof onuw.nextDeadline;
  actions: typeof onuwActions;
};

function avalonContext(room: RuntimeRoomFor<'avalon'>): AvalonContext {
  return { room, state: room.game.state };
}

function onuwContext(room: RuntimeRoomFor<'onuw'>): OnuwContext {
  return { room, state: room.game.state };
}

const avalonActions = {
  options: (g: AvalonContext, id: string, body: AvalonBody<'options'>) =>
    avalon.setOptions(g, id, body.options),
  start: (g: AvalonContext, id: string) => avalon.startGame(g, id),
  confirm: (g: AvalonContext, id: string) => avalon.confirmRole(g, id),
  propose: (g: AvalonContext, id: string, body: AvalonBody<'propose'>) =>
    avalon.proposeTeam(g, id, body.team),
  vote: (g: AvalonContext, id: string, body: AvalonBody<'vote'>) =>
    avalon.castVote(g, id, body.approve),
  card: (g: AvalonContext, id: string, body: AvalonBody<'card'>) =>
    avalon.playCard(g, id, body.success),
  assassinate: (g: AvalonContext, id: string, body: AvalonBody<'assassinate'>) =>
    avalon.assassinate(g, id, body.target),
  reset: (g: AvalonContext, id: string, _body?: AvalonBody<'reset'>, context?: OperationContext) =>
    avalon.restartToLobby(g, id, context),
  again: (g: AvalonContext, id: string, _body?: AvalonBody<'again'>, context?: OperationContext) =>
    avalon.resetToLobby(g, id, context),
};

const onuwActions = {
  options: (g: OnuwContext, id: string, body: OnuwBody<'options'>) =>
    onuw.setOptions(g, id, body.options),
  start: (g: OnuwContext, id: string, _body?: OnuwBody<'start'>, context?: OperationContext) =>
    onuw.startGame(g, id, context),
  confirm: (g: OnuwContext, id: string, _body?: OnuwBody<'confirm'>, context?: OperationContext) =>
    onuw.confirmRole(g, id, context),
  night: (g: OnuwContext, id: string, body: OnuwBody<'night'>) =>
    onuw.submitNight(g, id, body.action),
  startVote: (g: OnuwContext, id: string) => onuw.startVote(g, id),
  vote: (g: OnuwContext, id: string, body: OnuwBody<'vote'>) =>
    onuw.castVote(g, id, body.target),
  reset: (g: OnuwContext, id: string, _body?: OnuwBody<'reset'>, context?: OperationContext) =>
    onuw.restartToLobby(g, id, context),
  again: (g: OnuwContext, id: string, _body?: OnuwBody<'again'>, context?: OperationContext) =>
    onuw.resetToLobby(g, id, context),
};

const avalonEntry: AvalonEntry = {
  id: 'avalon',
  minPlayers: AVALON_MIN,
  maxPlayers: AVALON_MAX,
  create: (code: string, options?: { now?: () => number; seed?: number }): CreatedRoomFor<'avalon'> =>
    avalon.createGame(code, options).room,
  rosterChange(room: RuntimeRoomFor<'avalon'>, type: 'join' | 'leave', player: PlayerInput) {
    const context = avalonContext(room);
    if (type === 'join') return avalon.addPlayer(context, player);
    return avalon.removePlayer(context, player.id);
  },
  command(room: RuntimeRoomFor<'avalon'>, playerId: string, body: RoomCommand, operationContext: OperationContext) {
    const context = avalonContext(room);
    const action = parseAction('avalon', { ...body, playerId });
    switch (action.type) {
      case 'options': return avalonActions.options(context, playerId, action);
      case 'start': return avalonActions.start(context, playerId);
      case 'confirm': return avalonActions.confirm(context, playerId);
      case 'propose': return avalonActions.propose(context, playerId, action);
      case 'vote': return avalonActions.vote(context, playerId, action);
      case 'card': return avalonActions.card(context, playerId, action);
      case 'assassinate': return avalonActions.assassinate(context, playerId, action);
      case 'reset': return avalonActions.reset(context, playerId, action, operationContext);
      case 'again': return avalonActions.again(context, playerId, action, operationContext);
      default: throw new GameError('unknownAction', { type: action.type });
    }
  },
  view: (room: RuntimeRoomFor<'avalon'>, playerId: string, _now: number) =>
    avalon.viewFor(avalonContext(room), playerId),
  deadline: (_room: RuntimeRoomFor<'avalon'>): number | null => null,
  tick: (_room: RuntimeRoomFor<'avalon'>, _now: number): boolean => false,
  addPlayer: avalon.addPlayer,
  removePlayer: avalon.removePlayer,
  viewFor: avalon.viewFor,
  actions: avalonActions,
};

const onuwEntry: OnuwEntry = {
  id: 'onuw',
  minPlayers: ONUW_MIN,
  maxPlayers: ONUW_MAX,
  create: (code: string, options?: { now?: () => number; seed?: number }): CreatedRoomFor<'onuw'> =>
    onuw.createGame(code, options).room,
  rosterChange(room: RuntimeRoomFor<'onuw'>, type: 'join' | 'leave', player: PlayerInput) {
    const context = onuwContext(room);
    if (type === 'join') return onuw.addPlayer(context, player);
    return onuw.removePlayer(context, player.id);
  },
  command(room: RuntimeRoomFor<'onuw'>, playerId: string, body: RoomCommand, operationContext: OperationContext) {
    const context = onuwContext(room);
    const action = parseAction('onuw', { ...body, playerId });
    switch (action.type) {
      case 'options': return onuwActions.options(context, playerId, action);
      case 'start': return onuwActions.start(context, playerId, action, operationContext);
      case 'confirm': return onuwActions.confirm(context, playerId, action, operationContext);
      case 'night': return onuwActions.night(context, playerId, action);
      case 'startVote': return onuwActions.startVote(context, playerId);
      case 'vote': return onuwActions.vote(context, playerId, action);
      case 'reset': return onuwActions.reset(context, playerId, action, operationContext);
      case 'again': return onuwActions.again(context, playerId, action, operationContext);
      default: throw new GameError('unknownAction', { type: action.type });
    }
  },
  view: (room: RuntimeRoomFor<'onuw'>, playerId: string, now: number) =>
    onuw.viewFor(onuwContext(room), playerId, now),
  deadline: (room: RuntimeRoomFor<'onuw'>): number | null => onuw.nextDeadline(onuwContext(room)),
  tick: (room: RuntimeRoomFor<'onuw'>, now: number): boolean => onuw.tick(onuwContext(room), now),
  addPlayer: onuw.addPlayer,
  removePlayer: onuw.removePlayer,
  viewFor: onuw.viewFor,
  nextDeadline: onuw.nextDeadline,
  actions: onuwActions,
};

export const GAMES = { avalon: avalonEntry, onuw: onuwEntry };
export const DEFAULT_GAME: GameId = 'avalon';
export const GAME_IDS = ['avalon', 'onuw'] satisfies GameId[];

export function gameFor(id: 'avalon'): typeof avalonEntry;
export function gameFor(id: 'onuw'): typeof onuwEntry;
export function gameFor(id: GameId): AvalonEntry | OnuwEntry;
export function gameFor(id: unknown): AvalonEntry | OnuwEntry;
export function gameFor(id: unknown): AvalonEntry | OnuwEntry {
  if (id === 'avalon') return avalonEntry;
  if (id === 'onuw') return onuwEntry;
  throw new GameError('noSuchGame', { game: id });
}
