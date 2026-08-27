// Renders the real client into a DOM shim. These are the tests that would have
// caught a name field stranded inside the "create a room" card.
import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from './dom-shim.js';

const dom = installDom();
const client = await import('../public/app.js');
await client.ready;

const { app, render } = client;

/** Draw the home screen fresh, optionally as if arriving on a shared link. */
function home({ hash = '', lang = 'en' } = {}) {
  dom.location.hash = hash;
  dom.location.href = 'http://localhost:8420/' + hash;
  app.lang = lang;
  app.server = '';
  app.serverStatus = 'ready';
  app.code = null;
  app.view = null;
  dom.calls.length = 0;
  render();
  return dom.fixtures.view;
}

const inputs = (node) => node.findAll((n) => n.tagName === 'INPUT');
const NAMES = ['Ann', '张三', 'Cai', 'Dee', 'Eli'];

/** A lobby view as the server would send it to `viewerId`. */
function lobbyView(viewerId, count = 2) {
  const players = NAMES.slice(0, count).map((name, seat) => ({
    id: `p${seat + 1}`, name, seat, isLeader: false, onTeam: false,
  }));
  const me = players.find((p) => p.id === viewerId);
  return {
    code: 'WXYZ', phase: 'lobby', hostId: 'p1',
    you: { id: me.id, name: me.name, role: null, side: null },
    players,
    options: { percival: false, morgana: false, mordred: false, oberon: false },
    round: 0, rejects: 0, maxRejects: 5, teamSize: null, failsRequired: null,
    boardSizes: null, team: [], quests: [], lastVote: null, knowledge: [],
    assassinTarget: null, winner: null, winReason: null, log: [], waitingFor: [], evilCount: null,
  };
}
const buttons = (node) => node.findAll((n) => n.tagName === 'BUTTON');
/** The nearest ancestor card, which is how the UI groups things visually. */
const cardOf = (node) => {
  for (let n = node; n; n = n.parentNode) if (n.className?.split(/\s+/).includes('card')) return n;
  return null;
};

test('the home screen asks for a name exactly once', () => {
  const view = home();
  const nameFields = inputs(view).filter((i) => i.id === 'nameInput');
  assert.equal(nameFields.length, 1);
  assert.deepEqual(inputs(view).map((i) => i.id), ['nameInput', 'codeInput']);
});

test('the name field governs both actions instead of belonging to "create"', () => {
  // The original bug: name lived in the create card, so joining with a code
  // meant typing your name into a box labelled "create a room".
  const view = home();
  const name = view.byId('nameInput');
  const code = view.byId('codeInput');
  const create = view.byId('createBtn');

  const card = cardOf(name);
  assert.ok(card, 'the name field is inside a card');
  assert.equal(cardOf(code), card, 'the code field shares that card');
  assert.equal(cardOf(create), card, 'so does the create button');
});

test('the name field comes before both actions', () => {
  const view = home();
  const order = [...view.walk()].filter((n) => ['nameInput', 'createBtn', 'codeInput', 'joinBtn'].includes(n.id));
  assert.deepEqual(order.map((n) => n.id), ['nameInput', 'createBtn', 'codeInput', 'joinBtn']);
});

test('with no invite, creating is the primary action and the code box is empty', () => {
  const view = home();
  assert.match(view.byId('createBtn').className, /primary/);
  assert.doesNotMatch(view.byId('joinBtn').className, /primary/);
  assert.equal(view.byId('codeInput').value, '');
  assert.equal(view.byId('joinBtn').text, 'Join');
});

test('a shared link prefills the code and makes joining the primary action', () => {
  const view = home({ hash: '#/WXYZ' });
  assert.equal(view.byId('codeInput').value, 'WXYZ');
  assert.match(view.byId('joinBtn').className, /primary/);
  assert.doesNotMatch(view.byId('createBtn').className, /primary/);
  assert.equal(view.byId('joinBtn').text, 'Join room WXYZ');
  assert.match(view.text, /invited to room WXYZ/);
});

test('joining sends the name typed into the shared field', async () => {
  const view = home({ hash: '#/WXYZ' });
  view.byId('nameInput').value = 'Ann';
  dom.state.responses.set('/api/rooms/WXYZ/join', { playerId: 'pid-1', code: 'WXYZ' });

  view.byId('joinBtn').dispatch('click');
  await new Promise((r) => setTimeout(r, 0));

  const join = dom.calls.find((c) => c.path === '/api/rooms/WXYZ/join');
  assert.ok(join, 'the join endpoint was called');
  assert.equal(join.body.name, 'Ann');
});

test('joining without a name asks for one instead of calling the server', async () => {
  const view = home();
  dom.localStorage.removeItem('avalon.name');
  render();
  dom.fixtures.view.byId('nameInput').value = '   ';
  dom.fixtures.view.byId('codeInput').value = 'WXYZ';
  dom.calls.length = 0;

  dom.fixtures.view.byId('joinBtn').dispatch('click');
  await new Promise((r) => setTimeout(r, 0));

  assert.deepEqual(dom.calls, [], 'nothing was sent');
  assert.equal(dom.fixtures.toast.hidden, false);
  assert.match(dom.fixtures.toast.text, /enter a name/i);
});

test('pressing Enter in the name field triggers the action that fits', async () => {
  const view = home({ hash: '#/WXYZ' });
  view.byId('nameInput').value = 'Ann';
  dom.state.responses.set('/api/rooms/WXYZ/join', { playerId: 'pid-1', code: 'WXYZ' });
  view.byId('nameInput').dispatch('keydown', { key: 'Enter' });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(dom.calls.some((c) => c.path === '/api/rooms/WXYZ/join'), 'an invite link joins');

  const fresh = home();
  fresh.byId('nameInput').value = 'Ann';
  dom.state.responses.set('/api/rooms', { code: 'NEW1' });
  fresh.byId('nameInput').dispatch('keydown', { key: 'Enter' });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(dom.calls.some((c) => c.path === '/api/rooms' && c.method === 'POST'), 'otherwise it creates');
});

test('the language toggle redraws the whole screen in Chinese', () => {
  home();
  assert.match(dom.fixtures.view.text, /Create a new room/);
  dom.fixtures.langToggle.dispatch('click');
  assert.match(dom.fixtures.view.text, /创建新房间/);
  assert.match(dom.fixtures.view.text, /输入房间号加入|加入/);
  dom.fixtures.langToggle.dispatch('click');
  assert.match(dom.fixtures.view.text, /Create a new room/);
});

test('the Pages client asks for one HTTPS game server', () => {
  home();
  app.serverStatus = 'unreachable';
  render();
  const view = dom.fixtures.view;
  assert.equal(view.byId('nameInput'), null);
  assert.ok(view.byId('serverInput'));
  assert.match(view.text, /HTTPS address/);
});

test('the Pages client remembers a compatible server', async () => {
  home();
  app.serverStatus = 'unreachable';
  render();
  const view = dom.fixtures.view;
  view.byId('serverInput').value = 'https://games.example.com/path';
  buttons(view).find((button) => button.text === 'Connect').dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(app.server, 'https://games.example.com');
  assert.equal(app.serverStatus, 'ready');
  assert.equal(dom.localStorage.getItem('avalon.server'), 'https://games.example.com');
});

test('an incompatible server reports both protocol versions', () => {
  home();
  app.serverStatus = 'incompatible';
  app.serverProtocol = 3;
  render();
  assert.match(dom.fixtures.view.text, /protocol 2.*server uses 3/);
});

test('the lobby shows the room code and every player', () => {
  home();
  app.code = 'WXYZ';
  app.playerId = 'p1';
  app.view = lobbyView(app.playerId);
  render();
  const view = dom.fixtures.view;
  assert.match(view.text, /WXYZ/);
  assert.match(view.text, /Ann/);
  assert.match(view.text, /张三/, 'a Chinese name renders in the English UI');
  assert.match(view.text, /Players \(2\)/);
  // Two players is not a game, so the host's button says why rather than lying.
  const action = buttons(view).find((b) => /Need at least|Start game/.test(b.text));
  assert.equal(action.text, 'Need at least 5 players (2 so far)');
  assert.equal(action.disabled, true);
});

test('the host can start once five players are in', () => {
  home();
  app.code = 'WXYZ';
  app.playerId = 'p1';
  app.view = lobbyView('p1', 5);
  render();
  const action = buttons(dom.fixtures.view).find((b) => /Need at least|Start game/.test(b.text));
  assert.equal(action.text, 'Start game');
  assert.equal(action.disabled, false);
});

test('a non-host waits instead of seeing a start button', () => {
  home();
  app.code = 'WXYZ';
  app.playerId = 'p2';
  app.view = lobbyView(app.playerId);
  render();
  const view = dom.fixtures.view;
  assert.ok(!buttons(view).some((b) => b.text.includes('Start game')));
  assert.match(view.text, /Waiting for the host/);
});
