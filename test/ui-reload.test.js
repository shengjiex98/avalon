// Reloading for a new client build, mid-game. The page comes back with nothing
// but localStorage and a URL, and the seat has to survive it: a game that has
// started will not let a stranger in, so a player thrown onto the join form is
// out of that game for good.
//
// A reload that kept its fragment goes straight back in. One that lost it is
// offered the seat instead of being put back in the room, because the same
// bare URL is what a player types to get *out* of a game they have abandoned.
import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from './dom-shim.js';

// A reload that arrived without the fragment: the seat is remembered, and
// offered rather than taken.
const dom = installDom({ href: 'https://shengjiex98.github.io/avalon/', hash: '' });
dom.storage.set('avalon.room', 'WXYZ');
dom.storage.set('avalon.player.WXYZ', 'me');
dom.storage.set('avalon.name', 'Ann');
dom.storage.set('avalon.seats.WXYZ', JSON.stringify([{ id: 'me', name: 'Ann' }]));
dom.state.responses.set('/api/rooms/WXYZ/join', { playerId: 'me', code: 'WXYZ' });
dom.state.responses.set('/api/rooms/WXYZ?playerId=me', { exists: true, seated: true });

const client = await import('../public/app.js');
await client.ready;
const { app } = client;

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const frame = () => ({
  code: 'WXYZ', gameId: 'avalon', phase: 'quest', version: 9, hostId: 'me',
  me: { id: 'me', name: 'Ann' },
  you: { id: 'me', name: 'Ann', role: 'merlin', team: 'good', awake: false, action: null, acted: false, voted: false },
  players: [{ id: 'me', name: 'Ann', seat: 0, isLeader: true, onTeam: true }],
  setup: { minPlayers: 5, maxPlayers: 10, options: [], houseRules: [] },
  options: {}, optionRoom: 1, deck: {}, centreCount: 3, centre: null,
  round: 1, rejects: 0, maxRejects: 5, teamSize: 2, failsRequired: 1,
  boardSizes: [2, 3, 2, 3, 3], team: ['me'], quests: [], lastVote: null,
  knowledge: [], info: [], swaps: [], votes: [], dead: [], winners: [],
  waitingFor: ['me'], evilCount: 2, log: [],
  night: null, pace: 'normal', nightScript: [], nightSeconds: 30,
});

test('a bare URL offers the remembered seat instead of entering the room', async () => {
  assert.equal(app.code, null, 'a bare URL is a bare URL');
  assert.deepEqual(app.heldSeat, { code: 'WXYZ', playerId: 'me' });
  assert.equal(dom.location.hash, '', 'and the URL is left as the player typed it');
  assert.equal(dom.calls.some((c) => c.path === '/api/rooms/WXYZ/join'), false, 'no seat taken');
  assert.match(dom.fixtures.view.text, /You still have a seat in room WXYZ/);
});

test('accepting the offer puts the player back in the game', async () => {
  dom.fixtures.view.byId('rejoinSeat').dispatch('click');
  await tick();

  assert.equal(app.code, 'WXYZ');
  assert.equal(app.playerId, 'me');
  assert.equal(app.heldSeat, null, 'the offer is spent');
  assert.equal(dom.location.hash, '#/WXYZ', 'the room is put back in the URL');

  const rejoin = dom.calls.find((c) => c.path === '/api/rooms/WXYZ/join');
  assert.ok(rejoin, 'it takes its seat again');
  assert.equal(rejoin.body.playerId, 'me');
  assert.equal(dom.fixtures.view.byId('nameInput'), null, 'no join form');

  dom.EventSourceStub.last.onmessage({ data: JSON.stringify(frame()) });
  assert.equal(app.view.phase, 'quest');
  assert.match(dom.fixtures.view.text, /Play a card/, 'the game is back on screen');
  assert.equal(dom.fixtures.conn.hidden, true);
});

test('a reload that kept its fragment goes straight back in', async () => {
  app.source?.close();
  app.code = null; app.view = null; app.playerId = null; app.connected = false;
  app.everConnected = false; app.retry = 0; app.heldSeat = null;
  dom.location.hash = '#/WXYZ';
  dom.storage.set('avalon.player.WXYZ', 'me');

  await client.main();
  await tick();

  assert.equal(app.code, 'WXYZ', 'no offer to accept: the URL said which room');
  assert.equal(app.heldSeat, null);
  assert.match(dom.fixtures.view.text, /Rejoining room WXYZ/);

  dom.EventSourceStub.last.onmessage({ data: JSON.stringify(frame()) });
  assert.match(dom.fixtures.view.text, /Play a card/);
});

test('a server that is still restarting does not cost the player their seat', async () => {
  // The Pages client is deployed right behind the server, so a reload can land
  // in the gap. Giving the seat up there is unrecoverable mid-game.
  app.source?.close();
  app.code = null; app.view = null; app.playerId = null; app.connected = false;
  app.everConnected = false; app.retry = 0;
  dom.location.hash = '#/WXYZ';
  dom.storage.set('avalon.player.WXYZ', 'me');
  dom.state.offline = true;

  await client.main();

  assert.equal(app.serverStatus, 'unreachable');
  assert.equal(app.code, 'WXYZ', 'the room is still held');
  assert.equal(dom.localStorage.getItem('avalon.player.WXYZ'), 'me', 'and so is the seat');
  assert.match(dom.fixtures.view.text, /Rejoining room WXYZ/);

  dom.state.offline = false;      // the new process finishes booting
  await tick(700);
  const stream = dom.EventSourceStub.last;
  stream.onmessage({ data: JSON.stringify(frame()) });
  assert.equal(app.connected, true, 'and the game comes back by itself');
  assert.match(dom.fixtures.view.text, /Play a card/);
});

test('a bare reload can re-enter its remembered room while the server is unreachable', async () => {
  app.source?.close();
  app.code = null; app.view = null; app.playerId = null; app.connected = false;
  app.everConnected = false; app.retry = 0; app.heldSeat = null;
  dom.location.hash = '';
  dom.storage.set('avalon.room', 'WXYZ');
  dom.storage.set('avalon.player.WXYZ', 'me');
  dom.state.offline = true;

  await client.main();

  assert.equal(app.serverStatus, 'unreachable');
  assert.deepEqual(app.heldSeat, { code: 'WXYZ', playerId: 'me' });
  assert.ok(dom.fixtures.view.byId('rejoinSeat'), 'the remembered seat stays actionable');

  dom.fixtures.view.byId('rejoinSeat').dispatch('click');
  await tick();

  assert.equal(app.code, 'WXYZ');
  assert.equal(app.playerId, 'me');
  assert.equal(dom.location.hash, '#/WXYZ', 'rejoining restores the routing fragment');
  assert.equal(dom.localStorage.getItem('avalon.player.WXYZ'), 'me');
  assert.match(dom.fixtures.view.text, /Rejoining room WXYZ/);
  dom.state.offline = false;
});

test('a room the server no longer has ends cleanly', async () => {
  app.source?.close();
  app.code = null; app.view = null; app.playerId = null; app.connected = false;
  app.everConnected = false; app.retry = 0;
  dom.location.hash = '#/WXYZ';
  dom.storage.set('avalon.player.WXYZ', 'me');
  dom.state.responses.delete('/api/rooms/WXYZ/join');   // the server answers noSuchRoom

  await client.main();
  await tick();

  assert.equal(app.code, null);
  assert.equal(dom.localStorage.getItem('avalon.player.WXYZ'), null);
  assert.equal(dom.localStorage.getItem('avalon.room'), null);
  assert.match(dom.fixtures.toast.text, /no longer on the server/);
  assert.match(dom.fixtures.view.text, /Create a new room/);
});
