// One room session: reconnect policy, seat lifecycle, and stream ownership.

import { toast } from './ui.js';

const RETRY_STEPS = 6;

export function createRoomSession({
  app, store, transport, T, render, readName, gameRenderer, disposeGameRenderer,
}) {
  let reconnectTimer = null;
  let recovering = false;
  let lastAttempt = 0;

  transport.setHandlers({ onMessage: receiveView, onError: loseConnection });

  const request = (path, options) => transport.request(path, options);

  function safeRender() {
    try { render(); } catch (error) { console.error(error); }
  }

  function send(type, extra = {}) {
    return request(`/api/rooms/${app.code}/action`, {
      body: { type, playerId: app.playerId, ...extra },
    }).catch((error) => toast(T(`err.${error.key}`, error.params)));
  }

  function connect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    lastAttempt = Date.now();
    transport.open(app.code, app.playerId);
  }

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

  function scheduleReconnect(delay) {
    if (reconnectTimer || !app.code) return;
    app.retry = Math.min(app.retry + 1, RETRY_STEPS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void recover();
    }, delay ?? 500 * 2 ** (app.retry - 1));
    reconnectTimer?.unref?.();
  }

  async function recover() {
    if (recovering || !app.code || app.connected) return;
    recovering = true;
    const code = app.code;
    try {
      let status;
      try {
        status = await request(`/api/rooms/${code}?playerId=${encodeURIComponent(app.playerId)}`);
      } catch (error) {
        if (error.key === 'network') {
          scheduleReconnect();
          return safeRender();
        }
        status = {};
      }
      if (app.code !== code) return;
      if (status.exists === false) return dropRoom('room.gone');
      if (status.seated === false && !(await retakeSeat(code))) return;
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

  async function retakeSeat(code) {
    try {
      await request(`/api/rooms/${code}/join`, {
        body: { name: store.nameFor(code, app.playerId), playerId: app.playerId },
      });
      return true;
    } catch (error) {
      if (error.key === 'network') { scheduleReconnect(); safeRender(); return false; }
      dropRoom('room.seatLost');
      return false;
    }
  }

  function wake() {
    if (!app.code || app.connected) return;
    if (globalThis.document?.visibilityState === 'hidden') return;
    if (Date.now() - lastAttempt < 1000) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    app.retry = 0;
    scheduleReconnect(0);
  }

  function dropRoom(reasonKey, { keepSeat = false } = {}) {
    const code = app.code;
    const playerId = app.playerId;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
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

  async function joinRoom(code, name) {
    code = code.toUpperCase();
    try {
      const response = await request(`/api/rooms/${code}/join`, {
        body: {
          name,
          playerId: store.playerFor(code) ?? undefined,
          avatar: app.avatarUpload ?? undefined,
        },
      });
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
      toast(T(`err.${error.key}`, error.params));
    }
  }

  function rememberSeat(code, playerId, name) {
    app.seats = store.seatsFor(code).filter((seat) => seat.id !== playerId);
    app.seats.push({ id: playerId, name });
    store.setSeats(code, app.seats);
  }

  function leaveRoom() {
    const midGame = Boolean(app.view) && app.view.phase !== 'lobby';
    if (midGame) {
      const isHost = app.view.you?.id === app.view.hostId;
      if (!window.confirm(T(isHost ? 'game.leaveConfirmHost' : 'game.leaveConfirm'))) return;
    }
    const asked = app.code
      ? request(`/api/rooms/${app.code}/action`, { body: { type: 'leave', playerId: app.playerId } })
      : Promise.resolve();
    asked.catch(() => {}).finally(() => dropRoom(midGame ? 'room.left' : null, { keepSeat: midGame }));
  }

  function roomFromHash() {
    return (location.hash.match(/^#\/([A-Za-z0-9]{4,8})$/) ?? [])[1]?.toUpperCase();
  }

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

  function dismissSeat(code) {
    if ((store.room ?? '').toUpperCase() === code) store.room = null;
    if (app.heldSeat?.code === code) app.heldSeat = null;
  }

  function forgetSeat(code) {
    store.clearPlayer(code);
    store.clearSeats(code);
    dismissSeat(code);
  }

  async function rejoin(code, playerId) {
    try {
      await request(`/api/rooms/${code}/join`, { body: { name: store.nameFor(code, playerId), playerId } });
      connect();
    } catch (error) {
      if (error.key === 'network' || error.key === 'serverError') scheduleReconnect(0);
      else dropRoom(error.key === 'noSuchRoom' ? 'room.gone' : 'room.seatLost');
    }
  }

  return {
    request, send, connect, recover, wake, dropRoom, createRoom, joinRoom,
    rememberSeat, leaveRoom, roomFromHash, enterRoom, offerHeldSeat, dismissSeat,
  };
}
