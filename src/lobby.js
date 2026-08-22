// What every game in this repo does the same way: people join a room, one of
// them hosts, and things that happen get written to a log.
//
// This is shared code, not a framework. Each game keeps its own state machine
// and simply calls these for the parts that are genuinely identical.

export class GameError extends Error {
  constructor(key, params = {}) {
    super(key);
    this.key = key;
    this.params = params;
  }
}

export function require_(cond, key, params) {
  if (!cond) throw new GameError(key, params);
}

/** The fields every game's state starts with. */
export function baseState(code, gameId, { now = Date.now } = {}) {
  return {
    code,
    gameId,
    createdAt: now(),
    phase: 'lobby',
    players: [],        // [{ id, name }] in seating order
    hostId: null,
    log: [],
    version: 0,
  };
}

export const playerById = (g, id) => g.players.find((p) => p.id === id);

export function logEvent(g, key, params = {}) {
  g.log.push({ key, params, at: g.log.length });
}

export function addPlayer(g, { id, name }, { maxPlayers }) {
  const existing = playerById(g, id);
  if (existing) {                       // reconnect keeps the seat and the role
    if (name && name !== existing.name) existing.name = name;
    return existing;
  }
  require_(g.phase === 'lobby', 'gameAlreadyStarted');
  require_(g.players.length < maxPlayers, 'roomFull', { max: maxPlayers });
  const clean = String(name ?? '').trim().slice(0, 24);
  require_(clean.length > 0, 'nameRequired');
  require_(!g.players.some((p) => p.name.toLowerCase() === clean.toLowerCase()), 'nameTaken');

  const player = { id, name: clean };
  g.players.push(player);
  if (!g.hostId) g.hostId = id;
  logEvent(g, 'log.joined', { name: clean });
  return player;
}

export function removePlayer(g, id) {
  require_(g.phase === 'lobby', 'cannotLeaveMidGame');
  const player = playerById(g, id);
  if (!player) return;
  g.players = g.players.filter((p) => p.id !== id);
  logEvent(g, 'log.left', { name: player.name });
  if (g.hostId === id) g.hostId = g.players[0]?.id ?? null;
}

/** Fisher-Yates, so a caller can inject a deterministic shuffle in tests. */
export function defaultShuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** The part of a view that looks the same in every game. */
export function baseView(g, viewerId) {
  const me = playerById(g, viewerId);
  return {
    code: g.code,
    gameId: g.gameId,
    phase: g.phase,
    version: g.version,
    hostId: g.hostId,
    me: me ? { id: me.id, name: me.name } : null,
    log: g.log.slice(-40),
  };
}
