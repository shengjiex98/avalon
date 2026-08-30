import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import * as avalon from '../src/games/avalon/game.ts';
import { gameFor } from '../src/games/index.ts';
import * as onuw from '../src/games/onuw/game.ts';
import { defaultStateFile, load, save } from '../src/persistence.ts';
import { Rooms } from '../src/rooms.ts';
import { STATE_VERSION } from '../src/state-version.ts';
import { snapshotFileSchema } from '../src/contracts/persistence.ts';
import type { SnapshotFile } from '../src/contracts/persistence.ts';
import type { RuntimeRoom, RuntimeRoomFor } from '../src/contracts/runtime.ts';

const currentFixture: SnapshotFile = snapshotFileSchema.parse(
  JSON.parse(await readFile(new URL('fixtures/state-v3.json', import.meta.url), 'utf8')),
);

const isAvalonRoom = (room: RuntimeRoom): room is RuntimeRoomFor<'avalon'> =>
  room.game.id === 'avalon';
const isOnuwRoom = (room: RuntimeRoom): room is RuntimeRoomFor<'onuw'> => room.game.id === 'onuw';
const asAvalonRoom = (room: RuntimeRoom): RuntimeRoomFor<'avalon'> => {
  if (!isAvalonRoom(room)) throw new Error('expected Avalon room');
  return room;
};
const asOnuwRoom = (room: RuntimeRoom): RuntimeRoomFor<'onuw'> => {
  if (!isOnuwRoom(room)) throw new Error('expected ONUW room');
  return room;
};

const serializable = (game: unknown, point: string): void => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(game)), game, point);
};

test('Avalon state stays plain JSON data throughout a game', () => {
  const game = avalon.createGame('JSON', { now: () => 1_000 });
  for (let i = 0; i < 5; i++) {
    avalon.addPlayer(game, { id: `p${i}`, name: `Player ${i}` });
  }
  serializable(game, 'lobby');

  avalon.startGame(game, 'p0', { shuffle: (list) => list });
  for (const player of game.room.players) avalon.confirmRole(game, player.id);
  serializable(game, 'mid-game');

  while (game.state.phase !== 'over') {
    const leader = game.room.players[game.state.leaderIndex]!.id;
    avalon.proposeTeam(game, leader, game.room.players.slice(0, avalon.currentTeamSize(game)).map((p) => p.id));
    for (const player of game.room.players) avalon.castVote(game, player.id, false);
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
  for (const player of game.room.players) onuw.confirmRole(game, player.id, { now });
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
  const nightCode = rooms.create('onuw', { code: 'NATE', seed: 123 });
  for (let i = 0; i < 3; i++) {
    rooms.dispatch(nightCode, `p${i}`, { type: 'join', id: `p${i}`, name: `Player ${i}` });
  }
  rooms.dispatch(nightCode, 'p0', { type: 'start' });
  for (let i = 0; i < 3; i++) rooms.dispatch(nightCode, `p${i}`, { type: 'confirm' });

  const lobbyCode = rooms.create('avalon', { code: 'WATT', seed: 456 });
  rooms.dispatch(lobbyCode, 'host', { type: 'join', id: 'host', name: 'Host' });
  const oldTouch = clock - 5 * 60 * 60_000;
  rooms.rooms.get(lobbyCode)!.touchedAt = oldTouch;

  const resultCode = rooms.create('avalon', { code: 'RESD', seed: 789 });
  for (let i = 0; i < 5; i++) {
    rooms.dispatch(resultCode, `a${i}`, { type: 'join', id: `a${i}`, name: `Avalon ${i}` });
  }
  rooms.dispatch(resultCode, 'a0', { type: 'start' });
  for (let i = 0; i < 5; i++) rooms.dispatch(resultCode, `a${i}`, { type: 'confirm' });
  while (rooms.peek(resultCode)!.game.state.phase !== 'over') {
    const room = asAvalonRoom(rooms.peek(resultCode)!);
    const view = gameFor('avalon').view(room, 'a0', clock);
    if (view.phase !== 'team') throw new Error('expected Avalon team phase');
    const leader = view.players.find((player) => player.isLeader)!.id;
    rooms.dispatch(resultCode, leader, {
      type: 'propose', team: view.players.slice(0, view.teamSize).map((p) => p.id),
    });
    for (let i = 0; i < 5; i++) rooms.dispatch(resultCode, `a${i}`, { type: 'vote', approve: false });
  }

  const nightRoom = asOnuwRoom(rooms.rooms.get(nightCode)!);
  const expectedViews = Object.fromEntries(
    nightRoom.players.map((p) => [
      p.id,
      gameFor('onuw').view(nightRoom, p.id, clock),
    ]),
  );
  const expectedActive = rooms.activeGameCount();
  const expectedSnapshot = rooms.snapshot();
  const dir = await mkdtemp(join(tmpdir(), 'avalon-persistence-'));
  const file = join(dir, 'rooms.json');
  save(rooms, file);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  const restored = new Rooms({ now });
  assert.deepEqual(load(restored, file), { restored: 3, reason: null });
  assert.deepEqual(restored.snapshot(), expectedSnapshot);
  assert.equal(restored.activeGameCount(), expectedActive);
  assert.equal(restored.rooms.get(lobbyCode)!.touchedAt, oldTouch);
  assert.equal(restored.rooms.get(lobbyCode)!.timer, null, 'a lobby has no clock');
  assert.ok(restored.rooms.get(nightCode)!.timer, 'a night resumes its clock');
  const resultRoom = restored.rooms.get(resultCode)!;
  assert.equal(resultRoom.game.state.phase, 'over');
  assert.ok('winner' in resultRoom.game.state);
  assert.equal(resultRoom.game.state.winner, 'evil');
  for (const [playerId, view] of Object.entries(expectedViews)) {
    assert.deepEqual(
      gameFor('onuw').view(asOnuwRoom(restored.rooms.get(nightCode)!), playerId, clock),
      view,
    );
  }
  const originalTimer = rooms.rooms.get(nightCode)!.timer;
  const restoredTimer = restored.rooms.get(nightCode)!.timer;
  if (originalTimer) clearTimeout(originalTimer);
  if (restoredTimer) clearTimeout(restoredTimer);
});

test('the committed current-version fixture restores both game schemas', () => {
  assert.equal(currentFixture.stateVersion, STATE_VERSION);
  const rooms = new Rooms({ now: () => currentFixture.savedAt });
  assert.equal(rooms.restore(currentFixture.rooms), true);
  assert.deepEqual([...rooms.rooms.keys()], ['AVLN', 'WERE']);
});

test('persisted schemas reject unknown keys and malformed game members', () => {
  type MutableFixture = {
    rooms: Array<{
      unknown?: unknown;
      game: {
        unknown?: unknown;
        state: {
          unknown?: unknown;
          options: Record<string, unknown>;
          pace?: unknown;
          nightActions: Record<string, unknown>;
        };
      };
    }>;
  };
  const cases: Array<(body: MutableFixture) => void> = [
    (body) => { body.rooms[0]!.unknown = true; },
    (body) => { body.rooms[0]!.game.unknown = true; },
    (body) => { body.rooms[0]!.game.state.unknown = true; },
    (body) => { body.rooms[0]!.game.state.options.percival = 'yes'; },
    (body) => { body.rooms[1]!.game.state.pace = 'instant'; },
    (body) => { body.rooms[1]!.game.state.nightActions.player = { skip: true, unknown: true }; },
  ];
  for (const mutate of cases) {
    const body: MutableFixture = JSON.parse(JSON.stringify(currentFixture));
    mutate(body);
    const rooms = new Rooms();
    assert.equal(rooms.restore(body.rooms), false);
    assert.equal(rooms.rooms.size, 0, 'one malformed member rejects the whole snapshot');
  }
});

test('one malformed or duplicate room rejects the complete snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'avalon-persistence-atomic-'));
  const file = join(dir, 'rooms.json');
  const source = new Rooms({ now: () => 5_000 });
  const code = source.create('avalon', { code: 'GDDD', seed: 9 });
  source.dispatch(code, 'host', { type: 'join', id: 'host', name: 'Host' });
  save(source, file);

  const body = JSON.parse(await readFile(file, 'utf8'));
  body.rooms.push(structuredClone(body.rooms[0]));
  await writeFile(file, JSON.stringify(body));
  const duplicate = new Rooms();
  assert.equal(load(duplicate, file).restored, 0);
  assert.equal(duplicate.rooms.size, 0);

  body.rooms.pop();
  body.rooms[0].game.state.team = ['missing-player'];
  await writeFile(file, JSON.stringify(body));
  const crossReference = new Rooms();
  assert.equal(load(crossReference, file).restored, 0);
  assert.equal(crossReference.rooms.size, 0);
});

test('game members contain engine state only', () => {
  const rooms = new Rooms({ now: () => 1_000 });
  const code = rooms.create('avalon', { code: 'ENLY', seed: 3 });
  rooms.dispatch(code, 'host', { type: 'join', id: 'host', name: 'Host' });
  const snapshot = rooms.snapshot();
  const { game, ...room } = snapshot[0]!;
  assert.deepEqual(Object.keys(game).sort(), ['id', 'state']);
  for (const key of ['code', 'players', 'hostId', 'log', 'seed', 'rng', 'version', 'actions']) {
    assert.equal(key in game.state, false, `${key} belongs to the room`);
  }
  assert.equal(room.players.length, 1);
  assert.equal(room.hostId, 'host');
  assert.equal(room.journal.length, 1);
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

test('the snapshot path follows XDG state, not systemd StateDirectory', () => {
  const saved: Array<[string, string | undefined]> = [
    'STATE_DIRECTORY', 'XDG_STATE_HOME', 'AVALON_STATE_FILE',
  ].map((name) => [name, process.env[name]]);
  const set = (name: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  try {
    // A user unit's StateDirectory lands under $XDG_CONFIG_HOME before systemd
    // 256, where deploy/updater.sh would never find it.
    set('STATE_DIRECTORY', '/run/ignored');
    set('AVALON_STATE_FILE', undefined);
    set('XDG_STATE_HOME', '/xdg/state');
    assert.equal(defaultStateFile(), join('/xdg/state', 'avalon', 'rooms.json'));

    set('XDG_STATE_HOME', undefined);
    assert.equal(defaultStateFile(), join(homedir(), '.local', 'state', 'avalon', 'rooms.json'));

    set('AVALON_STATE_FILE', join(tmpdir(), 'explicit-rooms.json'));
    assert.equal(defaultStateFile(), join(tmpdir(), 'explicit-rooms.json'));
  } finally {
    for (const [name, value] of saved) set(name, value);
  }
});
