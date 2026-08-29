import test from 'node:test';
import assert from 'node:assert/strict';

import { Rooms } from '../src/rooms.ts';
import type { AvalonState, Player } from '../src/contracts/types.ts';

function deal(seed: number): AvalonState & { players: Player[] } {
  const rooms = new Rooms({ now: () => 1234 });
  const code = rooms.create('avalon', { code: 'SEED', seed });
  for (let i = 0; i < 7; i++) {
    rooms.dispatch(code, `p${i}`, { type: 'join', id: `p${i}`, name: `Player ${i}` });
  }
  rooms.dispatch(code, 'p0', { type: 'start' });
  const room = rooms.get(code);
  const state = room.game.state;
  if (!('roles' in state)) throw new Error('expected Avalon state');
  return { ...state, players: room.players };
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
