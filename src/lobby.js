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

/** The shared room fields every game starts with. */
/**
 * @param {string} code
 * @param {GameId} gameId
 * @param {import('../types/contracts.js').AvalonState | import('../types/contracts.js').OnuwState} state
 * @param {{ now?: () => number, seed?: number }} [options]
 * @returns {import('../types/contracts.js').CreatedRoom}
 */
export function baseRoom(code, gameId, state, { now = Date.now, seed = randomInt(0, 0x100000000) } = {}) {
  seed >>>= 0;
  return /** @type {import('../types/contracts.js').CreatedRoom} */ (/** @type {unknown} */ ({
    code,
    seed,
    rng: seed,
    createdAt: now(),
    players: [],        // [{ id, name }] in seating order
    hostId: null,
    log: [],
    journal: [],
    revision: 0,
    game: { id: gameId, state },
  }));
}

/** Append one successful player input without retaining transport-only fields. */
/** @param {GameContext} g @param {string} playerId @param {RoomCommand} body @param {number} at */
export function record(g, playerId, body, at) {
  if (g.room.journalDropped) return;
  if (g.room.journal.length >= 2000) {
    g.room.journal = [];
    g.room.journalDropped = true;
    return;
  }
  const { type, playerId: _transportPlayerId, ...rest } = body;
  g.room.journal.push({ t: type, p: playerId, b: rest, at });
}

/** Mulberry32. The room's uint32 state lets a snapshot resume the exact stream. */
/** @param {GameContext} g */
function nextRand(g) {
  g.room.rng = (g.room.rng + 0x6d2b79f5) >>> 0;
  let t = g.room.rng;
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
export const playerById = (g, id) => g.room.players.find((p) => p.id === id);

/** @param {GameContext} g @param {string} key @param {Record<string, unknown>} [params] */
export function logEvent(g, key, params = {}) {
  g.room.log.push({ key, params, at: g.room.log.length });
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

/** @param {GameContext} g @param {string} id */
export function removePlayer(g, id) {
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
/** @param {GameContext} g @param {string[]} keys */
export const houseRulesInForce = (g, keys) => ({
  ...Object.fromEntries(keys.map((rule) => [rule, false])),
  ...g.state.houseRules,
});

/** Switch the rules the host named, leaving keys this game does not offer alone. */
/** @param {GameContext} g @param {Record<string, unknown>} requested @param {string[]} keys */
export function setHouseRules(g, requested, keys) {
  const rules = houseRulesInForce(g, keys);
  for (const rule of keys) {
    if (rule in requested) rules[rule] = Boolean(requested[rule]);
  }
  g.state.houseRules = rules;
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
    code: g.room.code, players: g.room.players, hostId: g.room.hostId,
    seed: g.room.seed, rng: g.room.rng, journal: g.room.journal,
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
export function resetToLobby(g, playerId, prepare) {
  require_(playerId === g.room.hostId, 'hostOnly');
  require_(g.state.phase === 'over', 'gameInProgress');
  rebuildLobby(g, prepare);
}

/** Let the host abandon an active game and immediately return to its lobby. */
/** @param {GameContext} g @param {string} playerId @param {() => { fresh: GameContext, keep: Record<string, unknown> }} prepare */
export function restartToLobby(g, playerId, prepare) {
  require_(playerId === g.room.hostId, 'hostOnly');
  require_(g.state.phase !== 'lobby' && g.state.phase !== 'over', 'wrongPhase');
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
    code: g.room.code,
    gameId: g.room.game.id,
    phase: g.state.phase,
    version: g.room.revision,
    hostId: g.room.hostId,
    me: me ? { id: me.id, name: me.name, avatar: me.avatar ?? null } : null,
    log: g.room.log.slice(-40),
  };
}
