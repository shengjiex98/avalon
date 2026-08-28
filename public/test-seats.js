// Multi-seat test mode is a client of the room session, not part of normal
// rendering or transport. Every invented seat remains a real server seat.

import { h, toast } from './ui.js';

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
    const taken = new Set(app.view.players.map((player) => player.name.toLowerCase()));
    let n = app.view.players.length + 1;
    let name = T('test.player', { n });
    while (taken.has(name.toLowerCase())) name = T('test.player', { n: ++n });

    try {
      const response = await request(`/api/rooms/${app.code}/join`, { body: { name, avatar: false } });
      rememberSeat(app.code, response.playerId, name);
      render();
    } catch (error) {
      toast(T(`err.${error.key}`, error.params));
    }
  }

  async function resetSeats() {
    const [mine, ...extras] = app.seats;
    if (!mine || extras.length === 0) return;
    if (app.playerId !== mine.id) actAs(mine.id);

    const gone = [];
    for (const seat of extras) {
      try {
        await request(`/api/rooms/${app.code}/action`, { body: { type: 'leave', playerId: seat.id } });
        gone.push(seat.id);
      } catch (error) {
        if (error.key === 'notInGame') { gone.push(seat.id); continue; }
        toast(T(`err.${error.key}`, error.params));
        break;
      }
    }
    app.seats = app.seats.filter((seat) => !gone.includes(seat.id));
    store.setSeats(app.code, app.seats);
    render();
  }

  function actAs(playerId) {
    if (playerId === app.playerId) return;
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
