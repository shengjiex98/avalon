import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAction, parseCreateRoom, parseJoin } from '../src/server/commands.ts';

const rejects = (fn, key = 'badRequest') => assert.throws(fn, (error) => error?.key === key);

test('HTTP schemas reject malformed envelopes and required payloads', () => {
  for (const value of [null, [], 'avalon', { game: 1 }]) rejects(() => parseCreateRoom(value));
  for (const value of [null, [], {}, { name: [] }, { name: 'Ann', avatar: true }]) {
    rejects(() => parseJoin(value));
  }
  for (const value of [
    null,
    { type: 'propose', playerId: 'p0' },
    { type: 'vote', playerId: 'p0', approve: 'yes' },
    { type: 'options', playerId: 'p0', options: { percival: 1 } },
  ]) rejects(() => parseAction('avalon', value));
  for (const value of [
    { type: 'night', playerId: 'p0', action: {} },
    { type: 'night', playerId: 'p0', action: { mode: 'player' } },
    { type: 'night', playerId: 'p0', action: { mode: 'centre', centres: [0] } },
  ]) rejects(() => parseAction('onuw', value));
});

test('an action belonging to the other game stays an unknown action', () => {
  rejects(() => parseAction('avalon', {
    type: 'night', playerId: 'p0', action: { skip: true },
  }), 'unknownAction');
  rejects(() => parseAction('onuw', {
    type: 'propose', playerId: 'p0', team: ['p0'],
  }), 'unknownAction');
});

test('HTTP schemas strip unknown keys at each object layer', () => {
  assert.deepEqual(parseCreateRoom({ game: 'avalon', ignored: true }), { game: 'avalon' });
  assert.deepEqual(parseJoin({ name: 'Ann', playerId: null, ignored: true }), {
    name: 'Ann', playerId: undefined,
  });
  assert.deepEqual(parseAction('avalon', {
    type: 'options', playerId: 'p0', ignored: true,
    options: { percival: true, ignored: true, houseRules: { hiddenVotes: true, ignored: true } },
  }), {
    type: 'options', playerId: 'p0',
    options: { percival: true, houseRules: { hiddenVotes: true } },
  });
});
