// Room registry: owns the games, the subscriber lists and expiry.

import { GameError } from './rules.js';
import { createGame, viewFor } from './game.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
const IDLE_MS = 6 * 60 * 60 * 1000; // rooms vanish six hours after the last touch

export class Rooms {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.rooms = new Map(); // code -> { game, subscribers:Set, touchedAt }
  }

  create() {
    let code;
    do { code = randomCode(); } while (this.rooms.has(code));
    this.rooms.set(code, { game: createGame(code, { now: this.now }), subscribers: new Set(), touchedAt: this.now() });
    return code;
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

  subscribe(code, playerId, send) {
    const room = this.get(code);
    const sub = { playerId, send };
    room.subscribers.add(sub);
    send(viewFor(room.game, playerId));
    return () => room.subscribers.delete(sub);
  }

  /** Run a mutation and push a fresh, per-player view to everyone watching. */
  apply(code, fn) {
    const room = this.get(code);
    const result = fn(room.game);
    room.game.version += 1;
    this.broadcast(room);
    return result;
  }

  broadcast(room) {
    for (const sub of room.subscribers) {
      try {
        sub.send(viewFor(room.game, sub.playerId));
      } catch {
        room.subscribers.delete(sub); // a dead socket is not an error worth raising
      }
    }
  }

  sweep() {
    const cutoff = this.now() - IDLE_MS;
    for (const [code, room] of this.rooms) {
      if (room.touchedAt < cutoff && room.subscribers.size === 0) this.rooms.delete(code);
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
