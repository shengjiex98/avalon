import test from 'node:test';
import assert from 'node:assert/strict';

import { gameFor } from '../src/games/index.js';
import { Rooms } from '../src/rooms.js';

function deal(seed) {
  const rooms = new Rooms({ now: () => 1234 });
  const code = rooms.create('avalon', { code: 'SEED', seed });
  for (let i = 0; i < 7; i++) {
    rooms.apply(code, (g) => gameFor(g.gameId).addPlayer(g, { id: `p${i}`, name: `Player ${i}` }));
  }
  rooms.apply(code, (g) => gameFor(g.gameId).actions.start(g, 'p0'));
  const room = rooms.get(code);
  return { ...room.game.state, players: room.players };
}

test('the same seed produces the same deal, seats, and first leader', () => {
  const a = deal(0x12345678);
  const b = deal(0x12345678);
  assert.deepEqual(a.roles, b.roles);
  assert.deepEqual(a.players, b.players);
  assert.equal(a.leaderIndex, b.leaderIndex);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), a);
});

test('different seeds produce different randomized game state', () => {
  const a = deal(1);
  const b = deal(2);
  assert.notDeepEqual(
    { roles: a.roles, players: a.players, leaderIndex: a.leaderIndex },
    { roles: b.roles, players: b.players, leaderIndex: b.leaderIndex },
  );
});
