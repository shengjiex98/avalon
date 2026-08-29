// @ts-check
// One room session: reconnect policy, seat lifecycle, and stream ownership.

import { toast } from './ui.js';
import { ApiError } from './transport.js';

/** @typedef {import('../types/contracts.js').JoinCommand} JoinCommand */
/** @typedef {import('../types/contracts.js').PublicView} PublicView */
/** @typedef {import('../types/contracts.js').StoredSeat} StoredSeat */
/** @typedef {import('../types/contracts.js').ValidatedAction} ValidatedAction */

/**
 * What a session needs from the client's app state. app.js owns the object;
 * naming the slice it lends out here is what lets the compiler check the
 * request bodies below against the server's own contract.
 * @typedef {{
 *   avatarUpload: string | null,
 *   centres: number[],
 *   code: string | null,
 *   connected: boolean,
 *   everConnected: boolean,
 *   gameId: string,
 *   heldSeat: { code: string, playerId: string } | null,
 *   infoPopup: unknown,
 *   playerId: string | null,
 *   rejoining: boolean,
 *   retry: number,
 *   seats: StoredSeat[],
 *   selection: string[],
 *   serverStatus: string,
 *   view: PublicView | null,
 * }} SessionApp
 */

const RETRY_STEPS = 6;

/** Anything `request` rejects with carries a message key; a fault carries none. */
const apiError = (/** @type {unknown} */ error) => (error instanceof ApiError
  ? { key: error.key, params: error.params }
  : { key: 'serverError', params: /** @type {Record<string, unknown>} */ ({}) });

/**
 * @param {{
 *   app: SessionApp,
 *   store: ReturnType<typeof import('./storage.js').createStore>,
 *   transport: ReturnType<typeof import('./transport.js').createTransport>,
 *   T: (key: string, params?: Record<string, unknown>) => string,
 *   render: () => void,
 *   readName: () => string,
 *   gameRenderer: (gameId: string) => { onView?: () => void },
 *   disposeGameRenderer: () => void,
 * }} deps
 */
export function createRoomSession({
  app, store, transport, T, render, readName, gameRenderer, disposeGameRenderer,
}) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let reconnectTimer;
  let recovering = false;
  let lastAttempt = 0;

  transport.setHandlers({ onMessage: receiveView, onError: loseConnection });

  /** @type {typeof transport.request} */
  const request = (path, options) => transport.request(path, options);

  function safeRender() {
    try { render(); } catch (error) { console.error(error); }
  }

  // The action name is checked against the command union; the payload beside
  // it is not, because `send` is a dispatcher and the shape depends on `type`.
  // Callers are the ones the server's own action validator answers.
  /** @param {ValidatedAction['type']} type @param {Record<string, unknown>} [extra] */
  function send(type, extra = {}) {
    const body = /** @type {ValidatedAction} */ ({ type, playerId: app.playerId, ...extra });
    return request(`/api/rooms/${app.code}/action`, { body }).catch((error) => {
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

  /** @param {PublicView} next */
  function receiveView(next) {
    app.connected = true;
    app.everConnected = true;
    app.retry = 0;
    if (!app.view || next.phase !== app.view.phase || next.round !== app.view.round
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

  /** @param {number} [delay] */
  function scheduleReconnect(delay) {
    if (reconnectTimer || !app.code) return;
    app.retry = Math.min(app.retry + 1, RETRY_STEPS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void recover();
    }, delay ?? 500 * 2 ** (app.retry - 1));
    reconnectTimer?.unref?.();
  }

  async function recover() {
    if (recovering || !app.code || !app.playerId || app.connected) return;
    recovering = true;
    const code = app.code;
    const playerId = app.playerId;
    try {
      let status;
      try {
        status = await request(`/api/rooms/${code}?playerId=${encodeURIComponent(playerId)}`);
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

  /** @param {string} code @param {string} playerId */
  async function retakeSeat(code, playerId) {
    try {
      /** @type {JoinCommand} */
      const body = { name: store.nameFor(code, playerId), playerId };
      await request(`/api/rooms/${code}/join`, { body });
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

  /** @param {string | null} reasonKey @param {{ keepSeat?: boolean }} [options] */
  function dropRoom(reasonKey, { keepSeat = false } = {}) {
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
    const { code } = await request('/api/rooms', { body: { game: app.gameId } });
    await joinRoom(code, name);
  }

  /** @param {string} code @param {string} name */
  async function joinRoom(code, name) {
    code = code.toUpperCase();
    try {
      // A room this browser has never sat in contributes no id at all. Sending
      // one it does not have is what the server reads as a malformed request.
      const held = store.playerFor(code);
      /** @type {JoinCommand} */
      const body = { name };
      if (held) body.playerId = held;
      if (app.avatarUpload) body.avatar = app.avatarUpload;
      const response = await request(`/api/rooms/${code}/join`, { body });
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

  /** @param {string} code @param {string} playerId @param {string} name */
  function rememberSeat(code, playerId, name) {
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
      ? request(`/api/rooms/${app.code}/action`, {
          body: { type: 'leave', playerId: app.playerId },
        })
      : Promise.resolve();
    asked.catch(() => {}).finally(() => dropRoom(midGame ? 'room.left' : null, { keepSeat: midGame }));
  }

  function roomFromHash() {
    return (location.hash.match(/^#\/([A-Za-z0-9]{4,8})$/) ?? [])[1]?.toUpperCase();
  }

  /** @param {string} code @param {string} playerId */
  async function enterRoom(code, playerId) {
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
    const status = await request(`/api/rooms/${code}?playerId=${encodeURIComponent(playerId)}`).catch(() => ({}));
    if (status.seated) app.heldSeat = { code, playerId };
    else if (status.exists === false || status.seated === false) forgetSeat(code);
  }

  /** @param {string} code */
  function dismissSeat(code) {
    if ((store.room ?? '').toUpperCase() === code) store.room = null;
    if (app.heldSeat?.code === code) app.heldSeat = null;
  }

  /** @param {string} code */
  function forgetSeat(code) {
    store.clearPlayer(code);
    store.clearSeats(code);
    dismissSeat(code);
  }

  /** @param {string} code @param {string} playerId */
  async function rejoin(code, playerId) {
    try {
      /** @type {JoinCommand} */
      const body = { name: store.nameFor(code, playerId), playerId };
      await request(`/api/rooms/${code}/join`, { body });
      connect();
    } catch (error) {
      const { key } = apiError(error);
      if (key === 'network' || key === 'serverError') scheduleReconnect(0);
      else dropRoom(key === 'noSuchRoom' ? 'room.gone' : 'room.seatLost');
    }
  }

  return {
    request, send, connect, recover, wake, dropRoom, createRoom, joinRoom,
    rememberSeat, leaveRoom, roomFromHash, enterRoom, offerHeldSeat, dismissSeat,
  };
}