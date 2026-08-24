// Test mode: several seats held from one browser, so one person can walk a
// whole game through. Every seat is a real player on the server.
import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from './dom-shim.js';

const dom = installDom();
const client = await import('../public/app.js');
await client.ready;
const { app, render } = client;

const frame = (players, viewerId) => ({
  code: 'WXYZ', gameId: 'avalon', phase: 'lobby', version: 1, hostId: players[0].id,
  me: players.find((p) => p.id === viewerId),
  you: { id: viewerId, name: players.find((p) => p.id === viewerId).name, role: null, side: null },
  players: players.map((p, seat) => ({ ...p, seat, isLeader: false, onTeam: false })),
  options: { percival: false, morgana: false, mordred: false, oberon: false },
  round: 0, rejects: 0, maxRejects: 5, teamSize: null, failsRequired: null, boardSizes: null,
  team: [], quests: [], lastVote: null, knowledge: [], assassinTarget: null,
  winner: null, winReason: null, log: [], waitingFor: [], evilCount: null,
});

function atHome({ testMode = false } = {}) {
  // Seats are deliberately remembered across reloads, so clear them per test.
  dom.localStorage.removeItem('avalon.seats.WXYZ');
  dom.localStorage.removeItem('avalon.player.WXYZ');
  dom.location.hash = '';
  app.code = null; app.view = null; app.lang = 'en'; app.server = ''; app.serverStatus = 'ready';
  app.testMode = testMode;
  app.seats = [];
  render();
  return dom.fixtures.view;
}

/** Join as one player and deliver a first frame. */
async function inRoom({ testMode = true } = {}) {
  atHome({ testMode });
  dom.state.responses.set('/api/rooms/WXYZ/join', { playerId: 'p1', code: 'WXYZ' });
  dom.fixtures.view.byId('nameInput').value = 'Ann';
  dom.fixtures.view.byId('codeInput').value = 'WXYZ';
  dom.fixtures.view.byId('joinBtn').dispatch('click');
  await new Promise((r) => setTimeout(r, 0));
  dom.EventSourceStub.last.onmessage({
    data: JSON.stringify(frame([{ id: 'p1', name: 'Ann' }], 'p1')),
  });
  return dom.fixtures.view;
}

const bottomOf = (view) => view.childNodes.at(-1);

test('the toggle sits at the bottom of the page and starts off', () => {
  const view = atHome();
  const bar = bottomOf(view);
  assert.match(bar.className, /test-bar/, 'it is the last thing on the page');
  assert.match(bar.text, /Test mode · off/);
  assert.ok(!/Add a player/.test(bar.text), 'nothing else until you turn it on');
});

test('turning it on says what it is for, and that it needs a room', () => {
  const view = atHome();
  view.byId('testToggle').dispatch('click');

  const bar = bottomOf(dom.fixtures.view);
  assert.match(bar.text, /Test mode · on/);
  assert.match(bar.text, /walk a whole game through on your own/);
  assert.match(bar.text, /Create or join a room first/);
  assert.equal(dom.localStorage.getItem('avalon.test'), '1', 'it stays on across reloads');

  bottomOf(dom.fixtures.view).byId('testToggle').dispatch('click');
  assert.equal(app.testMode, false);
  assert.equal(dom.localStorage.getItem('avalon.test'), '');
});

test('it is in Chinese too', () => {
  atHome({ testMode: true });
  app.lang = 'zh';
  render();
  assert.match(bottomOf(dom.fixtures.view).text, /测试模式 · 开/);
  app.lang = 'en';
});

test('joining a room records the seat you took', async () => {
  await inRoom();
  assert.deepEqual(app.seats, [{ id: 'p1', name: 'Ann' }]);
  assert.deepEqual(dom.localStorage.getItem('avalon.seats.WXYZ'), '[{"id":"p1","name":"Ann"}]');
  assert.match(bottomOf(dom.fixtures.view).text, /Acting as/);
});

test('adding a player really joins the room again', async () => {
  await inRoom();
  dom.state.responses.set('/api/rooms/WXYZ/join', { playerId: 'p2', code: 'WXYZ' });
  dom.calls.length = 0;

  bottomOf(dom.fixtures.view).byId('testAdd').dispatch('click');
  await new Promise((r) => setTimeout(r, 0));

  const joined = dom.calls.find((c) => c.path === '/api/rooms/WXYZ/join');
  assert.ok(joined, 'it goes through the ordinary join endpoint');
  assert.equal(joined.body.name, 'Test 2', 'named after the seat it fills');
  assert.equal(joined.body.playerId, undefined, 'and asks for a new identity');
  assert.deepEqual(app.seats.map((s) => s.name), ['Ann', 'Test 2']);
});

test('the new seat does not collide with a name already at the table', async () => {
  await inRoom();
  // Someone at the table is already called "Test 2".
  dom.EventSourceStub.last.onmessage({
    data: JSON.stringify(frame([{ id: 'p1', name: 'Ann' }, { id: 'px', name: 'Test 2' }], 'p1')),
  });
  dom.state.responses.set('/api/rooms/WXYZ/join', { playerId: 'p3', code: 'WXYZ' });
  dom.calls.length = 0;

  bottomOf(dom.fixtures.view).byId('testAdd').dispatch('click');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(dom.calls.find((c) => c.path.endsWith('/join')).body.name, 'Test 3');
});

test('switching seats reopens the stream as that player', async () => {
  await inRoom();
  dom.state.responses.set('/api/rooms/WXYZ/join', { playerId: 'p2', code: 'WXYZ' });
  bottomOf(dom.fixtures.view).byId('testAdd').dispatch('click');
  await new Promise((r) => setTimeout(r, 0));

  const chips = () => bottomOf(dom.fixtures.view).byClass('seat-chip');
  assert.deepEqual(chips().map((c) => c.text), ['Ann', 'Test 2']);
  assert.match(chips()[0].className, /primary/, 'the seat you are in is marked');
  assert.doesNotMatch(chips()[1].className, /primary/);

  chips()[1].dispatch('click');
  assert.equal(app.playerId, 'p2');
  assert.match(dom.EventSourceStub.last.url, /playerId=p2/, 'the stream follows the seat');
  assert.equal(dom.localStorage.getItem('avalon.player.WXYZ'), 'p2', 'a refresh comes back here');
  assert.match(chips()[1].className, /primary/);
});

test('refreshing after switching seats preserves the test player name', async () => {
  await inRoom();
  dom.state.responses.set('/api/rooms/WXYZ/join', { playerId: 'p2', code: 'WXYZ' });
  bottomOf(dom.fixtures.view).byId('testAdd').dispatch('click');
  await new Promise((r) => setTimeout(r, 0));
  bottomOf(dom.fixtures.view).byClass('seat-chip')[1].dispatch('click');

  // Re-run boot with only persisted browser state, as a page refresh would.
  dom.location.hash = '#/WXYZ';
  app.source?.close();
  app.code = null;
  app.playerId = null;
  app.view = null;
  app.source = null;
  app.seats = [];
  dom.calls.length = 0;
  await client.main();

  const rejoined = dom.calls.find((c) => c.path === '/api/rooms/WXYZ/join');
  assert.equal(rejoined.body.playerId, 'p2');
  assert.equal(rejoined.body.name, 'Test 2', 'the selected seat keeps its own name');
});

test('seats cannot be added once the game is running', async () => {
  await inRoom();
  const table = ['Ann', 'Bo', 'Cai', 'Dee', 'Eli'].map((name, i) => ({ id: `p${i + 1}`, name }));
  dom.EventSourceStub.last.onmessage({
    data: JSON.stringify({
      ...frame(table, 'p1'),
      phase: 'reveal',
      you: { id: 'p1', name: 'Ann', role: 'merlin', side: 'good' },
      teamSize: 2, failsRequired: 1, evilCount: 2,
      boardSizes: [2, 3, 2, 3, 3].map((size) => ({ size, twoFails: false })),
    }),
  });
  const add = bottomOf(dom.fixtures.view).byId('testAdd');
  assert.equal(add.disabled, true);
  assert.match(add.text, /only be added before the game starts/);
});

test('a room full error is reported rather than swallowed', async () => {
  await inRoom();
  dom.state.responses.delete('/api/rooms/WXYZ/join');   // the stub then 400s
  bottomOf(dom.fixtures.view).byId('testAdd').dispatch('click');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(dom.fixtures.toast.hidden, false);
  assert.deepEqual(app.seats.map((s) => s.name), ['Ann'], 'no phantom seat is recorded');
});
