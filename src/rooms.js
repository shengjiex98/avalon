// Room registry: owns the games, the subscriber lists and expiry.

import { GameError, logEvent, record, require_ } from './lobby.js';
import { DEFAULT_GAME, GAMES, gameFor } from './games/index.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
const IDLE_MS = 6 * 60 * 60 * 1000; // rooms vanish six hours after the last touch
const OVER_GRACE_MS = 3 * 60 * 1000; // finished games stay protected while players read results

const COMMON_ACTIONS = {
  join: (g, id, body) => gameFor(g.gameId).addPlayer(g, { id: body.id ?? id, name: body.name }),
  leave: (g, id) => gameFor(g.gameId).removePlayer(g, id),
};

export class Rooms {
  constructor({ now = Date.now, onMutate } = {}) {
    this.now = now;
    this.onMutate = onMutate;
    this.rooms = new Map(); // code -> { game, subscribers:Set, touchedAt }
  }

  create(gameId = DEFAULT_GAME, { code: requestedCode, seed } = {}) {
    if (!(gameId in GAMES)) throw new GameError('noSuchGame', { game: gameId });
    let code = requestedCode && String(requestedCode).toUpperCase();
    if (!code) do { code = randomCode(); } while (this.rooms.has(code));
    if (this.rooms.has(code)) throw new GameError('badRequest');
    const game = gameFor(gameId).create(code, { now: this.now, seed });
    this.rooms.set(code, { game, subscribers: new Set(), touchedAt: this.now(), timer: null });
    this.onMutate?.();
    return code;
  }

  /**
   * Swap which game a room is playing. The people stay; everything about the
   * previous game is discarded, which is why it is a lobby-only move.
   */
  setGame(code, playerId, gameId) {
    return this.dispatch(code, playerId, { type: 'setGame', game: gameId });
  }

  /** Replace a lobby's engine without replacing its object identity. */
  replaceGame(g, playerId, gameId, now = this.now) {
    if (!(gameId in GAMES)) throw new GameError('noSuchGame', { game: gameId });
    require_(g.phase === 'lobby', 'gameAlreadyStarted');
    require_(playerId === g.hostId, 'hostOnly');
    if (g.gameId === gameId) return;
    const fresh = gameFor(gameId).create(g.code, { now, seed: g.seed });
    const { players, hostId, log, actions, version, seed, rng } = g;
    const actionsDropped = g.actionsDropped;
    for (const key of Object.keys(g)) delete g[key];
    Object.assign(g, fresh, { players, hostId, log, actions, version, seed, rng });
    if (actionsDropped) g.actionsDropped = true;
    logEvent(g, 'log.gameSwitched', { game: gameId });
  }

  /** The one entry point for player input. Applies successfully, then records. */
  dispatch(code, playerId, body) {
    return this.apply(code, (g) => {
      if (!g.players.some((p) => p.id === playerId) && body.type !== 'join') {
        throw new GameError('notInGame');
      }
      const at = this.now();
      let result;
      if (body.type === 'setGame') {
        result = this.replaceGame(g, playerId, body.game, () => at);
      } else {
        const action = COMMON_ACTIONS[body.type] ?? gameFor(g.gameId).actions[body.type];
        if (!action) throw new GameError('unknownAction', { type: body.type });
        result = action(g, playerId, body, { now: () => at });
      }
      record(g, playerId, body, at);
      return result;
    });
  }

  get(code) {
    const room = this.rooms.get(String(code || '').toUpperCase());
    if (!room) throw new GameError('noSuchRoom', { code });
    room.touchedAt = this.now();
    return room;
  }

  has(code) {
    return this.rooms.has(String(code || '').toUpperCase());
  }

  /** Read a room without renewing its idle clock, and without throwing. */
  peek(code) {
    return this.rooms.get(String(code || '').toUpperCase());
  }

  /**
   * Rooms an incompatible restart would lose: a game in play, or one that just
   * finished and whose result is still on screen. A lobby costs nothing to
   * recreate, and a result nobody has touched for a few minutes is abandoned.
   * The window runs from the last touch, not from the final move, so a table
   * still reading its result keeps renewing it.
   */
  activeGameCount() {
    let count = 0;
    for (const room of this.rooms.values()) {
      if (room.game.phase === 'lobby') continue;
      if (room.game.phase === 'over' && this.now() - room.touchedAt >= OVER_GRACE_MS) continue;
      count += 1;
    }
    return count;
  }

  subscribe(code, playerId, send) {
    const room = this.get(code);
    const sub = { playerId, send };
    room.subscribers.add(sub);
    send(gameFor(room.game.gameId).viewFor(room.game, playerId));
    return () => room.subscribers.delete(sub);
  }

  /** Run a mutation and push a fresh, per-player view to everyone watching. */
  apply(code, fn) {
    const room = this.get(code);
    const result = fn(room.game);
    room.game.version += 1;
    this.broadcast(room);
    this.scheduleTick(code);
    this.onMutate?.();
    return result;
  }

  /**
   * Some games run on a clock — One Night Werewolf's night advances whether or
   * not anyone touches anything. Wake up exactly when the game says to.
   */
  scheduleTick(code) {
    const room = this.rooms.get(code);
    if (!room) return;
    clearTimeout(room.timer);
    room.timer = null;

    const at = gameFor(room.game.gameId).nextDeadline?.(room.game);
    if (!at) return;

    room.timer = setTimeout(() => {
      room.timer = null;
      if (!this.rooms.has(code)) return;
      const moved = gameFor(room.game.gameId).tick(room.game, this.now());
      if (moved) {
        room.game.version += 1;
        this.broadcast(room);
        this.onMutate?.();
      }
      this.scheduleTick(code);
    }, Math.max(0, at - this.now()));
    room.timer.unref?.();   // a pending night must not hold the process open
  }

  broadcast(room) {
    const view = gameFor(room.game.gameId).viewFor;
    for (const sub of room.subscribers) {
      try {
        sub.send(view(room.game, sub.playerId));
      } catch {
        room.subscribers.delete(sub); // a dead socket is not an error worth raising
      }
    }
  }

  sweep() {
    const cutoff = this.now() - IDLE_MS;
    let deleted = false;
    for (const [code, room] of this.rooms) {
      if (room.touchedAt < cutoff && room.subscribers.size === 0) {
        clearTimeout(room.timer);
        this.rooms.delete(code);
        deleted = true;
      }
    }
    if (deleted) this.onMutate?.();
  }

  /** Everything a restart must not lose. Subscribers and timers are runtime. */
  snapshot() {
    return [...this.rooms.values()].map(({ game, touchedAt }) => ({ game, touchedAt }));
  }

  /** Rebuild rooms from a snapshot and resume their clocks. Boot-time only. */
  restore(entries) {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      const { game, touchedAt } = entry ?? {};
      if (!(game?.gameId in GAMES) || !game.code) continue;
      this.rooms.set(game.code, {
        game,
        subscribers: new Set(),
        touchedAt,
        timer: null,
      });
      this.scheduleTick(game.code);
    }
  }
}

export function randomCode(length = 4) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}
