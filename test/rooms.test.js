// The room layer's clock. One Night Werewolf's night has to advance on its
// own, with every player sitting still.
import test from 'node:test';
import assert from 'node:assert/strict';

import { record } from '../src/lobby.js';
import { Rooms } from '../src/rooms.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startedGame(rooms) {
  const code = rooms.create('onuw');
  const room = rooms.get(code);
  ['Ann', 'Bo', 'Cai'].forEach((name, i) =>
    rooms.apply(code, (g) => require_addPlayer(g, i, name)));
  rooms.apply(code, (g) => { g.hostId = 'p0'; });
  return { code, room };
}

// The room layer exposes games only through the registry, so reach for it the
// same way the server does.
import { gameFor } from '../src/games/index.js';
const require_addPlayer = (g, i, name) => gameFor(g.gameId).addPlayer(g, { id: `p${i}`, name });
const readyEveryone = (rooms, code, game) => {
  for (const p of game.players) rooms.apply(code, (g) => gameFor(g.gameId).actions.confirm(g, p.id));
};

test('starting deals roles but schedules no timer until everyone is ready', () => {
  const rooms = new Rooms();
  const { code, room } = startedGame(rooms);
  rooms.apply(code, (g) => gameFor(g.gameId).actions.start(g, 'p0'));

  assert.equal(room.game.phase, 'reveal');
  assert.equal(room.timer, null);
  rooms.apply(code, (g) => gameFor(g.gameId).actions.confirm(g, 'p0'));
  rooms.apply(code, (g) => gameFor(g.gameId).actions.confirm(g, 'p1'));
  assert.equal(room.timer, null, 'a partial table must not start the clock');

  rooms.apply(code, (g) => gameFor(g.gameId).actions.confirm(g, 'p2'));
  assert.equal(room.game.phase, 'night');
  assert.ok(room.timer, 'the final ready schedules the first step');
});

test('a night advances on the room\'s own clock, with nobody pressing anything', async () => {
  const rooms = new Rooms();
  const { code, room } = startedGame(rooms);
  rooms.apply(code, (g) => gameFor(g.gameId).actions.start(g, 'p0'));
  readyEveryone(rooms, code, room.game);
  assert.equal(room.game.phase, 'night');
  assert.equal(room.game.step, 0);

  // Bring the first deadline forward instead of waiting six real seconds.
  rooms.apply(code, (g) => { g.stepEndsAt = Date.now() + 40; });
  await sleep(160);
  assert.ok(room.game.step > 0, 'the night moved on by itself');
});

test('subscribers are pushed the new step without asking', async () => {
  const rooms = new Rooms();
  const { code, room } = startedGame(rooms);
  rooms.apply(code, (g) => gameFor(g.gameId).actions.start(g, 'p0'));
  readyEveryone(rooms, code, room.game);

  const seen = [];
  rooms.subscribe(code, 'p1', (view) => seen.push(view.night?.key ?? view.phase));
  assert.deepEqual(seen, ['nightfall']);

  rooms.apply(code, (g) => { g.stepEndsAt = Date.now() + 40; });
  await sleep(160);
  assert.ok(seen.length > 1, 'the step change was broadcast');
  assert.equal(seen.at(-1), room.game.script[1].key);
});

test('a swept room takes its timer with it', async () => {
  const rooms = new Rooms();
  const { code, room } = startedGame(rooms);
  rooms.apply(code, (g) => gameFor(g.gameId).actions.start(g, 'p0'));
  readyEveryone(rooms, code, room.game);
  assert.ok(room.timer, 'a night schedules a wake-up');

  room.touchedAt = Date.now() - 24 * 60 * 60 * 1000;
  rooms.sweep();
  assert.equal(rooms.has(code), false);
  await sleep(50);   // nothing should fire for a room that no longer exists
});

test('a game with no clock schedules nothing', () => {
  const rooms = new Rooms();
  const code = rooms.create('avalon');
  rooms.apply(code, (g) => gameFor(g.gameId).addPlayer(g, { id: 'p0', name: 'Ann' }));
  assert.equal(rooms.get(code).timer, null);
});

test('dispatch records successful player input in order but never exposes it', () => {
  let clock = 100;
  const rooms = new Rooms({ now: () => clock });
  const code = rooms.create('avalon', { code: 'LOGS', seed: 7 });

  rooms.dispatch(code, 'p0', { type: 'join', id: 'p0', name: 'Ann' });
  clock = 200;
  rooms.dispatch(code, 'p1', { type: 'join', id: 'p1', name: 'Bob' });
  clock = 300;
  rooms.dispatch(code, 'p0', { type: 'options', options: { percival: true } });
  clock = 400;
  rooms.setGame(code, 'p0', 'onuw');

  const game = rooms.get(code).game;
  assert.deepEqual(game.actions, [
    { t: 'join', p: 'p0', b: { id: 'p0', name: 'Ann' }, at: 100 },
    { t: 'join', p: 'p1', b: { id: 'p1', name: 'Bob' }, at: 200 },
    { t: 'options', p: 'p0', b: { options: { percival: true } }, at: 300 },
    { t: 'setGame', p: 'p0', b: { game: 'onuw' }, at: 400 },
  ]);
  assert.equal('actions' in gameFor(game.gameId).viewFor(game, 'p0'), false);

  const before = game.actions.slice();
  assert.throws(() => rooms.dispatch(code, 'p0', { type: 'confirm' }), { key: 'wrongPhase' });
  assert.deepEqual(game.actions, before, 'rejected input is not replayable state');
});

test('the replay record is dropped whole rather than kept partially on overflow', () => {
  const game = gameFor('avalon').create('CAP', { seed: 1 });
  for (let i = 0; i <= 2000; i++) record(game, 'p0', { type: 'vote', approve: true }, i);
  assert.deepEqual(game.actions, []);
  assert.equal(game.actionsDropped, true);
  record(game, 'p0', { type: 'vote', approve: false }, 2001);
  assert.deepEqual(game.actions, []);
});

test('the persistence hook runs only after registry mutations', () => {
  let clock = 10 * 60 * 60_000;
  let mutations = 0;
  const rooms = new Rooms({ now: () => clock, onMutate: () => { mutations += 1; } });
  const code = rooms.create('avalon', { code: 'SAVE' });
  assert.equal(mutations, 1);
  rooms.dispatch(code, 'p0', { type: 'join', id: 'p0', name: 'Ann' });
  assert.equal(mutations, 2);

  rooms.rooms.get(code).touchedAt = 0;
  rooms.sweep();
  assert.equal(mutations, 3);
  rooms.sweep();
  assert.equal(mutations, 3, 'a no-op sweep does not write another snapshot');
});
