// What a deployment does to an open game, from the browser's side: the stream
// drops, the server comes back a few seconds later, and the room has to be
// there again without anyone touching the page. The old loop reopened the
// stream blindly, so a restart that started empty left every client under a
// "reconnecting" banner that never resolved.
import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from './dom-shim.js';

const dom = installDom();
const client = await import('../src/client/app.ts');
await client.ready;
const { app, render } = client;

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const frame = () => ({
  code: 'WXYZ', gameId: 'avalon', phase: 'lobby', version: 1, hostId: 'me',
  setup: {
    minPlayers: 5, maxPlayers: 10,
    options: ['percival', 'morgana', 'mordred', 'oberon'],
    houseRules: ['randomLeader', 'hiddenVotes', 'resetRejects'],
  },
  me: { id: 'me', name: 'Ann' },
  you: { id: 'me', name: 'Ann', role: null, team: null, awake: false, action: null, acted: false, voted: false },
  players: [{ id: 'me', name: 'Ann', seat: 0, isLeader: false, onTeam: false }],
  options: {}, optionRoom: 1, deck: {}, centreCount: 3, centre: null,
  round: 0, rejects: 0, maxRejects: 5, teamSize: null, failsRequired: null, boardSizes: null,
  team: [], quests: [], lastVote: null, knowledge: [], info: [], swaps: [], votes: [],
  dead: [], winners: [], waitingFor: [], evilCount: null, log: [],
  night: null, pace: 'normal', nightScript: [], nightSeconds: 30,
});

/** Join room WXYZ through the UI and hand back the stream it opened. */
async function joined() {
  dom.state.offline = false;
  dom.location.hash = '';
  app.code = null; app.view = null; app.connected = false; app.everConnected = false;
  app.retry = 0; app.lang = 'en'; app.server = ''; app.serverStatus = 'ready';
  dom.state.responses.set('/api/rooms/WXYZ/join', { playerId: 'me', code: 'WXYZ' });
  dom.state.responses.set('/api/rooms/WXYZ?playerId=me', { exists: true, seated: true });
  render();
  dom.fixtures.view.byId('nameInput').value = 'Ann';
  dom.fixtures.view.byId('codeInput').value = 'WXYZ';
  dom.fixtures.view.byId('joinBtn').dispatch('click');
  await tick();
  const stream = dom.EventSourceStub.last;
  stream.onmessage({ data: JSON.stringify(frame()) });
  dom.calls.length = 0;
  return stream;
}

test('a restart that keeps the room reconnects on its own', async () => {
  const dropped = await joined();

  dom.state.offline = true;      // the service is being replaced
  dropped.onerror(new Error('server went away'));
  assert.equal(app.connected, false);
  assert.match(dom.fixtures.conn.text, /Connection lost/);

  await tick(600);               // first attempt: nothing is answering yet
  assert.equal(dom.EventSourceStub.last, dropped, 'no stream is opened at a dead server');
  assert.ok(dom.calls.some((c) => c.path.startsWith('/api/rooms/WXYZ?')), 'it asks about the room first');

  dom.state.offline = false;     // the new process is up, room and seat restored
  await tick(1200);
  const reopened = dom.EventSourceStub.last;
  assert.notEqual(reopened, dropped, 'the stream is reopened');

  reopened.onmessage({ data: JSON.stringify(frame()) });
  assert.equal(app.connected, true);
  assert.equal(dom.fixtures.conn.hidden, true, 'and the banner goes away');
  assert.equal(app.retry, 0);
});

test('a restart that lost the room says so, instead of retrying forever', async () => {
  const dropped = await joined();
  dom.state.responses.set('/api/rooms/WXYZ?playerId=me', { exists: false, seated: false });

  dropped.onerror(new Error('server went away'));
  await tick(600);

  assert.equal(app.code, null, 'the client stops holding a room that is gone');
  assert.equal(dom.localStorage.getItem('avalon.player.WXYZ'), null, 'and stops holding the seat');
  assert.match(dom.fixtures.toast.text, /Room WXYZ is no longer on the server/);
  assert.match(dom.fixtures.view.text, /Create a new room/, 'the home screen is back');

  await tick(1200);
  assert.equal(dom.EventSourceStub.last, dropped, 'and nothing keeps knocking');
});

test('a room that survived without the seat is re-taken', async () => {
  const dropped = await joined();
  dom.state.responses.set('/api/rooms/WXYZ?playerId=me', { exists: true, seated: false });

  dropped.onerror(new Error('server went away'));
  await tick(600);

  const rejoin = dom.calls.find((c) => c.path === '/api/rooms/WXYZ/join');
  assert.ok(rejoin, 'the seat is claimed again');
  assert.equal(rejoin.body.playerId, 'me', 'under the same id, so the seat and role are kept');
  assert.notEqual(dom.EventSourceStub.last, dropped, 'and the stream follows');
});

test('a paint that throws does not end the reconnect loop', async () => {
  // The loop used to be armed after the redraw, so anything that threw while
  // drawing the dropped state froze the client on a banner forever.
  const dropped = await joined();
  const view = dom.fixtures.view;
  const real = view.replaceChildren.bind(view);
  view.replaceChildren = () => { throw new Error('a panel blew up'); };

  try {
    dropped.onerror(new Error('server went away'));
    await tick(600);
  } finally {
    view.replaceChildren = real;
  }
  assert.notEqual(dom.EventSourceStub.last, dropped, 'it still reconnected');
});

test('coming back to the tab retries immediately', async () => {
  const dropped = await joined();
  dom.state.offline = true;
  dropped.onerror(new Error('server went away'));
  await tick(600);
  await tick(1200);            // a couple of failures, so the backoff is seconds away
  dom.state.offline = false;
  dom.calls.length = 0;

  dom.fire('online');          // the phone is back on the network
  await tick(20);

  assert.ok(dom.calls.some((c) => c.path.startsWith('/api/rooms/WXYZ?')), 'it did not wait out the backoff');
  assert.notEqual(dom.EventSourceStub.last, dropped);
});
