// Room registry: owns the games, the subscriber lists and expiry.

import { GameError, logEvent, require_ } from './lobby.js';
import { DEFAULT_GAME, GAMES, gameFor } from './games/index.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
const IDLE_MS = 6 * 60 * 60 * 1000; // rooms vanish six hours after the last touch
const OVER_GRACE_MS = 3 * 60 * 1000; // finished games stay protected while players read results

export class Rooms {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.rooms = new Map(); // code -> { game, subscribers:Set, touchedAt }
  }

  create(gameId = DEFAULT_GAME) {
    if (!(gameId in GAMES)) throw new GameError('noSuchGame', { game: gameId });
    let code;
    do { code = randomCode(); } while (this.rooms.has(code));
    const game = gameFor(gameId).create(code, { now: this.now });
    this.rooms.set(code, { game, subscribers: new Set(), touchedAt: this.now(), timer: null });
    return code;
  }

  /**
   * Swap which game a room is playing. The people stay; everything about the
   * previous game is discarded, which is why it is a lobby-only move.
   */
  setGame(code, playerId, gameId) {
    if (!(gameId in GAMES)) throw new GameError('noSuchGame', { game: gameId });
    return this.apply(code, (g) => {
      require_(g.phase === 'lobby', 'gameAlreadyStarted');
      require_(playerId === g.hostId, 'hostOnly');
      if (g.gameId === gameId) return;
      const fresh = gameFor(gameId).create(g.code, { now: this.now });
      const { players, hostId, log, version } = g;
      for (const key of Object.keys(g)) delete g[key];
      Object.assign(g, fresh, { players, hostId, log, version });
      logEvent(g, 'log.gameSwitched', { game: gameId });
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

  /**
   * Rooms holding something a restart would lose: a game in play, or one that
   * just finished and whose result is still on screen. A lobby costs nothing to
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
    for (const [code, room] of this.rooms) {
      if (room.touchedAt < cutoff && room.subscribers.size === 0) {
        clearTimeout(room.timer);
        this.rooms.delete(code);
      }
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
