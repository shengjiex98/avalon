// One room session: reconnect policy, seat lifecycle, and stream ownership.

import { toast } from './ui.ts';
import { ApiError } from './transport.ts';
import type { ClientAction, GameId, JoinCommand } from '../contracts/actions.ts';
import type { PublicView } from '../contracts/views.ts';
import type { StoredSeat } from './storage.ts';

/**
 * What a session needs from the client's app state. app.ts owns the object;
 * naming the slice it lends out here is what lets the compiler check the
 * request bodies below against the server's own contract.
 */
export interface SessionApp {
  avatarUpload: string | null;
  centres: number[];
  code: string | null;
  connected: boolean;
  everConnected: boolean;
  gameId: GameId;
  heldSeat: { code: string; playerId: string } | null;
  infoPopup: string | null;
  playerId: string | null;
  rejoining: boolean;
  retry: number;
  seats: StoredSeat[];
  selection: string[];
  serverStatus: string;
  view: PublicView | null;
}

type Store = ReturnType<typeof import('./storage.ts').createStore>;
type Transport = ReturnType<typeof import('./transport.ts').createTransport>;
type GameRenderer = { onView?: () => void };
type SessionDependencies = {
  app: SessionApp;
  store: Store;
  transport: Transport;
  T: (key: string, params?: Record<string, unknown>) => string;
  render: () => void;
  readName: () => string | null;
  gameRenderer: (gameId: GameId) => GameRenderer;
  disposeGameRenderer: () => void;
};

const unrefTimer = (timer: unknown): void => {
  if (timer && typeof timer === 'object' && 'unref' in timer && typeof timer.unref === 'function') {
    timer.unref();
  }
};

const RETRY_STEPS = 6;

/** Anything `request` rejects with carries a message key; a fault carries none. */
const apiError = (error: unknown): { key: string; params: Record<string, unknown> } => (error instanceof ApiError
  ? { key: error.key, params: error.params }
  : { key: 'serverError', params: {} });

export function createRoomSession({
  app, store, transport, T, render, readName, gameRenderer, disposeGameRenderer,
}: SessionDependencies) {
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let recovering = false;
  let lastAttempt = 0;

  transport.setHandlers({ onMessage: receiveView, onError: loseConnection });

  function safeRender() {
    try { render(); } catch (error) { console.error(error); }
  }

  function send(action: ClientAction) {
    if (!app.code || !app.playerId) return Promise.resolve(undefined);
    return transport.action(app.code, app.playerId, action).catch((error) => {
      const { key, params } = apiError(error);
      toast(T(`err.${key}`, params));
    });
  }

  function connect() {
    if (!app.code || !app.playerId) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    lastAttempt = Date.now();
    transport.open(app.code, app.playerId);
  }

  function receiveView(next: PublicView) {
    app.connected = true;
    app.everConnected = true;
    app.retry = 0;
    if (!app.view || next.phase !== app.view.phase
        || ('round' in next ? next.round : undefined) !== ('round' in app.view ? app.view.round : undefined)
        || next.gameId !== app.view.gameId) {
      app.selection = [];
      app.centres = [];
      app.infoPopup = null;
    }
    app.view = next;
    try { gameRenderer(next.gameId).onView?.(); }
    catch (error) { console.error(error); }
    render();
  }

  function loseConnection() {
    app.connected = false;
    scheduleReconnect();
    safeRender();
  }

  function scheduleReconnect(delay?: number) {
    if (reconnectTimer || !app.code) return;
    app.retry = Math.min(app.retry + 1, RETRY_STEPS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void recover();
    }, delay ?? 500 * 2 ** (app.retry - 1));
    unrefTimer(reconnectTimer);
  }

  async function recover() {
    if (recovering || !app.code || !app.playerId || app.connected) return;
    recovering = true;
    const code = app.code;
    const playerId = app.playerId;
    try {
      let status;
      try {
        status = await transport.roomStatus(code, playerId);
      } catch (error) {
        if (apiError(error).key === 'network') {
          scheduleReconnect();
          return safeRender();
        }
        status = {};
      }
      if (app.code !== code) return;
      if (status.exists === false) return dropRoom('room.gone');
      if (status.seated === false && !(await retakeSeat(code, playerId))) return;
      if (app.code !== code) return;
      connect();
      safeRender();
    } catch (error) {
      console.error(error);
      scheduleReconnect();
    } finally {
      recovering = false;
    }
  }

  async function retakeSeat(code: string, playerId: string) {
    try {
      const body: JoinCommand = { name: store.nameFor(code, playerId), playerId };
      await transport.joinRoom(code, body);
      return true;
    } catch (error) {
      if (apiError(error).key === 'network') { scheduleReconnect(); safeRender(); return false; }
      dropRoom('room.seatLost');
      return false;
    }
  }

  function wake() {
    if (!app.code || app.connected) return;
    if (globalThis.document?.visibilityState === 'hidden') return;
    if (Date.now() - lastAttempt < 1000) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    app.retry = 0;
    scheduleReconnect(0);
  }

  function dropRoom(reasonKey: string | null, { keepSeat = false }: { keepSeat?: boolean } = {}) {
    const code = app.code;
    const playerId = app.playerId;
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    transport.close();
    disposeGameRenderer();
    app.view = null;
    app.playerId = null;
    app.infoPopup = null;
    app.seats = [];
    app.retry = 0;
    app.connected = false;
    app.everConnected = false;
    app.rejoining = false;
    if (keepSeat && code && playerId) {
      store.room = code;
      app.heldSeat = { code, playerId };
    } else {
      if (code) { store.clearPlayer(code); store.clearSeats(code); }
      store.room = null;
      app.heldSeat = null;
    }
    app.code = null;
    location.hash = '';
    safeRender();
    if (reasonKey) toast(T(reasonKey, { code }));
  }

  async function createRoom() {
    const name = readName();
    if (!name) return;
    const { code } = await transport.createRoom({ game: app.gameId });
    await joinRoom(code, name);
  }

  async function joinRoom(code: string, name: string) {
    code = code.toUpperCase();
    try {
      // A room this browser has never sat in contributes no id at all. Sending
      // one it does not have is what the server reads as a malformed request.
      const held = store.playerFor(code);
      const body: JoinCommand = { name };
      if (held) body.playerId = held;
      if (app.avatarUpload) body.avatar = app.avatarUpload;
      const response = await transport.joinRoom(code, body);
      app.code = code;
      app.playerId = response.playerId;
      app.rejoining = false;
      app.heldSeat = null;
      store.setPlayer(code, response.playerId);
      store.room = code;
      rememberSeat(code, response.playerId, name);
      app.avatarUpload = null;
      location.hash = `#/${code}`;
      connect();
      render();
    } catch (error) {
      const { key, params } = apiError(error);
      toast(T(`err.${key}`, params));
    }
  }

  function rememberSeat(code: string, playerId: string, name: string) {
    app.seats = store.seatsFor(code).filter((seat) => seat.id !== playerId);
    app.seats.push({ id: playerId, name });
    store.setSeats(code, app.seats);
  }

  function leaveRoom() {
    const view = app.view;
    const midGame = Boolean(view) && view?.phase !== 'lobby';
    if (midGame) {
      const isHost = view?.you?.id === view?.hostId;
      if (!window.confirm(T(isHost ? 'game.leaveConfirmHost' : 'game.leaveConfirm'))) return;
    }
    const asked = app.code && app.playerId
      ? transport.action(app.code, app.playerId, { type: 'leave' })
      : Promise.resolve();
    asked.catch(() => {}).finally(() => dropRoom(midGame ? 'room.left' : null, { keepSeat: midGame }));
  }

  function roomFromHash() {
    return (location.hash.match(/^#\/([A-Za-z0-9]{4,8})$/) ?? [])[1]?.toUpperCase();
  }

  async function enterRoom(code: string, playerId: string) {
    app.heldSeat = null;
    app.code = code;
    app.playerId = playerId;
    app.seats = store.seatsFor(code);
    app.rejoining = true;
    store.room = code;
    location.hash = `#/${code}`;
    render();
    if (app.serverStatus === 'ready') await rejoin(code, playerId);
    else scheduleReconnect(0);
    render();
  }

  async function offerHeldSeat() {
    const code = (store.room ?? '').toUpperCase();
    const playerId = /^[A-Z0-9]{4,8}$/.test(code) ? store.playerFor(code) : null;
    if (!playerId) {
      if (code) store.room = null;
      return;
    }
    // The local seat is enough to offer a way back. Waiting for the server to
    // confirm it first strands a bare-URL reload on the server picker during
    // the exact outage that made the player reload in the first place.
    app.heldSeat = { code, playerId };
    if (app.serverStatus !== 'ready') return;
    const status = await transport.roomStatus(code, playerId).catch(() => null);
    if (status && (!status.exists || !status.seated)) forgetSeat(code);
  }

  function dismissSeat(code: string) {
    if ((store.room ?? '').toUpperCase() === code) store.room = null;
    if (app.heldSeat?.code === code) app.heldSeat = null;
  }

  function forgetSeat(code: string) {
    store.clearPlayer(code);
    store.clearSeats(code);
    dismissSeat(code);
  }

  async function rejoin(code: string, playerId: string) {
    try {
      const body: JoinCommand = { name: store.nameFor(code, playerId), playerId };
      await transport.joinRoom(code, body);
      connect();
    } catch (error) {
      const { key } = apiError(error);
      if (key === 'network' || key === 'serverError') scheduleReconnect(0);
      else dropRoom(key === 'noSuchRoom' ? 'room.gone' : 'room.seatLost');
    }
  }

  return {
    send, connect, recover, wake, dropRoom, createRoom, joinRoom,
    rememberSeat, leaveRoom, roomFromHash, enterRoom, offerHeldSeat, dismissSeat,
  };
}
