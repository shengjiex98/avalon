// @ts-check
// Multi-seat test mode is a client of the room session, not part of normal
// rendering or transport. Every invented seat remains a real server seat.

import { h, toast } from './ui.js';
import { ApiError } from './transport.js';

/** @typedef {import('../types/contracts.js').JoinCommand} JoinCommand */
/** @typedef {import('../types/contracts.js').ValidatedAction} ValidatedAction */
/** @typedef {import('./room-session.js').SessionApp & { testMode: boolean }} TestSeatsApp */

/** Anything `request` rejects with carries a message key; a fault carries none. */
const apiError = (/** @type {unknown} */ error) => (error instanceof ApiError
  ? { key: error.key, params: error.params }
  : { key: 'serverError', params: /** @type {Record<string, unknown>} */ ({}) });

/**
 * @param {{
 *   app: TestSeatsApp,
 *   store: ReturnType<typeof import('./storage.js').createStore>,
 *   T: (key: string, params?: Record<string, unknown>) => string,
 *   request: ReturnType<typeof import('./transport.js').createTransport>['request'],
 *   connect: () => void,
 *   render: () => void,
 *   rememberSeat: (code: string, playerId: string, name: string) => void,
 * }} deps
 */
export function createTestSeats({ app, store, T, request, connect, render, rememberSeat }) {
  function pane() {
    const rows = [h('button', {
      class: 'btn ghost', id: 'testToggle',
      onclick: () => {
        app.testMode = !app.testMode;
        store.testMode = app.testMode;
        render();
      },
    }, `${T('test.mode')} · ${T(app.testMode ? 'test.on' : 'test.off')}`)];

    if (app.testMode) {
      rows.push(h('p', { class: 'muted', text: T('test.hint') }));
      if (app.code && app.view) {
        const lobby = app.view.phase === 'lobby';
        rows.push(h('div', { class: 'row' },
          h('button', { class: 'btn', id: 'testAdd', disabled: !lobby, onclick: addSeat },
            lobby ? T('test.add') : T('test.lobbyOnly')),
          h('button', {
            class: 'btn', id: 'testReset', disabled: !lobby || app.seats.length < 2,
            onclick: resetSeats,
          }, T('test.reset')),
        ));
        rows.push(h('p', { class: 'muted', text: T('test.actingAs') }));
        rows.push(h('div', { class: 'row' }, app.seats.map((seat) => h('button', {
          class: `btn seat-chip ${seat.id === app.playerId ? 'primary' : ''}`,
          onclick: () => actAs(seat.id),
        }, seat.name))));
      } else {
        rows.push(h('p', { class: 'muted', text: T('test.needRoom') }));
      }
    }
    return h('div', { class: 'test-bar' }, rows);
  }

  async function addSeat() {
    const code = app.code;
    const seated = app.view?.players ?? [];
    if (!code) return;
    const taken = new Set(seated.map((player) => player.name.toLowerCase()));
    let n = seated.length + 1;
    let name = T('test.player', { n });
    while (taken.has(name.toLowerCase())) name = T('test.player', { n: ++n });

    try {
      // An invented seat is a real one, so it never carries this browser's id.
      /** @type {JoinCommand} */
      const body = { name, avatar: false };
      const response = await request(`/api/rooms/${code}/join`, { body });
      rememberSeat(code, response.playerId, name);
      render();
    } catch (error) {
      const { key, params } = apiError(error);
      toast(T(`err.${key}`, params));
    }
  }

  async function resetSeats() {
    const code = app.code;
    const [mine, ...extras] = app.seats;
    if (!code || !mine || extras.length === 0) return;
    if (app.playerId !== mine.id) actAs(mine.id);

    /** @type {string[]} */
    const gone = [];
    for (const seat of extras) {
      try {
        /** @type {ValidatedAction} */
        const body = { type: 'leave', playerId: seat.id };
        await request(`/api/rooms/${code}/action`, { body });
        gone.push(seat.id);
      } catch (error) {
        const { key, params } = apiError(error);
        if (key === 'notInGame') { gone.push(seat.id); continue; }
        toast(T(`err.${key}`, params));
        break;
      }
    }
    app.seats = app.seats.filter((seat) => !gone.includes(seat.id));
    store.setSeats(code, app.seats);
    render();
  }

  /** @param {string} playerId */
  function actAs(playerId) {
    if (playerId === app.playerId || !app.code) return;
    app.playerId = playerId;
    store.setPlayer(app.code, playerId);
    app.selection = [];
    app.centres = [];
    app.infoPopup = null;
    connect();
    render();
  }

  return { pane, addSeat, resetSeats, actAs };
}