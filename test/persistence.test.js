import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as avalon from '../src/games/avalon/game.js';
import { gameFor } from '../src/games/index.js';
import * as onuw from '../src/games/onuw/game.js';
import { load, save } from '../src/persistence.js';
import { Rooms } from '../src/rooms.js';
import { STATE_VERSION } from '../src/state-version.js';

const serializable = (game, point) => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(game)), game, point);
};

test('Avalon state stays plain JSON data throughout a game', () => {
  const game = avalon.createGame('JSON', { now: () => 1_000 });
  for (let i = 0; i < 5; i++) {
    avalon.addPlayer(game, { id: `p${i}`, name: `Player ${i}` });
  }
  serializable(game, 'lobby');

  avalon.startGame(game, 'p0', { shuffle: (list) => list });
  for (const player of game.players) avalon.confirmRole(game, player.id);
  serializable(game, 'mid-game');

  while (game.phase !== 'over') {
    const leader = game.players[game.leaderIndex].id;
    avalon.proposeTeam(game, leader, game.players.slice(0, avalon.currentTeamSize(game)).map((p) => p.id));
    for (const player of game.players) avalon.castVote(game, player.id, false);
  }
  serializable(game, 'over');
});

test('ONUW state stays plain JSON data throughout a game', () => {
  let clock = 2_000;
  const now = () => clock;
  const game = onuw.createGame('JSON', { now });
  for (let i = 0; i < 3; i++) {
    onuw.addPlayer(game, { id: `p${i}`, name: `Player ${i}` });
  }
  serializable(game, 'lobby');

  onuw.startGame(game, 'p0', { shuffle: (list) => list, now });
  for (const player of game.players) onuw.confirmRole(game, player.id, { now });
  serializable(game, 'mid-game');

  clock += 10 * 60_000;
  onuw.tick(game, clock);
  onuw.startVote(game, 'p0');
  onuw.castVote(game, 'p0', 'p1');
  onuw.castVote(game, 'p1', 'p0');
  onuw.castVote(game, 'p2', 'p0');
  serializable(game, 'over');
});

test('rooms save and restore with views, activity, clocks, and idle age intact', async () => {
  let clock = 50_000;
  const now = () => clock;
  const rooms = new Rooms({ now });
  const nightCode = rooms.create('onuw', { code: 'NITE', seed: 123 });
  for (let i = 0; i < 3; i++) {
    rooms.dispatch(nightCode, `p${i}`, { type: 'join', id: `p${i}`, name: `Player ${i}` });
  }
  rooms.dispatch(nightCode, 'p0', { type: 'start' });
  for (let i = 0; i < 3; i++) rooms.dispatch(nightCode, `p${i}`, { type: 'confirm' });

  const lobbyCode = rooms.create('avalon', { code: 'WAIT', seed: 456 });
  rooms.dispatch(lobbyCode, 'host', { type: 'join', id: 'host', name: 'Host' });
  const oldTouch = clock - 5 * 60 * 60_000;
  rooms.rooms.get(lobbyCode).touchedAt = oldTouch;

  const expectedViews = Object.fromEntries(
    rooms.rooms.get(nightCode).game.players.map((p) => [
      p.id,
      gameFor('onuw').viewFor(rooms.rooms.get(nightCode).game, p.id, clock),
    ]),
  );
  const expectedActive = rooms.activeGameCount();
  const dir = await mkdtemp(join(tmpdir(), 'avalon-persistence-'));
  const file = join(dir, 'rooms.json');
  save(rooms, file);

  const restored = new Rooms({ now });
  assert.deepEqual(load(restored, file), { restored: 2, reason: null });
  assert.deepEqual(restored.rooms.get(nightCode).game, rooms.rooms.get(nightCode).game);
  assert.equal(restored.activeGameCount(), expectedActive);
  assert.equal(restored.rooms.get(lobbyCode).touchedAt, oldTouch);
  assert.equal(restored.rooms.get(lobbyCode).timer, null, 'a lobby has no clock');
  assert.ok(restored.rooms.get(nightCode).timer, 'a night resumes its clock');
  for (const [playerId, view] of Object.entries(expectedViews)) {
    assert.deepEqual(gameFor('onuw').viewFor(restored.rooms.get(nightCode).game, playerId, clock), view);
  }
  clearTimeout(rooms.rooms.get(nightCode).timer);
  clearTimeout(restored.rooms.get(nightCode).timer);
});

test('bad or incompatible snapshots start with an empty room registry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'avalon-persistence-bad-'));
  const corrupt = join(dir, 'corrupt.json');
  const mismatch = join(dir, 'mismatch.json');
  await writeFile(corrupt, '{not json');
  await writeFile(mismatch, JSON.stringify({ stateVersion: STATE_VERSION + 1, rooms: [{ nope: true }] }));

  const corruptRooms = new Rooms();
  assert.equal(load(corruptRooms, corrupt).restored, 0);
  assert.equal(corruptRooms.rooms.size, 0);

  const mismatchRooms = new Rooms();
  assert.equal(load(mismatchRooms, mismatch).restored, 0);
  assert.equal(mismatchRooms.rooms.size, 0);
});
