// What every game in this repo does the same way: people join a room, one of
// them hosts, and things that happen get written to a log.
//
// This is shared code, not a framework. Each game keeps its own state machine
// and simply calls these for the parts that are genuinely identical.

// @ts-check

import { randomInt } from 'node:crypto';

/** @typedef {import('../types/contracts.js').GameContext} GameContext */
/** @typedef {import('../types/contracts.js').GameId} GameId */
/** @typedef {import('../types/contracts.js').Player} Player */
/** @typedef {import('../types/contracts.js').RoomCommand} RoomCommand */

export class GameError extends Error {
  /** @param {string} key @param {Record<string, unknown>} [params] */
  constructor(key, params = {}) {
    super(key);
    this.key = key;
    this.params = params;
  }
}

/** @param {unknown} cond @param {string} key @param {Record<string, unknown>} [params] @returns {asserts cond} */
export function require_(cond, key, params) {
  if (!cond) throw new GameError(key, params);
}

/** The fields every game's state starts with. */
/**
 * @param {string} code
 * @template {GameId} G
 * @param {G} gameId
 * @param {{ now?: () => number, seed?: number }} [options]
 * @returns {import('../types/contracts.js').BaseGameState<G>}
 */
export function baseState(code, gameId, { now = Date.now, seed = randomInt(0, 0x100000000) } = {}) {
  seed >>>= 0;
  return {
    code,
    gameId,
    seed,
    rng: seed,
    createdAt: now(),
    phase: 'lobby',
    players: [],        // [{ id, name }] in seating order
    hostId: null,
    log: [],
    actions: [],
    version: 0,
  };
}

/** Append one successful player input without retaining transport-only fields. */
/** @param {GameContext} g @param {string} playerId @param {RoomCommand} body @param {number} at */
export function record(g, playerId, body, at) {
  if (g.actionsDropped) return;
  if (g.actions.length >= 2000) {
    g.actions = [];
    g.actionsDropped = true;
    return;
  }
  const { type, playerId: _transportPlayerId, ...rest } = body;
  g.actions.push({ t: type, p: playerId, b: rest, at });
}

/** Mulberry32. State is a uint32 in g.rng, so a snapshot resumes the exact stream. */
/** @param {GameContext} g */
function nextRand(g) {
  g.rng = (g.rng + 0x6d2b79f5) >>> 0;
  let t = g.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** @param {GameContext} g @param {number} n */
export const randInt = (g, n) => Math.floor(nextRand(g) * n);

/** Fisher-Yates backed by the random stream stored in game state. */
/** @template T @param {GameContext} g @param {T[]} list @returns {T[]} */
export function shuffleWith(g, list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(g, i + 1);
    const left = /** @type {T} */ (a[i]);
    const right = /** @type {T} */ (a[j]);
    a[i] = right;
    a[j] = left;
  }
  return a;
}

/** @param {GameContext} g @param {string} id */
export const playerById = (g, id) => g.players.find((p) => p.id === id);

/** @param {GameContext} g @param {string} key @param {Record<string, unknown>} [params] */
export function logEvent(g, key, params = {}) {
  g.log.push({ key, params, at: g.log.length });
}

/**
 * @param {GameContext} g
 * @param {{ id: string, name?: string, avatar?: string }} player
 * @param {{ maxPlayers: number }} limits
 * @returns {Player}
 */
export function addPlayer(g, { id, name, avatar }, { maxPlayers }) {
  const existing = playerById(g, id);
  if (existing) {                       // reconnect keeps the seat and the role
    if (name && name !== existing.name) existing.name = name;
    if (avatar !== undefined) existing.avatar = avatar;
    return existing;
  }
  require_(g.phase === 'lobby', 'gameAlreadyStarted');
  require_(g.players.length < maxPlayers, 'roomFull', { max: maxPlayers });
  const clean = String(name ?? '').trim().slice(0, 24);
  require_(clean.length > 0, 'nameRequired');
  require_(!g.players.some((p) => p.name.toLowerCase() === clean.toLowerCase()), 'nameTaken');

  const player = { id, name: clean, ...(avatar ? { avatar } : {}) };
  g.players.push(player);
  if (!g.hostId) g.hostId = id;
  logEvent(g, 'log.joined', { name: clean });
  return player;
}

/** @param {GameContext} g @param {string} id */
export function removePlayer(g, id) {
  require_(g.phase === 'lobby', 'cannotLeaveMidGame');
  const player = playerById(g, id);
  if (!player) return;
  g.players = g.players.filter((p) => p.id !== id);
  logEvent(g, 'log.left', { name: player.name });
  if (g.hostId === id) g.hostId = g.players[0]?.id ?? null;
}

// ------------------------------------------------------- house rules

/**
 * The house rules in force, given the keys this game offers. A key the stored
 * rules do not mention is off: a table that never agreed to a variant keeps
 * the game it started under, even when the server it is restored onto now
 * offers one.
 */
/** @param {GameContext} g @param {string[]} keys */
export const houseRulesInForce = (g, keys) => ({
  ...Object.fromEntries(keys.map((rule) => [rule, false])),
  ...g.houseRules,
});

/** Switch the rules the host named, leaving keys this game does not offer alone. */
/** @param {GameContext} g @param {Record<string, unknown>} requested @param {string[]} keys */
export function setHouseRules(g, requested, keys) {
  const rules = houseRulesInForce(g, keys);
  for (const rule of keys) {
    if (rule in requested) rules[rule] = Boolean(requested[rule]);
  }
  g.houseRules = rules;
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
function rebuildLobby(g, prepare) {
  const { fresh, keep } = prepare();
  const carried = {
    code: g.code, players: g.players, hostId: g.hostId,
    seed: g.seed, rng: g.rng, actions: g.actions,
    ...(g.actionsDropped ? { actionsDropped: true } : {}),
    ...keep,
  };
  Object.assign(g, fresh, carried, { version: g.version });
  logEvent(g, 'log.newGame', {});
}

/** Back to the lobby after a completed game, with the same table. */
/** @param {GameContext} g @param {string} playerId @param {() => { fresh: GameContext, keep: Record<string, unknown> }} prepare */
export function resetToLobby(g, playerId, prepare) {
  require_(playerId === g.hostId, 'hostOnly');
  require_(g.phase === 'over', 'gameInProgress');
  rebuildLobby(g, prepare);
}

/** Let the host abandon an active game and immediately return to its lobby. */
/** @param {GameContext} g @param {string} playerId @param {() => { fresh: GameContext, keep: Record<string, unknown> }} prepare */
export function restartToLobby(g, playerId, prepare) {
  require_(playerId === g.hostId, 'hostOnly');
  require_(g.phase !== 'lobby' && g.phase !== 'over', 'wrongPhase');
  rebuildLobby(g, prepare);
}

/** The part of a view that looks the same in every game. */
/**
 * @template {GameContext} C
 * @param {C} g
 * @param {string} viewerId
 * @returns {import('../types/contracts.js').SharedViewFor<C>}
 */
export function baseView(g, viewerId) {
  const me = playerById(g, viewerId);
  return {
    code: g.code,
    gameId: g.gameId,
    phase: g.phase,
    version: g.version,
    hostId: g.hostId,
    me: me ? { id: me.id, name: me.name, avatar: me.avatar ?? null } : null,
    log: g.log.slice(-40),
  };
}
