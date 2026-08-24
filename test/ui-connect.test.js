// Joining and reconnecting, in a module that has never rendered a game yet.
// This file is separate on purpose: the bug it guards against only shows on
// the very first frame a room delivers, before anything has been bound.
import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from './dom-shim.js';

const dom = installDom();
const client = await import('../public/app.js');
await client.ready;
const { app, render } = client;

const lobbyFrame = (gameId) => ({
  code: 'WXYZ', gameId, phase: 'lobby', version: 1, hostId: 'me',
  me: { id: 'me', name: '大白' },
  you: { id: 'me', name: '大白', role: null, team: null, awake: false, action: null, acted: false, voted: false },
  players: [{ id: 'me', name: '大白', seat: 0, isLeader: false, onTeam: false }],
  options: {}, optionRoom: 1, deck: { werewolf: 2 }, centreCount: 3, centre: null,
  round: 0, rejects: 0, maxRejects: 5, teamSize: null, failsRequired: null, boardSizes: null,
  team: [], quests: [], lastVote: null, knowledge: [], info: [], swaps: [], votes: [],
  dead: [], winners: [], waitingFor: [], evilCount: null, log: [],
  night: null, pace: 'normal', nightScript: ['nightfall', 'werewolf'], nightSeconds: 30,
});

const nightFrame = () => ({
  ...lobbyFrame('onuw'),
  phase: 'night',
  you: { id: 'me', name: '大白', role: 'seer', team: 'village', awake: true, action: 'seer', acted: false, voted: false },
  night: { index: 1, total: 2, key: 'werewolf', msLeft: 9000, msTotal: 15000 },
});

/** Join a room through the UI and hand back the stream it opened. */
async function joinRoom(gameId, frame) {
  dom.location.hash = '';
  app.code = null; app.view = null; app.connected = false; app.everConnected = false;
  app.serverOk = true; app.lang = 'zh';
  render();

  dom.state.responses.set('/api/rooms/WXYZ/join', { playerId: 'me', code: 'WXYZ' });
  dom.fixtures.view.byId('nameInput').value = '大白';
  dom.fixtures.view.byId('codeInput').value = 'WXYZ';
  dom.fixtures.view.byId('joinBtn').dispatch('click');
  await new Promise((r) => setTimeout(r, 0));

  const stream = dom.EventSourceStub.last;
  assert.ok(stream, 'a stream was opened');
  stream.onmessage({ data: JSON.stringify(frame ?? lobbyFrame(gameId)) });
  return stream;
}

test('the first frame of a werewolf room actually paints', async () => {
  // It used to not. onView() ran before render(), but the werewolf module is
  // only bound *by* render, so the first frame threw and the redraw never
  // happened — leaving the join screen on screen under a "connection lost"
  // banner until switching language forced a repaint.
  await joinRoom('onuw');

  assert.equal(app.view.gameId, 'onuw');
  assert.equal(dom.fixtures.view.byId('nameInput'), null, 'the join form is gone');
  assert.match(dom.fixtures.view.text, /WXYZ/, 'the lobby is on screen');
  assert.match(dom.fixtures.view.text, /大白/);
});

test('the first frame of an Avalon room paints too', async () => {
  await joinRoom('avalon');
  assert.match(dom.fixtures.view.text, /WXYZ/);
  assert.equal(dom.fixtures.view.byId('nameInput'), null);
});

test('a browser that blocks audio still gets its frame drawn', async () => {
  // Browsers can reject media playback until the page gets a user gesture.
  // Announcing runs before paint, so that rejection must not freeze the last
  // screen on display — which is how the first-frame bug looked to the player.
  dom.AudioStub.playError = new Error('playback blocked');
  app.muted = false;

  try {
    await joinRoom('onuw', nightFrame());
    assert.match(dom.fixtures.view.text, /Step 2 of 2|第 2 \/ 2 步/, 'the night was still drawn');
    assert.equal(dom.fixtures.conn.hidden, true, 'and it does not look like a dropped connection');
  } finally {
    dom.AudioStub.playError = null;
    app.view = { ...app.view, night: null };
    const onuw = await import('../public/games/onuw.js');
    onuw.onView();          // stop the countdown interval
  }
});

test('joining shows "connecting", not "connection lost"', async () => {
  dom.location.hash = '';
  app.code = null; app.view = null; app.connected = false; app.everConnected = false;
  app.serverOk = true; app.lang = 'zh';
  render();
  assert.equal(dom.fixtures.conn.hidden, true, 'nothing to report before you join');

  dom.state.responses.set('/api/rooms/WXYZ/join', { playerId: 'me', code: 'WXYZ' });
  dom.fixtures.view.byId('nameInput').value = '大白';
  dom.fixtures.view.byId('codeInput').value = 'WXYZ';
  dom.fixtures.view.byId('joinBtn').dispatch('click');
  await new Promise((r) => setTimeout(r, 0));

  // The stream is open but has not delivered anything yet.
  assert.equal(dom.fixtures.conn.hidden, false);
  assert.match(dom.fixtures.conn.text, /正在连接/, 'a first connection is not a dropped one');
  assert.doesNotMatch(dom.fixtures.conn.text, /中断/);

  dom.EventSourceStub.last.onmessage({ data: JSON.stringify(lobbyFrame('avalon')) });
  assert.equal(dom.fixtures.conn.hidden, true, 'and it goes away once connected');
});

test('a dropped stream says so, and says it below the top bar', async () => {
  const stream = await joinRoom('avalon');
  assert.equal(dom.fixtures.conn.hidden, true);

  stream.onerror?.(new Error('dropped'));
  render();
  assert.equal(dom.fixtures.conn.hidden, false);
  assert.match(dom.fixtures.conn.text, /连接中断/);

  // The banner is its own strip, not a word wedged into the header.
  assert.match(dom.fixtures.conn.className, /conn-banner/);
  assert.match(dom.fixtures.conn.className, /lost/);
});

test('a new front-end version offers a reload button', async () => {
  app.lang = 'en';
  dom.state.frontendVersion = 'new-build';
  assert.equal(await client.checkForUpdate(), true);
  assert.equal(dom.fixtures.update.hidden, false);
  assert.match(dom.fixtures.update.text, /new version/);

  const reload = dom.fixtures.update.byId('reloadVersion');
  assert.equal(reload.text, 'Reload');
  reload.dispatch('click');
  assert.equal(dom.location.reloadCalls, 1);
});
