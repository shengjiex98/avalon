// Room registry: owns shared session state, runtime resources and persistence
// notifications. Engines own only the member at room.game.state.

// @ts-check

import { randomInt } from 'node:crypto';

import { GameError, logEvent, record, require_ } from './lobby.js';
import { DEFAULT_GAME, gameContext, gameFor } from './games/index.js';

/** @typedef {import('../types/contracts.js').GameId} GameId */
/** @typedef {import('../types/contracts.js').PersistedRoom} PersistedRoom */
/** @typedef {import('../types/contracts.js').PublicView} PublicView */
/** @typedef {import('../types/contracts.js').RoomCommand} RoomCommand */
/** @typedef {import('../types/contracts.js').RuntimeRoom} RuntimeRoom */

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;
const CODE_SPACE = CODE_ALPHABET.length ** CODE_LENGTH;
const CODE_ATTEMPTS = 1000;
const IDLE_MS = 6 * 60 * 60 * 1000;
const OVER_GRACE_MS = 3 * 60 * 1000;
const CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;

export class Rooms {
  /**
   * @param {{
   *   now?: () => number,
   *   onMutate?: () => void,
   *   newCode?: () => string,
   * }} [options]
   */
  constructor({ now = Date.now, onMutate, newCode = randomCode } = {}) {
    this.now = now;
    this.onMutate = onMutate;
    this.newCode = newCode;
    /** @type {Map<string, RuntimeRoom>} */
    this.rooms = new Map();
  }

  /** @returns {string} */
  allocateCode() {
    if (this.rooms.size >= CODE_SPACE) throw new GameError('roomsFull');
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
      const code = this.newCode();
      if (!this.rooms.has(code)) return code;
    }
    throw new GameError('roomsFull');
  }

  /**
   * @param {GameId} [gameId]
   * @param {{ code?: string, seed?: number }} [options]
   * @returns {string}
   */
  create(gameId = DEFAULT_GAME, { code: requestedCode, seed } = {}) {
    const code = requestedCode ? String(requestedCode).toUpperCase() : this.allocateCode();
    if (!CODE_PATTERN.test(code) || this.rooms.has(code)) throw new GameError('badRequest');
    const persisted = gameFor(gameId).create(code, {
      now: this.now,
      ...(seed === undefined ? {} : { seed }),
    });
    this.rooms.set(code, this.runtimeRoom(/** @type {PersistedRoom} */ ({ ...persisted, touchedAt: this.now() })));
    this.onMutate?.();
    return code;
  }

  /** @param {PersistedRoom} room @returns {RuntimeRoom} */
  runtimeRoom(room) {
    return { ...room, subscribers: new Set(), timer: null };
  }

  /** @param {string} code @param {string} playerId @param {GameId} gameId */
  setGame(code, playerId, gameId) {
    return this.dispatch(code, playerId, { type: 'setGame', game: gameId });
  }

  /** @param {string} code @param {string} playerId @param {string} avatar */
  updatePlayerAvatar(code, playerId, avatar) {
    const room = this.peek(code);
    const player = room?.players.find((candidate) => candidate.id === playerId);
    if (!player || player.avatar === avatar) return false;
    this.mutate(code, () => { player.avatar = avatar; });
    return true;
  }

  /** @param {RuntimeRoom} room @param {string} playerId @param {GameId} gameId */
  replaceGame(room, playerId, gameId) {
    require_(gameContext(room).phase === 'lobby', 'gameAlreadyStarted');
    require_(playerId === room.hostId, 'hostOnly');
    if (room.game.id === gameId) return;
    const next = gameFor(gameId).create(room.code, { now: this.now, seed: room.seed });
    room.game = next.game;
    logEvent(gameContext(room), 'log.gameSwitched', { game: gameId });
  }

  /** Player input enters through one successful-mutation boundary. */
  /** @param {string} code @param {string} playerId @param {RoomCommand} body */
  dispatch(code, playerId, body) {
    return this.mutate(code, (room) => {
      if (!room.players.some((player) => player.id === playerId) && body.type !== 'join') {
        throw new GameError('notInGame');
      }
      const at = this.now();
      let result;
      if (body.type === 'setGame') {
        result = this.replaceGame(room, playerId, /** @type {GameId} */ (body.game));
      } else if (body.type === 'join' || body.type === 'leave') {
        result = gameFor(room.game.id).rosterChange(room, body.type, {
          id: body.id ?? playerId,
          ...(body.name === undefined ? {} : { name: body.name }),
        });
      } else {
        result = gameFor(room.game.id).command(room, playerId, body, { now: () => at });
      }
      record(gameContext(room), playerId, body, at);
      return result;
    });
  }

  /** @param {unknown} code @returns {RuntimeRoom} */
  get(code) {
    const room = this.rooms.get(String(code || '').toUpperCase());
    if (!room) throw new GameError('noSuchRoom', { code });
    room.touchedAt = this.now();
    return room;
  }

  /** @param {unknown} code */
  has(code) {
    return this.rooms.has(String(code || '').toUpperCase());
  }

  /** @param {unknown} code @returns {RuntimeRoom | undefined} */
  peek(code) {
    return this.rooms.get(String(code || '').toUpperCase());
  }

  activeGameCount() {
    let count = 0;
    for (const room of this.rooms.values()) {
      const phase = room.game.state.phase;
      if (phase === 'lobby') continue;
      if (phase === 'over' && this.now() - room.touchedAt >= OVER_GRACE_MS) continue;
      count += 1;
    }
    return count;
  }

  /** @param {string} code @param {string} playerId @param {(view: PublicView) => void} send */
  subscribe(code, playerId, send) {
    const room = this.get(code);
    const sub = { playerId, send };
    room.subscribers.add(sub);
    send(gameFor(room.game.id).view(room, playerId, this.now()));
    return () => room.subscribers.delete(sub);
  }

  /**
   * Compatibility seam for focused tests and non-player jobs. The callback
   * receives the temporary flat game facade, but the stored state stays split.
   */
  /** @param {string} code @param {(context: import('../types/contracts.js').GameContext) => unknown} fn */
  apply(code, fn) {
    return this.mutate(code, (room) => fn(gameContext(room)));
  }

  /** @param {string} code @param {(room: RuntimeRoom) => unknown} fn */
  mutate(code, fn) {
    const room = this.get(code);
    const result = fn(room);
    room.revision += 1;
    this.broadcast(room);
    this.scheduleTick(room.code);
    this.onMutate?.();
    return result;
  }

  /** @param {string} code */
  scheduleTick(code) {
    const room = this.rooms.get(code);
    if (!room) return;
    if (room.timer) clearTimeout(room.timer);
    room.timer = null;
    const engine = gameFor(room.game.id);
    const at = engine.deadline(room);
    if (at == null) return;

    room.timer = setTimeout(() => {
      room.timer = null;
      if (!this.rooms.has(code)) return;
      if (engine.tick(room, this.now())) {
        room.revision += 1;
        this.broadcast(room);
        this.onMutate?.();
      }
      this.scheduleTick(code);
    }, Math.max(0, at - this.now()));
    room.timer.unref?.();
  }

  /** @param {RuntimeRoom} room */
  broadcast(room) {
    const engine = gameFor(room.game.id);
    for (const sub of room.subscribers) {
      try {
        sub.send(engine.view(room, sub.playerId, this.now()));
      } catch {
        room.subscribers.delete(sub);
      }
    }
  }

  sweep() {
    const cutoff = this.now() - IDLE_MS;
    let deleted = false;
    for (const [code, room] of this.rooms) {
      if (room.touchedAt < cutoff && room.subscribers.size === 0) {
        if (room.timer) clearTimeout(room.timer);
        this.rooms.delete(code);
        deleted = true;
      }
    }
    if (deleted) this.onMutate?.();
  }

  snapshot() {
    return /** @type {PersistedRoom[]} */ (
      [...this.rooms.values()].map(({ subscribers: _subscribers, timer: _timer, ...room }) => room)
    );
  }

  /** Validate the whole snapshot before installing any room. */
  /** @param {unknown} entries */
  restore(entries) {
    if (!Array.isArray(entries)) return false;
    const codes = new Set();
    for (const candidate of entries) {
      if (!validRoomEnvelope(candidate)) return false;
      const room = /** @type {PersistedRoom} */ (candidate);
      if (codes.has(room.code) || this.rooms.has(room.code)) return false;
      codes.add(room.code);
      let engine;
      try { engine = gameFor(room.game.id); }
      catch { return false; }
      if (!engine.validateRestore(room)) return false;
    }

    for (const candidate of entries) {
      const entry = /** @type {PersistedRoom} */ (candidate);
      const room = this.runtimeRoom(entry);
      this.rooms.set(room.code, room);
      this.scheduleTick(room.code);
    }
    return true;
  }
}

/** @param {any} room */
function validRoomEnvelope(room) {
  if (!plainRecord(room) || !CODE_PATTERN.test(room.code)) return false;
  if (!Number.isFinite(room.createdAt) || !Number.isFinite(room.touchedAt)) return false;
  if (!uint32(room.seed) || !uint32(room.rng) || !Number.isInteger(room.revision) || room.revision < 0) return false;
  if (!Array.isArray(room.players) || !room.players.every(validPlayer)) return false;
  const ids = room.players.map((player) => player.id);
  if (new Set(ids).size !== ids.length) return false;
  const names = room.players.map((player) => player.name.toLowerCase());
  if (new Set(names).size !== names.length) return false;
  if (room.hostId !== null && !ids.includes(room.hostId)) return false;
  if ((room.players.length === 0) !== (room.hostId === null)) return false;
  if (!Array.isArray(room.log) || !room.log.every(validLog)) return false;
  if (!Array.isArray(room.journal) || !room.journal.every(validJournal)) return false;
  if (room.journalDropped !== undefined && room.journalDropped !== true) return false;
  if (!plainRecord(room.game) || !exactKeys(room.game, ['id', 'state'])) return false;
  if (typeof room.game.id !== 'string' || !plainRecord(room.game.state)) return false;
  const required = ['code', 'createdAt', 'players', 'hostId', 'log', 'seed', 'rng', 'revision', 'journal', 'touchedAt', 'game'];
  if (!exactKeys(room, required, ['journalDropped'])) return false;
  const forbidden = ['code', 'gameId', 'createdAt', 'players', 'hostId', 'log', 'seed', 'rng', 'version', 'actions', 'actionsDropped'];
  return forbidden.every((key) => !(key in room.game.state));
}

/** @param {unknown} value @returns {value is Record<string, any>} */
const plainRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/** @param {Record<string, any>} value @param {string[]} required @param {string[]} [optional] */
const exactKeys = (value, required, optional = []) => {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
};
/** @param {unknown} value */
const uint32 = (value) => Number.isInteger(value) && /** @type {number} */ (value) >= 0
  && /** @type {number} */ (value) <= 0xffffffff;
/** @param {any} player */
const validPlayer = (player) => plainRecord(player)
  && exactKeys(player, ['id', 'name'], ['avatar'])
  && typeof player.id === 'string' && player.id.length > 0
  && typeof player.name === 'string' && player.name.length > 0 && player.name.length <= 24
  && (player.avatar === undefined || typeof player.avatar === 'string');
/** @param {any} entry */
const validLog = (entry) => plainRecord(entry)
  && typeof entry.key === 'string' && plainRecord(entry.params) && Number.isFinite(entry.at);
/** @param {any} entry */
const validJournal = (entry) => plainRecord(entry)
  && typeof entry.t === 'string' && typeof entry.p === 'string'
  && plainRecord(entry.b) && Number.isFinite(entry.at);

export function randomCode(length = CODE_LENGTH) {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}
