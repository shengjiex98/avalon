// The room layer's clock. One Night Werewolf's night has to advance on its
// own, with every player sitting still.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Rooms } from '../src/rooms.js';
import { NIGHT_SCRIPT } from '../src/games/onuw/rules.js';

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

test('a night advances on the room\'s own clock, with nobody pressing anything', async () => {
  const rooms = new Rooms();
  const { code, room } = startedGame(rooms);
  rooms.apply(code, (g) => gameFor(g.gameId).actions.start(g, 'p0'));
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

  const seen = [];
  rooms.subscribe(code, 'p1', (view) => seen.push(view.night?.key ?? view.phase));
  assert.deepEqual(seen, ['nightfall']);

  rooms.apply(code, (g) => { g.stepEndsAt = Date.now() + 40; });
  await sleep(160);
  assert.ok(seen.length > 1, 'the step change was broadcast');
  assert.equal(seen.at(-1), NIGHT_SCRIPT[1].key);
});

test('a swept room takes its timer with it', async () => {
  const rooms = new Rooms();
  const { code, room } = startedGame(rooms);
  rooms.apply(code, (g) => gameFor(g.gameId).actions.start(g, 'p0'));
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
