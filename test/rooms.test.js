// The room layer's clock. One Night Werewolf's night has to advance on its
// own, with every player sitting still.
import test from 'node:test';
import assert from 'node:assert/strict';

import { record } from '../src/lobby.js';
import { Rooms } from '../src/rooms.js';
import * as avalon from '../src/games/avalon/game.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startedGame(rooms) {
  const code = rooms.create('onuw');
  const room = rooms.get(code);
  ['Ann', 'Bo', 'Cai'].forEach((name, i) =>
    rooms.apply(code, (g) => require_addPlayer(g, i, name)));
  rooms.apply(code, (g) => { g.room.hostId = 'p0'; });
  return { code, room };
}

// The room layer exposes games only through the registry, so reach for it the
// same way the server does.
import { gameFor } from '../src/games/index.js';
const require_addPlayer = (g, i, name) => gameFor(g.room.game.id).addPlayer(g, { id: `p${i}`, name });
const readyEveryone = (rooms, code, room) => {
  for (const p of room.players) rooms.apply(code, (g) => gameFor(g.room.game.id).actions.confirm(g, p.id));
};

test('starting deals roles but schedules no timer until everyone is ready', () => {
  const rooms = new Rooms();
  const { code, room } = startedGame(rooms);
  rooms.apply(code, (g) => gameFor(g.room.game.id).actions.start(g, 'p0'));

  assert.equal(room.game.state.phase, 'reveal');
  assert.equal(room.timer, null);
  rooms.apply(code, (g) => gameFor(g.room.game.id).actions.confirm(g, 'p0'));
  rooms.apply(code, (g) => gameFor(g.room.game.id).actions.confirm(g, 'p1'));
  assert.equal(room.timer, null, 'a partial table must not start the clock');

  rooms.apply(code, (g) => gameFor(g.room.game.id).actions.confirm(g, 'p2'));
  assert.equal(room.game.state.phase, 'night');
  assert.ok(room.timer, 'the final ready schedules the first step');
});

test('a night advances on the room\'s own clock, with nobody pressing anything', async () => {
  const rooms = new Rooms();
  const { code, room } = startedGame(rooms);
  rooms.apply(code, (g) => gameFor(g.room.game.id).actions.start(g, 'p0'));
  readyEveryone(rooms, code, room);
  assert.equal(room.game.state.phase, 'night');
  assert.equal(room.game.state.step, 0);

  // Bring the first deadline forward instead of waiting six real seconds.
  rooms.apply(code, (g) => { g.state.stepEndsAt = Date.now() + 40; });
  await sleep(160);
  assert.ok(room.game.state.step > 0, 'the night moved on by itself');
});

test('subscribers are pushed the new step without asking', async () => {
  const rooms = new Rooms();
  const { code, room } = startedGame(rooms);
  rooms.apply(code, (g) => gameFor(g.room.game.id).actions.start(g, 'p0'));
  readyEveryone(rooms, code, room);

  const seen = [];
  rooms.subscribe(code, 'p1', (view) => seen.push(view.night?.key ?? view.phase));
  assert.deepEqual(seen, ['nightfall']);

  rooms.apply(code, (g) => { g.state.stepEndsAt = Date.now() + 40; });
  await sleep(160);
  assert.ok(seen.length > 1, 'the step change was broadcast');
  assert.equal(seen.at(-1), room.game.state.script[1].key);
});

test('a swept room takes its timer with it', async () => {
  const rooms = new Rooms();
  const { code, room } = startedGame(rooms);
  rooms.apply(code, (g) => gameFor(g.room.game.id).actions.start(g, 'p0'));
  readyEveryone(rooms, code, room);
  assert.ok(room.timer, 'a night schedules a wake-up');

  room.touchedAt = Date.now() - 24 * 60 * 60 * 1000;
  rooms.sweep();
  assert.equal(rooms.has(code), false);
  await sleep(50);   // nothing should fire for a room that no longer exists
});

test('a game with no clock schedules nothing', () => {
  const rooms = new Rooms();
  const code = rooms.create('avalon');
  rooms.apply(code, (g) => gameFor(g.room.game.id).addPlayer(g, { id: 'p0', name: 'Ann' }));
  assert.equal(rooms.get(code).timer, null);
});

test('dispatch records successful player input in order but never exposes it', () => {
  let clock = 100;
  const rooms = new Rooms({ now: () => clock });
  const code = rooms.create('avalon', { code: 'LGGS', seed: 7 });

  rooms.dispatch(code, 'p0', { type: 'join', id: 'p0', name: 'Ann' });
  clock = 200;
  rooms.dispatch(code, 'p1', { type: 'join', id: 'p1', name: 'Bob' });
  clock = 300;
  rooms.dispatch(code, 'p0', { type: 'options', options: { percival: true } });
  clock = 400;
  rooms.setGame(code, 'p0', 'onuw');

  const room = rooms.get(code);
  assert.deepEqual(room.journal, [
    { t: 'join', p: 'p0', b: { id: 'p0', name: 'Ann' }, at: 100 },
    { t: 'join', p: 'p1', b: { id: 'p1', name: 'Bob' }, at: 200 },
    { t: 'options', p: 'p0', b: { options: { percival: true } }, at: 300 },
    { t: 'setGame', p: 'p0', b: { game: 'onuw' }, at: 400 },
  ]);
  assert.equal('actions' in gameFor(room.game.id).view(room, 'p0'), false);

  const before = room.journal.slice();
  assert.throws(() => rooms.dispatch(code, 'p0', { type: 'confirm' }), { key: 'wrongPhase' });
  assert.deepEqual(room.journal, before, 'rejected input is not replayable state');
});

test('the replay record is dropped whole rather than kept partially on overflow', () => {
  const game = avalon.createGame('CAP', { seed: 1 });
  for (let i = 0; i <= 2000; i++) record(game, 'p0', { type: 'vote', approve: true }, i);
  assert.deepEqual(game.room.journal, []);
  assert.equal(game.room.journalDropped, true);
  record(game, 'p0', { type: 'vote', approve: false }, 2001);
  assert.deepEqual(game.room.journal, []);
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

// ---------------------------------------------------------------- identity

test('an unrecognized game id is refused rather than quietly played as Avalon', () => {
  const rooms = new Rooms();
  assert.throws(() => gameFor('werewolf'), { key: 'noSuchGame', params: { game: 'werewolf' } });
  assert.throws(() => gameFor(undefined), { key: 'noSuchGame' });
  assert.throws(() => rooms.create('werewolf'), { key: 'noSuchGame' });

  const code = rooms.create('avalon', { code: 'SWAP' });
  rooms.dispatch(code, 'p0', { type: 'join', id: 'p0', name: 'Ann' });
  assert.throws(() => rooms.setGame(code, 'p0', 'werewolf'), { key: 'noSuchGame' });
  assert.equal(rooms.get(code).game.id, 'avalon', 'a refused switch changes nothing');
});

test('a deadline of zero still schedules a tick', () => {
  const rooms = new Rooms({ now: () => 0 });
  const code = rooms.create('onuw', { code: 'ZERA' });
  const room = rooms.get(code);

  room.game.state.phase = 'night';
  room.game.state.stepEndsAt = 0;
  rooms.scheduleTick(code);
  assert.notEqual(room.timer, null, 'zero is a deadline, not an absent one');
  clearTimeout(room.timer);

  room.game.state.phase = 'lobby';
  rooms.scheduleTick(code);
  assert.equal(room.timer, null, 'no deadline means no clock');
});

test('a colliding code is retried, and an exhausted space is reported', () => {
  const candidates = ['AAAA', 'AAAA', 'AAAA', 'BBBB'];
  let issued = 0;
  const rooms = new Rooms({ newCode: () => candidates[Math.min(issued++, candidates.length - 1)] });

  assert.equal(rooms.create('avalon'), 'AAAA');
  assert.equal(rooms.create('avalon'), 'BBBB', 'a taken code is never handed out twice');
  assert.equal(rooms.rooms.size, 2);

  const stuck = new Rooms({ newCode: () => 'AAAA' });
  stuck.create('avalon');
  assert.throws(() => stuck.create('avalon'), { key: 'roomsFull' });
  assert.equal(stuck.rooms.size, 1, 'a failed allocation leaves the registry alone');
});

test('allocated codes keep the four-character alphabet players read aloud', () => {
  const rooms = new Rooms();
  for (let i = 0; i < 200; i++) assert.match(rooms.create('avalon'), /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
  assert.equal(rooms.rooms.size, 200, 'every host got a code of their own');
});
