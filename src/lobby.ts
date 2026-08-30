// What every game in this repo does the same way: people join a room, one of
// them hosts, and things that happen get written to a log.
//
// This is shared code, not a framework. Each game keeps its own state machine
// and simply calls these for the parts that are genuinely identical.

import { randomInt } from 'node:crypto';
import type { GameId } from './contracts/actions.ts';
import type { AvalonState, OnuwState, Player } from './contracts/persistence.ts';
import type {
  AvalonContext, CreatedRoom, CreatedRoomFor, GameContext, OnuwContext, RoomCommand,
  SharedViewFor,
} from './contracts/runtime.ts';

export class GameError extends Error {
  key: string;
  params: Record<string, unknown>;

  constructor(key: string, params: Record<string, unknown> = {}) {
    super(key);
    this.key = key;
    this.params = params;
  }
}

export function require_(cond: unknown, key: string, params?: Record<string, unknown>): asserts cond {
  if (!cond) throw new GameError(key, params);
}

type CreateOptions = { now?: () => number; seed?: number };
/** The shared room fields every game starts with. */
export function baseRoom(
  code: string, gameId: 'avalon', state: AvalonState, options?: CreateOptions,
): CreatedRoomFor<'avalon'>;
export function baseRoom(
  code: string, gameId: 'onuw', state: OnuwState, options?: CreateOptions,
): CreatedRoomFor<'onuw'>;
export function baseRoom(
  code: string,
  gameId: GameId,
  state: AvalonState | OnuwState,
  { now = Date.now, seed: suppliedSeed = randomInt(0, 0x100000000) }: CreateOptions = {},
): CreatedRoom {
  let seed = suppliedSeed;
  seed >>>= 0;
  const shared = {
    seed,
    rng: seed,
    createdAt: now(),
    players: [],        // [{ id, name }] in seating order
    hostId: null,
    log: [],
    journal: [],
    revision: 0,
  };
  if (gameId === 'avalon') {
    if (!('roles' in state)) throw new GameError('noSuchGame', { game: gameId });
    return { code, ...shared, game: { id: gameId, state } };
  }
  if ('roles' in state) throw new GameError('noSuchGame', { game: gameId });
  return { code, ...shared, game: { id: gameId, state } };
}

/** Append one successful player input without retaining transport-only fields. */
export function record(g: GameContext, playerId: string, body: RoomCommand, at: number): void {
  if (g.room.journalDropped) return;
  if (g.room.journal.length >= 2000) {
    g.room.journal = [];
    g.room.journalDropped = true;
    return;
  }
  const { type, ...rest } = body;
  if ('playerId' in rest) delete rest.playerId;
  g.room.journal.push({ t: type, p: playerId, b: rest, at });
}

/** Mulberry32. The room's uint32 state lets a snapshot resume the exact stream. */
function nextRand(g: GameContext): number {
  g.room.rng = (g.room.rng + 0x6d2b79f5) >>> 0;
  let t = g.room.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export const randInt = (g: GameContext, n: number): number => Math.floor(nextRand(g) * n);

/** Fisher-Yates backed by the random stream stored in game state. */
export function shuffleWith<T>(g: GameContext, list: T[]): T[] {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(g, i + 1);
    const left = a[i]!;
    const right = a[j]!;
    a[i] = right;
    a[j] = left;
  }
  return a;
}

export const playerById = (g: GameContext, id: string): Player | undefined =>
  g.room.players.find((player) => player.id === id);

export function logEvent(
  g: GameContext,
  key: string,
  params: Record<string, unknown> = {},
): void {
  g.room.log.push({ key, params, at: g.room.log.length });
}

type ResultSide = 'good' | 'evil' | 'village' | 'werewolf' | 'tanner';
type ResultPlayer = { id: string; name: string; side: ResultSide; won: boolean };

/** Keep the verdict, but not anyone's character, for the life of the room. */
export function recordGameResult(g: GameContext, players: ResultPlayer[]): void {
  const resultPlayer = ({ id, name, side }: ResultPlayer) => ({ id, name, side });
  logEvent(g, 'log.gameResult', {
    winners: players.filter((player) => player.won).map(resultPlayer),
    losers: players.filter((player) => !player.won).map(resultPlayer),
  });
}

/**
 * @param {GameContext} g
 * @param {{ id: string, name?: string, avatar?: string }} player
 * @param {{ maxPlayers: number }} limits
 * @returns {Player}
 */
export function addPlayer(
  g: GameContext,
  { id, name, avatar }: { id: string; name?: string; avatar?: string },
  { maxPlayers }: { maxPlayers: number },
): Player {
  const existing = playerById(g, id);
  if (existing) {                       // reconnect keeps the seat and the role
    if (name && name !== existing.name) existing.name = name;
    if (avatar !== undefined) existing.avatar = avatar;
    return existing;
  }
  require_(g.state.phase === 'lobby', 'gameAlreadyStarted');
  require_(g.room.players.length < maxPlayers, 'roomFull', { max: maxPlayers });
  const clean = String(name ?? '').trim().slice(0, 24);
  require_(clean.length > 0, 'nameRequired');
  require_(!g.room.players.some((p) => p.name.toLowerCase() === clean.toLowerCase()), 'nameTaken');

  const player = { id, name: clean, ...(avatar ? { avatar } : {}) };
  g.room.players.push(player);
  if (!g.room.hostId) g.room.hostId = id;
  logEvent(g, 'log.joined', { name: clean });
  return player;
}

export function removePlayer(g: GameContext, id: string): void {
  require_(g.state.phase === 'lobby', 'cannotLeaveMidGame');
  const player = playerById(g, id);
  if (!player) return;
  g.room.players = g.room.players.filter((p) => p.id !== id);
  logEvent(g, 'log.left', { name: player.name });
  if (g.room.hostId === id) g.room.hostId = g.room.players[0]?.id ?? null;
}

// ------------------------------------------------------- house rules

/**
 * The house rules in force, given the keys this game offers. A key the stored
 * rules do not mention is off: a table that never agreed to a variant keeps
 * the game it started under, even when the server it is restored onto now
 * offers one.
 */
export function houseRulesInForce(
  g: AvalonContext,
  keys: string[],
): AvalonState['houseRules'];
export function houseRulesInForce(
  g: OnuwContext,
  keys: string[],
): OnuwState['houseRules'];
export function houseRulesInForce(g: GameContext, keys: string[]): Record<string, boolean>;
export function houseRulesInForce(g: GameContext, keys: string[]): Record<string, boolean> {
  return {
    ...Object.fromEntries(keys.map((rule) => [rule, false])),
    ...g.state.houseRules,
  };
}

/** Switch the rules the host named, leaving keys this game does not offer alone. */
export function setHouseRules(
  g: GameContext,
  requested: Record<string, unknown>,
  keys: string[],
): void {
  const rules = houseRulesInForce(g, keys);
  const mutable: Record<string, boolean> = rules;
  for (const rule of keys) {
    if (rule in requested) mutable[rule] = Boolean(requested[rule]);
  }
  Object.assign(g.state.houseRules, rules);
}

// ------------------------------------------------------- back to the lobby

/**
 * Put the same table back in a lobby. Preparing replacement state happens here
 * so a rejected request cannot run game construction. The revision survives:
 * a room's version only ever counts up, whatever happens inside it.
 */
/**
 * @param {GameContext} g
 * @param {() => { fresh: GameContext, keep: Record<string, unknown> }} prepare
 */
function rebuildLobby<C extends GameContext>(
  g: C,
  prepare: () => { fresh: C; keep: Partial<C['state']> },
): void {
  const { fresh, keep } = prepare();
  const carried = {
    code: g.room.code, players: g.room.players, hostId: g.room.hostId,
    seed: g.room.seed, rng: g.room.rng, journal: g.room.journal,
    log: g.room.log.filter((entry) => entry.key === 'log.gameResult'),
    ...(g.room.journalDropped ? { journalDropped: true } : {}),
  };
  const revision = g.room.revision;
  Object.assign(fresh.state, keep);
  Object.assign(g.room, fresh.room, carried, { revision });
  g.state = fresh.state;
  logEvent(g, 'log.newGame', {});
}

/** Back to the lobby after a completed game, with the same table. */
/** @param {GameContext} g @param {string} playerId @param {() => { fresh: GameContext, keep: Record<string, unknown> }} prepare */
export function resetToLobby<C extends GameContext>(
  g: C,
  playerId: string,
  prepare: () => { fresh: C; keep: Partial<C['state']> },
): void {
  require_(playerId === g.room.hostId, 'hostOnly');
  require_(g.state.phase === 'over', 'gameInProgress');
  rebuildLobby(g, prepare);
}

/** Let the host abandon an active game and immediately return to its lobby. */
/** @param {GameContext} g @param {string} playerId @param {() => { fresh: GameContext, keep: Record<string, unknown> }} prepare */
export function restartToLobby<C extends GameContext>(
  g: C,
  playerId: string,
  prepare: () => { fresh: C; keep: Partial<C['state']> },
): void {
  require_(playerId === g.room.hostId, 'hostOnly');
  require_(g.state.phase !== 'lobby' && g.state.phase !== 'over', 'wrongPhase');
  rebuildLobby(g, prepare);
}

/** The part of a view that looks the same in every game. */
/**
 * @template {GameContext} C
 * @param {C} g
 * @param {string} viewerId
 * @returns {import('./contracts/runtime.ts').SharedViewFor<C>}
 */
export function baseView(g: AvalonContext, viewerId: string): SharedViewFor<AvalonContext>;
export function baseView(g: OnuwContext, viewerId: string): SharedViewFor<OnuwContext>;
export function baseView(
  g: GameContext,
  viewerId: string,
): SharedViewFor<AvalonContext> | SharedViewFor<OnuwContext> {
  const me = playerById(g, viewerId);
  const shared = {
    code: g.room.code,
    version: g.room.revision,
    hostId: g.room.hostId,
    me: me ? { id: me.id, name: me.name, avatar: me.avatar ?? null } : null,
    log: visibleLog(g),
  };
  if (g.room.game.id === 'avalon') {
    if (!('roles' in g.state)) throw new GameError('noSuchGame', { game: g.room.game.id });
    return { ...shared, gameId: g.room.game.id, phase: g.state.phase };
  }
  if ('roles' in g.state) throw new GameError('noSuchGame', { game: g.room.game.id });
  return { ...shared, gameId: g.room.game.id, phase: g.state.phase };
}

/** Completed-game verdicts never fall off the report; only event detail is capped. */
function visibleLog(g: GameContext) {
  let ordinary = 0;
  let firstRecent = 0;
  for (let i = g.room.log.length - 1; i >= 0; i--) {
    if (g.room.log[i]!.key === 'log.gameResult') continue;
    ordinary += 1;
    if (ordinary === 40) { firstRecent = i; break; }
  }
  return g.room.log.filter((entry, index) => entry.key === 'log.gameResult' || index >= firstRecent);
}
