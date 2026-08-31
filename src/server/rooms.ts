// Room registry: owns shared session state, runtime resources and persistence
// notifications. Engines own only the member at room.game.state.

import { randomInt } from 'node:crypto';

import type { GameId } from '../contracts/actions.ts';
import { persistedRoomSchema, persistedRoomsSchema } from '../contracts/persistence.ts';
import type { PersistedRoom } from '../contracts/persistence.ts';
import { validateRestoreInvariants } from './restore-invariants.ts';
import type {
  CreatedRoom, GameContext, RoomCommand, RuntimeRoom, RuntimeRoomFor,
} from './runtime.ts';
import type { PublicView } from '../contracts/views.ts';
import { GameError } from './errors.ts';
import { logEvent, record, require_ } from './lobby.ts';
import { DEFAULT_GAME, GAMES, gameFor } from './games/index.ts';
import type { LogFields, OperationalLogger } from './logging.ts';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;
const CODE_SPACE = CODE_ALPHABET.length ** CODE_LENGTH;
const CODE_ATTEMPTS = 1000;
const IDLE_MS = 6 * 60 * 60 * 1000;
const OVER_GRACE_MS = 3 * 60 * 1000;
const CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;
type RoomsOptions = {
  now?: () => number;
  onMutate?: () => void;
  newCode?: () => string;
  logger?: OperationalLogger;
};

const isAvalonRoom = (room: RuntimeRoom): room is RuntimeRoomFor<'avalon'> =>
  room.game.id === 'avalon';
const isAvalonPersistedRoom = (
  room: PersistedRoom,
): room is Extract<PersistedRoom, { game: { id: 'avalon' } }> => room.game.id === 'avalon';
function withTouchedAt(room: CreatedRoom, touchedAt: number): PersistedRoom {
  return persistedRoomSchema.parse({ ...room, touchedAt });
}
const contextFor = (room: RuntimeRoom): GameContext => {
  if (isAvalonRoom(room)) return { room, state: room.game.state };
  return { room, state: room.game.state };
};

function rosterChangeFor(
  room: RuntimeRoom,
  type: 'join' | 'leave',
  player: { id: string; name?: string; avatar?: string },
): unknown {
  if (isAvalonRoom(room)) return GAMES.avalon.rosterChange(room, type, player);
  return GAMES.onuw.rosterChange(room, type, player);
}

function commandFor(
  room: RuntimeRoom,
  playerId: string,
  body: RoomCommand,
  now: () => number,
): unknown {
  if (isAvalonRoom(room)) return GAMES.avalon.command(room, playerId, body, { now });
  return GAMES.onuw.command(room, playerId, body, { now });
}

function viewFor(room: RuntimeRoom, playerId: string, now: number): PublicView {
  if (isAvalonRoom(room)) return GAMES.avalon.view(room, playerId, now);
  return GAMES.onuw.view(room, playerId, now);
}

function deadlineFor(room: RuntimeRoom): number | null {
  if (isAvalonRoom(room)) return GAMES.avalon.deadline(room);
  return GAMES.onuw.deadline(room);
}

function tickFor(room: RuntimeRoom, now: number): boolean {
  if (isAvalonRoom(room)) return GAMES.avalon.tick(room, now);
  return GAMES.onuw.tick(room, now);
}

export class Rooms {
  now: () => number;
  onMutate: (() => void) | undefined;
  newCode: () => string;
  rooms: Map<string, RuntimeRoom>;
  logger: OperationalLogger | undefined;

  /**
   * @param {{
   *   now?: () => number,
   *   onMutate?: () => void,
   *   newCode?: () => string,
   * }} [options]
   */
  constructor({ now = Date.now, onMutate, newCode = randomCode, logger }: RoomsOptions = {}) {
    this.now = now;
    this.onMutate = onMutate;
    this.newCode = newCode;
    this.logger = logger;
    this.rooms = new Map();
  }

  emit(event: string, fields: LogFields): void {
    try { this.logger?.('info', event, fields); }
    catch { /* logging must never interrupt a game */ }
  }

  allocateCode(): string {
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
  create(
    gameId: GameId = DEFAULT_GAME,
    { code: requestedCode, seed }: { code?: string; seed?: number } = {},
  ): string {
    const code = requestedCode ? String(requestedCode).toUpperCase() : this.allocateCode();
    if (!CODE_PATTERN.test(code) || this.rooms.has(code)) throw new GameError('badRequest');
    const persisted = gameFor(gameId).create(code, {
      now: this.now,
      ...(seed === undefined ? {} : { seed }),
    });
    this.rooms.set(code, this.runtimeRoom(withTouchedAt(persisted, this.now())));
    this.emit('room.created', { game: gameId, rooms: this.rooms.size });
    this.onMutate?.();
    return code;
  }

  /** @param {PersistedRoom} room @returns {RuntimeRoom} */
  runtimeRoom(room: PersistedRoom): RuntimeRoom {
    if (isAvalonPersistedRoom(room)) return { ...room, subscribers: new Set(), timer: null };
    return { ...room, subscribers: new Set(), timer: null };
  }

  /** @param {string} code @param {string} playerId @param {GameId} gameId */
  setGame(code: string, playerId: string, gameId: GameId): unknown {
    return this.dispatch(code, playerId, { type: 'setGame', game: gameId });
  }

  /** @param {string} code @param {string} playerId @param {string} avatar */
  updatePlayerAvatar(code: string, playerId: string, avatar: string): boolean {
    const room = this.peek(code);
    const player = room?.players.find((candidate) => candidate.id === playerId);
    if (!player || player.avatar === avatar) return false;
    this.mutate(code, () => { player.avatar = avatar; });
    return true;
  }

  /** @param {RuntimeRoom} room @param {string} playerId @param {GameId} gameId */
  replaceGame(room: RuntimeRoom, playerId: string, gameId: GameId): void {
    require_(room.game.state.phase === 'lobby', 'gameAlreadyStarted');
    require_(playerId === room.hostId, 'hostOnly');
    if (room.game.id === gameId) return;
    const next = gameFor(gameId).create(room.code, { now: this.now, seed: room.seed });
    room.game = next.game;
    logEvent(contextFor(room), 'log.gameSwitched', { game: gameId });
  }

  /** Player input enters through one successful-mutation boundary. */
  /** @param {string} code @param {string} playerId @param {RoomCommand} body */
  dispatch(code: string, playerId: string, body: RoomCommand): unknown {
    return this.mutate(code, (room) => {
      if (!room.players.some((player) => player.id === playerId) && body.type !== 'join') {
        throw new GameError('notInGame');
      }
      const at = this.now();
      let result;
      if (body.type === 'setGame') {
        result = this.replaceGame(room, playerId, gameFor(body.game).id);
      } else if (body.type === 'join') {
        result = rosterChangeFor(room, 'join', {
          id: body.id ?? playerId,
          name: body.name,
        });
      } else if (body.type === 'leave') {
        result = rosterChangeFor(room, 'leave', { id: playerId });
      } else {
        result = commandFor(room, playerId, body, () => at);
      }
      record(contextFor(room), playerId, body, at);
      return result;
    });
  }

  /** @param {unknown} code @returns {RuntimeRoom} */
  get(code: unknown): RuntimeRoom {
    const room = this.rooms.get(String(code || '').toUpperCase());
    if (!room) throw new GameError('noSuchRoom', { code });
    room.touchedAt = this.now();
    return room;
  }

  /** @param {unknown} code */
  has(code: unknown): boolean {
    return this.rooms.has(String(code || '').toUpperCase());
  }

  /** @param {unknown} code @returns {RuntimeRoom | undefined} */
  peek(code: unknown): RuntimeRoom | undefined {
    return this.rooms.get(String(code || '').toUpperCase());
  }

  activeGameCount(): number {
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
  subscribe(code: string, playerId: string, send: (view: PublicView) => void): () => boolean {
    const room = this.get(code);
    const sub = { playerId, send };
    room.subscribers.add(sub);
    send(viewFor(room, playerId, this.now()));
    return () => room.subscribers.delete(sub);
  }

  /** Focused mutation seam for tests and non-player jobs. */
  /** @param {string} code @param {(context: import('./runtime.ts').GameContext) => unknown} fn */
  apply<T>(code: string, fn: (context: GameContext) => T): T {
    return this.mutate(code, (room) => fn(contextFor(room)));
  }

  /** @param {string} code @param {(room: RuntimeRoom) => unknown} fn */
  mutate<T>(code: string, fn: (room: RuntimeRoom) => T): T {
    const room = this.get(code);
    const before = { game: room.game.id, phase: room.game.state.phase };
    const result = fn(room);
    this.emitLifecycle(before, room);
    room.revision += 1;
    this.broadcast(room);
    this.scheduleTick(room.code);
    this.onMutate?.();
    return result;
  }

  /** @param {string} code */
  scheduleTick(code: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    if (room.timer) clearTimeout(room.timer);
    room.timer = null;
    const at = deadlineFor(room);
    if (at == null) return;

    room.timer = setTimeout(() => {
      room.timer = null;
      if (!this.rooms.has(code)) return;
      const before = { game: room.game.id, phase: room.game.state.phase };
      if (tickFor(room, this.now())) {
        this.emitLifecycle(before, room);
        room.revision += 1;
        this.broadcast(room);
        this.onMutate?.();
      }
      this.scheduleTick(code);
    }, Math.max(0, at - this.now()));
    room.timer.unref?.();
  }

  /** @param {RuntimeRoom} room */
  broadcast(room: RuntimeRoom): void {
    for (const sub of room.subscribers) {
      try {
        sub.send(viewFor(room, sub.playerId, this.now()));
      } catch {
        room.subscribers.delete(sub);
      }
    }
  }

  sweep(): void {
    const cutoff = this.now() - IDLE_MS;
    let deleted = false;
    const expired = new Map<GameId, number>();
    for (const [code, room] of this.rooms) {
      if (room.touchedAt < cutoff && room.subscribers.size === 0) {
        if (room.timer) clearTimeout(room.timer);
        this.rooms.delete(code);
        expired.set(room.game.id, (expired.get(room.game.id) ?? 0) + 1);
        deleted = true;
      }
    }
    for (const [game, count] of expired) {
      this.emit('room.expired', { game, count, rooms: this.rooms.size });
    }
    if (deleted) this.onMutate?.();
  }

  emitLifecycle(
    before: { game: GameId; phase: string },
    room: RuntimeRoom,
  ): void {
    const game = room.game.id;
    const phase = room.game.state.phase;
    if (before.game !== game) {
      this.emit('game.switched', { from: before.game, game });
      return;
    }
    if (before.phase === phase) return;
    if (before.phase === 'lobby') this.emit('game.started', { game });
    else if (phase === 'over') this.emit('game.completed', { game });
    else if (phase === 'lobby') this.emit('game.restarted', { game });
  }

  snapshot(): PersistedRoom[] {
    const snapshot = [...this.rooms.values()].map(
      ({ subscribers: _subscribers, timer: _timer, ...room }) => room,
    );
    return persistedRoomsSchema.parse(snapshot);
  }

  /** Validate the whole snapshot before installing any room. */
  /** @param {unknown} entries */
  restore(entries: unknown): boolean {
    const parsed = persistedRoomsSchema.safeParse(entries);
    if (!parsed.success) return false;
    const codes = new Set();
    for (const room of parsed.data) {
      if (codes.has(room.code) || this.rooms.has(room.code)) return false;
      codes.add(room.code);
      if (!validateRestoreInvariants(room)) return false;
    }

    for (const entry of parsed.data) {
      const room = this.runtimeRoom(entry);
      this.rooms.set(room.code, room);
      this.scheduleTick(room.code);
    }
    return true;
  }
}

export function randomCode(length = CODE_LENGTH): string {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]!;
  return out;
}
