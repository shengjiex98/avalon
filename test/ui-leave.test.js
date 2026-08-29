// Walking out of a game in progress. The server will not remove a seat once the
// roles are dealt — quest sizes come from the head count, so a vanishing player
// would break the rules for everyone still playing — which makes leaving
// something the device does rather than something the room does. What has to
// hold: the player really gets out, the table is not left short, and a mis-tap
// is not the end of their game.
import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from './dom-shim.js';
import * as g from '../src/games/avalon/game.js';

const dom = installDom();
const client = await import('../public/app.js');
await client.ready;
const { app, render } = client;

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Five players in room WXYZ, with this browser sitting at one of the seats. */
function seatedInGame({ started = true, seat = 'p1' } = {}) {
  const game = g.createGame('WXYZ');
  ['Ann', '张三', 'Cai', 'Dee', 'Eli'].forEach((name, i) => g.addPlayer(game, { id: `p${i}`, name }));
  if (started) {
    g.startGame(game, 'p0', { shuffle: (list) => list });
    for (const p of game.room.players) g.confirmRole(game, p.id);
  }
  Object.assign(app, {
    lang: 'en', server: '', serverStatus: 'ready', code: 'WXYZ', playerId: seat,
    heldSeat: null, connected: true, everConnected: true, selection: [], infoPopup: null,
    view: g.viewFor(game, seat),
  });
  dom.location.hash = '#/WXYZ';
  dom.storage.set('avalon.room', 'WXYZ');
  dom.storage.set('avalon.player.WXYZ', seat);
  dom.storage.set('avalon.seats.WXYZ', JSON.stringify([{ id: seat, name: '张三' }]));
  dom.state.confirmations.length = 0;
  dom.calls.length = 0;
  render();
  return game;
}

test('a player who is not the host can leave a game in progress', () => {
  seatedInGame();
  assert.ok(dom.fixtures.view.byId('leaveGame'), 'the way out is on screen');
  assert.equal(dom.fixtures.view.byId('resetGame'), null, 'ending it for everyone stays the host\'s');
});

test('the host keeps both ways out, and hears what the quiet one costs', async () => {
  seatedInGame({ seat: 'p0' });
  assert.ok(dom.fixtures.view.byId('resetGame'), 'ending it for the whole table');
  assert.ok(dom.fixtures.view.byId('leaveGame'), 'and walking away from it');

  dom.state.confirmResult = false;
  dom.fixtures.view.byId('leaveGame').dispatch('click');
  await tick();
  assert.match(dom.state.confirmations[0], /nobody left in the room will be able to reset it/);
});

test('leaving is deliberate: declining the prompt changes nothing', async () => {
  seatedInGame();
  dom.state.confirmResult = false;
  dom.fixtures.view.byId('leaveGame').dispatch('click');
  await tick();

  assert.equal(dom.state.confirmations.length, 1, 'it asks first');
  assert.equal(app.code, 'WXYZ', 'and takes no for an answer');
  assert.equal(dom.calls.some((c) => c.path === '/api/rooms/WXYZ/action'), false);
});

test('leaving mid-game drops the room here and leaves the seat there', async () => {
  seatedInGame();
  dom.state.confirmResult = true;
  dom.fixtures.view.byId('leaveGame').dispatch('click');
  await tick();

  const told = dom.calls.find((c) => c.path === '/api/rooms/WXYZ/action');
  assert.equal(told?.body.type, 'leave', 'the server is asked either way');

  // It refuses mid-game, and that refusal is not the player's problem: the
  // stub answers 400 to an action it has no fixture for.
  assert.equal(app.code, null, 'the player is out');
  assert.equal(app.view, null);
  assert.equal(dom.location.hash, '', 'and the URL no longer points back in');
  assert.match(dom.fixtures.toast.text, /You left room WXYZ/);

  assert.equal(dom.localStorage.getItem('avalon.player.WXYZ'), 'p1', 'the seat is remembered');
  assert.deepEqual(app.heldSeat, { code: 'WXYZ', playerId: 'p1' });
  assert.match(dom.fixtures.view.text, /You still have a seat in room WXYZ/, 'and offered back');
});

test('the offer can be refused, which is what makes a bare URL a way out', () => {
  dom.fixtures.view.byId('forgetSeat').dispatch('click');

  assert.equal(app.heldSeat, null);
  assert.equal(dom.localStorage.getItem('avalon.room'), null, 'nothing offers it again');
  assert.match(dom.fixtures.view.text, /Create a new room/);

  // Refusing the offer is not the same as burning the seat: a game that has
  // started will not take them back as a stranger, so the id has to survive a
  // change of heart. The room's own link still works.
  assert.equal(dom.localStorage.getItem('avalon.player.WXYZ'), 'p1');
  assert.equal(dom.localStorage.getItem('avalon.seats.WXYZ'), JSON.stringify([{ id: 'p1', name: '张三' }]));
});

test('leaving a lobby still gives the seat up, and needs no prompt', async () => {
  seatedInGame({ started: false });
  dom.state.responses.set('/api/rooms/WXYZ/action', { ok: true });
  const leave = dom.fixtures.view.find((n) => n.tagName === 'BUTTON' && n.text === 'Leave');
  leave.dispatch('click');
  await tick();

  assert.equal(dom.state.confirmations.length, 0, 'nothing is at stake in a lobby');
  assert.equal(app.code, null);
  assert.equal(dom.localStorage.getItem('avalon.player.WXYZ'), null, 'the seat goes with it');
  assert.equal(app.heldSeat, null, 'so there is nothing to offer back');
});

test('a seat in a room the server has forgotten is never offered', async () => {
  app.source?.close();
  Object.assign(app, {
    code: null, view: null, playerId: null, heldSeat: null,
    connected: false, everConnected: false,
  });
  dom.location.hash = '';
  dom.storage.set('avalon.room', 'WXYZ');
  dom.storage.set('avalon.player.WXYZ', 'p1');
  dom.state.responses.set('/api/rooms/WXYZ?playerId=p1', { exists: false, seated: false });

  await client.main();

  assert.equal(app.heldSeat, null);
  assert.equal(dom.localStorage.getItem('avalon.room'), null, 'and the record is cleaned up');
  assert.match(dom.fixtures.view.text, /Create a new room/);
});
