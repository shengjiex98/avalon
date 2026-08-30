import test from 'node:test';
import assert from 'node:assert/strict';

import * as g from '../src/server/games/avalon/game.ts';
import { sideOf } from '../src/server/games/avalon/rules.ts';
import type { AvalonRole } from '../src/server/games/avalon/rules.ts';
import type { AvalonContext } from '../src/server/runtime.ts';
import type { AvalonPhase, AvalonView } from '../src/contracts/views.ts';

type SetupOptions = Parameters<typeof g.setOptions>[2];

function assertPhase<P extends AvalonPhase>(
  view: AvalonView,
  phase: P,
): asserts view is Extract<AvalonView, { phase: P }> {
  assert.equal(view.phase, phase);
}

function lobbyView(game: AvalonContext, playerId = 'p0'): Extract<AvalonView, { phase: 'lobby' }> {
  const view = g.viewFor(game, playerId);
  assertPhase(view, 'lobby');
  return view;
}

/** A deterministic game: `shuffle` is identity, so roles land in a known order. */
function setup(count = 5, options: SetupOptions = {}): AvalonContext {
  const game = g.createGame('TEST');
  for (let i = 0; i < count; i++) g.addPlayer(game, { id: `p${i}`, name: `P${i}` });
  // The lobby picks a deck to suit the table size on its own, so a test that
  // cares about the deal names every optional role rather than only the ones
  // it wants in.
  g.setOptions(game, 'p0', { percival: false, morgana: false, mordred: false, oberon: false, ...options });
  g.startGame(game, 'p0', { shuffle: (list) => list });
  game.state.leaderIndex = 0; // startGame randomises the first leader; pin it for the tests
  for (const p of game.room.players) g.confirmRole(game, p.id);
  return game;
}

const evilIds = (game: AvalonContext): string[] => game.room.players
  .filter((p) => sideOf(game.state.roles[p.id]!) === 'evil').map((p) => p.id);
const leaderId = (game: AvalonContext): string => game.room.players[game.state.leaderIndex]!.id;

/** Propose the given team and have everyone approve it. */
function approveTeam(game: AvalonContext, team: string[]): void {
  g.proposeTeam(game, leaderId(game), team);
  for (const p of game.room.players) g.castVote(game, p.id, true);
}

/** Run one quest to completion with `fails` fail cards played by evil. */
function runQuest(game: AvalonContext, { fails = 0 }: { fails?: number } = {}): void {
  const size = g.currentTeamSize(game);
  const evil = evilIds(game);
  const team = [...evil.slice(0, fails), ...game.room.players.map((p) => p.id).filter((id) => !evil.slice(0, fails).includes(id))].slice(0, size);
  approveTeam(game, team);
  for (const id of team) g.playCard(game, id, !(evil.includes(id) && fails-- > 0));
}

test('a five player game deals three good and two evil', () => {
  const game = setup(5);
  assert.equal(game.state.phase, 'team');
  assert.equal(evilIds(game).length, 2);
  assert.equal(Object.values(game.state.roles).filter((r) => r === 'merlin').length, 1);
});

test('players cannot join once the game has started', () => {
  const game = setup(5);
  assert.throws(() => g.addPlayer(game, { id: 'x', name: 'Late' }), { key: 'gameAlreadyStarted' });
});

test('rejoining with the same id keeps the seat and role', () => {
  const game = setup(5);
  const before = game.state.roles.p2;
  const again = g.addPlayer(game, { id: 'p2', name: 'P2' });
  assert.equal(again.name, 'P2');
  assert.equal(game.state.roles.p2, before);
  assert.equal(game.room.players.length, 5);
});

test('duplicate names are refused in the lobby', () => {
  const game = g.createGame('TEST');
  g.addPlayer(game, { id: 'a', name: 'Arthur' });
  assert.throws(() => g.addPlayer(game, { id: 'b', name: 'arthur' }), { key: 'nameTaken' });
  assert.throws(() => g.addPlayer(game, { id: 'c', name: '   ' }), { key: 'nameRequired' });
});

test('only the leader proposes, and only a full team', () => {
  const game = setup(5);
  const notLeader = game.room.players[1]!.id;
  assert.throws(() => g.proposeTeam(game, notLeader, ['p0', 'p1']), { key: 'notLeader' });
  assert.throws(() => g.proposeTeam(game, 'p0', ['p0']), { key: 'wrongTeamSize' });
  assert.throws(() => g.proposeTeam(game, 'p0', ['p0', 'p0']), { key: 'duplicateMember' });
  assert.throws(() => g.proposeTeam(game, 'p0', ['p0', 'ghost']), { key: 'unknownMember' });
});

test('a tied vote is a rejection and passes leadership on', () => {
  const game = setup(6);
  g.proposeTeam(game, 'p0', ['p0', 'p1']);
  game.room.players.forEach((p, i) => g.castVote(game, p.id, i < 3)); // 3–3
  assert.equal(game.state.lastVote?.approved, false);
  assert.equal(game.state.rejects, 1);
  assert.equal(game.state.phase, 'team');
  assert.equal(leaderId(game), 'p1');
});

test('pending Avalon votes reveal participation but not choices', () => {
  const game = setup(5);
  g.proposeTeam(game, 'p0', ['p0', 'p1']);
  g.castVote(game, 'p0', true);
  g.castVote(game, 'p1', false);

  const view = g.viewFor(game, 'p2');
  assertPhase(view, 'vote');
  assert.equal(view.lastVote, null);
  assert.equal(view.players.find((p) => p.id === 'p0')!.hasVoted, true);
  assert.equal(view.players.find((p) => p.id === 'p1')!.hasVoted, true);
  assert.ok(!JSON.stringify(view).includes('"p0":true'));
  assert.ok(!JSON.stringify(view).includes('"p1":false'));
});

test('five rejections hand the game to evil', () => {
  const game = setup(5);
  for (let i = 0; i < 5; i++) {
    g.proposeTeam(game, leaderId(game), ['p0', 'p1']);
    for (const p of game.room.players) g.castVote(game, p.id, false);
  }
  assert.equal(game.state.phase, 'over');
  assert.equal(game.state.winner, 'evil');
  assert.equal(game.state.winReason, 'win.hammer');
  const result = game.room.log.find((entry) => entry.key === 'log.gameResult');
  assert.ok(result);
  const winners = result.params.winners as Array<{ id: string; name: string; side: string }>;
  const losers = result.params.losers as Array<{ id: string; name: string; side: string }>;
  assert.deepEqual(winners.map(({ side }) => side), ['evil', 'evil']);
  assert.deepEqual(losers.map(({ side }) => side), ['good', 'good', 'good']);
  assert.ok([...winners, ...losers].every((player) => !('role' in player)), 'the report never retains roles');
});

test('an approved vote does not reset the rejection counter by default', () => {
  const game = setup(5);
  g.proposeTeam(game, 'p0', ['p0', 'p1']);
  for (const p of game.room.players) g.castVote(game, p.id, false);
  assert.equal(game.state.rejects, 1);
  approveTeam(game, ['p0', 'p1']);
  assert.equal(game.state.rejects, 1);
  assert.equal(game.state.phase, 'quest');
});

test('the house rule resets the rejection counter on an approved vote', () => {
  const game = setup(5, { houseRules: { resetRejects: true } });
  g.proposeTeam(game, 'p0', ['p0', 'p1']);
  for (const p of game.room.players) g.castVote(game, p.id, false);
  assert.equal(game.state.rejects, 1);
  approveTeam(game, ['p0', 'p1']);
  assert.equal(game.state.rejects, 0);
  assert.equal(game.state.phase, 'quest');
});

test('nobody votes twice and nobody plays two cards', () => {
  const game = setup(5);
  g.proposeTeam(game, 'p0', ['p0', 'p1']);
  g.castVote(game, 'p0', true);
  assert.throws(() => g.castVote(game, 'p0', false), { key: 'alreadyVoted' });
  for (const p of game.room.players.slice(1)) g.castVote(game, p.id, true);
  g.playCard(game, 'p0', true);
  assert.throws(() => g.playCard(game, 'p0', true), { key: 'alreadyPlayed' });
  assert.throws(() => g.playCard(game, 'p2', true), { key: 'notOnTeam' });
});

test('good players cannot play a fail card', () => {
  const game = setup(5);
  const good = game.room.players.find((p) => sideOf(game.state.roles[p.id]!) === 'good')!.id;
  const evil = evilIds(game)[0]!;
  approveTeam(game, [good, evil]);
  assert.throws(() => g.playCard(game, good, false), { key: 'goodMustSucceed' });
  g.playCard(game, good, true);
  g.playCard(game, evil, false);
  assert.equal(game.state.quests[0]!.success, false);
});

test('quest four in a seven player game survives a single fail card', () => {
  const game = setup(7);
  runQuest(game, { fails: 0 });
  runQuest(game, { fails: 0 });
  runQuest(game, { fails: 0 });
  assert.equal(game.state.phase, 'assassin', 'three successes end the quest phase');

  const other = setup(7);
  runQuest(other, { fails: 1 });          // quest 1 fails
  runQuest(other, { fails: 0 });
  runQuest(other, { fails: 0 });
  assert.equal(other.state.round, 3);
  assert.equal('failsRequired' in other.state, false);
  assert.equal(g.currentFailsRequired(other), 2);
  runQuest(other, { fails: 1 });          // one fail is not enough on quest 4
  assert.equal(other.state.quests[3]!.success, true);
});

test('three failed quests end the game before the assassin acts', () => {
  const game = setup(5);
  runQuest(game, { fails: 1 });
  runQuest(game, { fails: 1 });
  runQuest(game, { fails: 1 });
  assert.equal(game.state.phase, 'over');
  assert.equal(game.state.winner, 'evil');
  assert.equal(game.state.winReason, 'win.threeFails');
});

test('the assassin steals the win by naming Merlin', () => {
  const game = setup(5);
  runQuest(game); runQuest(game); runQuest(game);
  assert.equal(game.state.phase, 'assassin');

  const assassin = game.room.players.find((p) => game.state.roles[p.id] === 'assassin')!.id;
  const merlin = game.room.players.find((p) => game.state.roles[p.id] === 'merlin')!.id;
  const otherEvil = evilIds(game).find((id) => id !== assassin);

  assert.throws(() => g.assassinate(game, merlin, merlin), { key: 'assassinOnly' });
  assert.throws(() => g.assassinate(game, assassin, assassin), { key: 'cannotTargetSelf' });
  assert.ok(otherEvil, 'five players put a second evil at the table');

  g.assassinate(game, assassin, merlin);
  assert.equal(game.state.winner, 'evil');
  assert.equal(game.state.winReason, 'win.merlinSlain');
});

test('naming Oberon is a legal miss, not a rejected pick', () => {
  // Oberon is invisible to his own side, so bouncing the pick would tell the
  // Assassin exactly who is not Merlin and let him shoot again.
  const game = setup(7, { oberon: true });
  runQuest(game); runQuest(game); runQuest(game);
  const assassin = game.room.players.find((p) => game.state.roles[p.id] === 'assassin')!.id;
  const oberon = game.room.players.find((p) => game.state.roles[p.id] === 'oberon')!.id;

  g.assassinate(game, assassin, oberon);
  assert.equal(game.state.winner, 'good');
  assert.equal(game.state.winReason, 'win.threeSuccesses');
});

test('good keeps the win when the assassin misses', () => {
  const game = setup(5);
  runQuest(game); runQuest(game); runQuest(game);
  const assassin = game.room.players.find((p) => game.state.roles[p.id] === 'assassin')!.id;
  const decoy = game.room.players.find((p) => game.state.roles[p.id] === 'servant')!.id;
  g.assassinate(game, assassin, decoy);
  assert.equal(game.state.winner, 'good');
  assert.equal(game.state.winReason, 'win.threeSuccesses');
});

test('a view never leaks another player\'s role while the game runs', () => {
  const game = setup(7, { percival: true, morgana: true, mordred: true });
  for (const viewer of game.room.players) {
    const view = g.viewFor(game, viewer.id);
    assert.notEqual(view.phase, 'lobby');
    if (view.phase === 'lobby') throw new Error('expected active Avalon view');
    for (const p of view.players) {
      if (p.id === viewer.id) continue;
      assert.equal('role' in p ? p.role : undefined, undefined, `${viewer.id} could see ${p.id}'s role`);
    }
    const known = new Set(view.knowledge.map((k) => k.playerId));
    assert.ok(!known.has(viewer.id), 'a player is never in their own knowledge list');
  }
});

test('Merlin\'s view shows evil minus Mordred, and Percival sees two candidates', () => {
  const game = setup(7, { percival: true, morgana: true, mordred: true });
  const idOf = (role: AvalonRole): string => game.room.players
    .find((p) => game.state.roles[p.id] === role)!.id;
  const merlinView = g.viewFor(game, idOf('merlin'));
  assert.notEqual(merlinView.phase, 'lobby');
  if (merlinView.phase === 'lobby') throw new Error('expected active Avalon view');
  const seen = merlinView.knowledge.map((k) => k.playerId);
  assert.ok(!seen.includes(idOf('mordred')));
  assert.ok(seen.includes(idOf('assassin')) && seen.includes(idOf('morgana')));

  const percivalView = g.viewFor(game, idOf('percival'));
  assert.notEqual(percivalView.phase, 'lobby');
  if (percivalView.phase === 'lobby') throw new Error('expected active Avalon view');
  assert.deepEqual(
    percivalView.knowledge.map((k) => k.hint),
    ['merlinOrMorgana', 'merlinOrMorgana'],
  );
});

test('all roles are revealed once the game is over', () => {
  const game = setup(5);
  runQuest(game); runQuest(game); runQuest(game);
  const assassin = game.room.players.find((p) => game.state.roles[p.id] === 'assassin')!.id;
  g.assassinate(game, assassin, game.room.players.find((p) => game.state.roles[p.id] === 'servant')!.id);
  const view = g.viewFor(game, game.room.players[3]!.id);
  assertPhase(view, 'over');
  assert.ok(view.players.every((p) => typeof p.role === 'string'));
});

test('the view tells each client who the game is waiting on', () => {
  const game = setup(5);
  const teamView = g.viewFor(game, 'p0');
  assertPhase(teamView, 'team');
  assert.deepEqual(teamView.waitingFor, ['p0'], 'the leader must propose');
  g.proposeTeam(game, 'p0', ['p0', 'p1']);
  g.castVote(game, 'p0', true);
  const voteView = g.viewFor(game, 'p0');
  assertPhase(voteView, 'vote');
  assert.deepEqual(voteView.waitingFor, ['p1', 'p2', 'p3', 'p4']);
});

test('Avalon views are discriminated by phase and carry server-owned setup metadata', () => {
  const game = setup(5);
  game.state.team = ['p0', 'p1'];

  const view = (phase: AvalonPhase): AvalonView => {
    game.state.phase = phase;
    return g.viewFor(game, 'p0');
  };

  const lobby = view('lobby');
  assert.equal(lobby.gameId, 'avalon');
  assert.deepEqual(lobby.setup, {
    minPlayers: 5, maxPlayers: 10,
    options: ['percival', 'morgana', 'mordred', 'oberon'],
    houseRules: ['randomLeader', 'hiddenVotes', 'resetRejects'],
  });
  assert.ok('options' in lobby && 'deck' in lobby);
  assert.ok(!('round' in lobby) && !('roleCounts' in lobby));

  const reveal = view('reveal');
  assert.ok('waitingFor' in reveal && !('team' in reveal));
  const team = view('team');
  assert.ok('teamSize' in team && 'failsRequired' in team && 'team' in team);
  const vote = view('vote');
  assert.ok('team' in vote && 'hasVoted' in vote.players[0]! && !('failsRequired' in vote));
  const quest = view('quest');
  assert.ok('failsRequired' in quest && 'hasPlayed' in quest.players[0]!);
  const assassin = view('assassin');
  assert.ok('assassinTarget' in assassin && !('winner' in assassin));
  const over = view('over');
  assert.ok('winner' in over && 'role' in over.players[0]! && !('waitingFor' in over));
});

test('play again returns the same table to the lobby', () => {
  const game = setup(5);
  runQuest(game, { fails: 1 }); runQuest(game, { fails: 1 }); runQuest(game, { fails: 1 });
  assert.throws(() => g.resetToLobby(game, 'p1'), { key: 'hostOnly' });
  g.resetToLobby(game, 'p0');
  assert.equal(game.state.phase, 'lobby');
  assert.equal(game.room.players.length, 5);
  assert.deepEqual(game.state.quests, []);
  assert.equal(game.state.winner, null);
  const lobbyView = g.viewFor(game, 'p0');
  assertPhase(lobbyView, 'lobby');
  assert.equal('role' in lobbyView.players[0]!, false);
  assert.equal(lobbyView.log.filter((entry) => entry.key === 'log.gameResult').length, 1,
    'the completed result survives into the next game');
});

test('the host can abandon an active game and return the same table to the lobby', () => {
  const game = setup(5);
  assert.equal(game.state.phase, 'team');
  assert.throws(() => g.restartToLobby(game, 'p1'), { key: 'hostOnly' });
  g.restartToLobby(game, 'p0');
  assert.equal(game.state.phase, 'lobby');
  assert.equal(game.room.players.length, 5);
  assert.deepEqual(game.state.roles, {});
  assert.deepEqual(game.state.quests, []);
});

test('rejected lobby resets do not prepare replacement state', () => {
  const game = g.createGame('TEST');
  g.addPlayer(game, { id: 'host', name: 'Host' });
  const now = () => { throw new Error('replacement state was prepared'); };

  assert.throws(() => g.resetToLobby(game, 'other', { now }), { key: 'hostOnly' });
  assert.throws(() => g.resetToLobby(game, 'host', { now }), { key: 'gameInProgress' });
  assert.throws(() => g.restartToLobby(game, 'other', { now }), { key: 'hostOnly' });
  assert.throws(() => g.restartToLobby(game, 'host', { now }), { key: 'wrongPhase' });
});

test('the active Avalon view exposes role counts but never role assignments', () => {
  const game = g.createGame('TEST');
  for (let i = 0; i < 5; i++) g.addPlayer(game, { id: `p${i}`, name: `P${i}` });
  g.setOptions(game, 'p0', { percival: true, morgana: true });
  g.startGame(game, 'p0', { shuffle: (list) => list });
  const view = g.viewFor(game, 'p4');
  assert.notEqual(view.phase, 'lobby');
  if (view.phase === 'lobby') throw new Error('expected active Avalon view');
  assert.deepEqual(view.roleCounts, { merlin: 1, percival: 1, servant: 1, assassin: 1, morgana: 1 });
  assert.ok(view.players.every((p) => !('role' in p) || p.role === undefined));
});

test('leaving is a lobby-only move and hands the host role on', () => {
  const game = g.createGame('TEST');
  for (let i = 0; i < 5; i++) g.addPlayer(game, { id: `p${i}`, name: `P${i}` });
  g.removePlayer(game, 'p0');
  assert.equal(game.room.hostId, 'p1');
  assert.equal(game.room.players.length, 4);
  g.addPlayer(game, { id: 'p9', name: 'P9' });
  g.startGame(game, 'p1', { shuffle: (l) => l });
  assert.throws(() => g.removePlayer(game, 'p2'), { key: 'cannotLeaveMidGame' });
});

// ---------------------------------------------------------------- the lobby's own choices

test('every player-count change reapplies the default optional roles', () => {
  const game = g.createGame('TEST');
  for (let i = 0; i < 7; i++) g.addPlayer(game, { id: `p${i}`, name: `P${i}` });
  let view = lobbyView(game);
  assert.deepEqual(view.options, { percival: true, morgana: true, mordred: false, oberon: true });
  assert.deepEqual(view.deck,
    { merlin: 1, percival: 1, servant: 2, morgana: 1, assassin: 1, oberon: 1 });

  // A player joining moves the deck with the table.
  g.addPlayer(game, { id: 'p7', name: 'P7' });
  assert.deepEqual(lobbyView(game).options,
    { percival: true, morgana: true, mordred: false, oberon: false });

  // Manual choices last while the count is stable.
  g.setOptions(game, 'p0', { oberon: true });
  view = lobbyView(game);
  assert.deepEqual(view.options, { percival: true, morgana: true, mordred: false, oberon: true });

  // A later join discards those choices and applies the nine-player defaults.
  g.addPlayer(game, { id: 'p8', name: 'P8' });
  assert.deepEqual(lobbyView(game).options,
    { percival: true, morgana: true, mordred: true, oberon: false });

  // A departure does the same in the other direction.
  g.setOptions(game, 'p0', { percival: false, oberon: true });
  g.removePlayer(game, 'p8');
  assert.deepEqual(lobbyView(game).options,
    { percival: true, morgana: true, mordred: false, oberon: false });
});

test('rejoining an existing seat does not reset manual role choices', () => {
  const game = g.createGame('TEST');
  for (let i = 0; i < 5; i++) g.addPlayer(game, { id: `p${i}`, name: `P${i}` });
  g.setOptions(game, 'p0', { percival: false, oberon: true });

  g.addPlayer(game, { id: 'p2', name: 'Renamed' });
  assert.deepEqual(lobbyView(game).options,
    { percival: false, morgana: true, mordred: false, oberon: true });
});

test('a lobby whose roles do not fit shows no deck rather than an error', () => {
  const game = g.createGame('TEST');
  for (let i = 0; i < 5; i++) g.addPlayer(game, { id: `p${i}`, name: `P${i}` });
  g.setOptions(game, 'p0', { mordred: true });   // morgana is already in by default
  assert.equal(lobbyView(game).deck, null);
  assert.throws(() => g.startGame(game, 'p0'), { key: 'tooManyEvilRoles' });
});

test('a table too small to deal shows no deck either', () => {
  const game = g.createGame('TEST');
  for (let i = 0; i < 3; i++) g.addPlayer(game, { id: `p${i}`, name: `P${i}` });
  assert.equal(lobbyView(game).deck, null);
});

test('the deck a game was dealt from survives a return to the lobby', () => {
  const game = setup(5, { percival: true });
  const dealt = { ...game.state.options };
  game.state.phase = 'over';
  g.resetToLobby(game, 'p0');
  assert.deepEqual(lobbyView(game).options, dealt);
});

// ---------------------------------------------------------------- house rules

/** A game with the given house rules in force, dealt with a fixed deck. */
function houseGame(rules: Partial<AvalonContext['state']['houseRules']>, count = 5): AvalonContext {
  const game = g.createGame('TEST');
  for (let i = 0; i < count; i++) g.addPlayer(game, { id: `p${i}`, name: `P${i}` });
  g.setOptions(game, 'p0', {
    percival: false, morgana: false, mordred: false, oberon: false, houseRules: rules,
  });
  return game;
}

test('by default the table plays in the order it joined, host first', () => {
  const game = houseGame({});
  g.startGame(game, 'p0', { shuffle: (l) => l.slice().reverse() });
  assert.deepEqual(game.room.players.map((p) => p.id), ['p0', 'p1', 'p2', 'p3', 'p4']);
  assert.equal(game.state.leaderIndex, 0);
});

test('the random leader rule shuffles the seating and the first leader', () => {
  const game = houseGame({ randomLeader: true });
  g.startGame(game, 'p0', { shuffle: (l) => l.slice().reverse() });
  assert.deepEqual(game.room.players.map((p) => p.id), ['p4', 'p3', 'p2', 'p1', 'p0']);
  // Whichever seat the token landed in, it is a seat at this table.
  assert.ok(game.state.leaderIndex >= 0 && game.state.leaderIndex < 5);
});

test('hidden votes publish the tally and nothing else', () => {
  const game = houseGame({ hiddenVotes: true });
  g.startGame(game, 'p0', { shuffle: (l) => l });
  for (const p of game.room.players) g.confirmRole(game, p.id);
  g.proposeTeam(game, 'p0', ['p0', 'p1']);
  game.room.players.forEach((p, i) => g.castVote(game, p.id, i < 2));   // 2–3, rejected

  const view = g.viewFor(game, 'p1');
  assertPhase(view, 'team');
  assert.equal(view.lastVote, null, 'no ballots leave the server');
  assert.deepEqual(view.voteTally, { round: 0, attempt: 1, approved: false, yes: 2, no: 3 });
  assert.equal(JSON.stringify(view).includes('"votes"'), false);
});

test('open votes still name who voted which way', () => {
  const game = houseGame({});
  g.startGame(game, 'p0', { shuffle: (l) => l });
  for (const p of game.room.players) g.confirmRole(game, p.id);
  g.proposeTeam(game, 'p0', ['p0', 'p1']);
  for (const p of game.room.players) g.castVote(game, p.id, true);

  const view = g.viewFor(game, 'p1');
  assertPhase(view, 'quest');
  assert.equal(view.lastVote?.votes.p0, true);
  assert.deepEqual(view.voteTally, { round: 0, attempt: 1, approved: true, yes: 5, no: 0 });
});

/** Reject five proposals, whoever happens to be leading. */
function hammer(game: AvalonContext): void {
  for (let i = 0; i < 5; i++) {
    const size = g.currentTeamSize(game);
    g.proposeTeam(game, game.room.players[game.state.leaderIndex]!.id,
      game.room.players.slice(0, size).map((p) => p.id));
    for (const p of game.room.players) g.castVote(game, p.id, false);
  }
}

test('five rejections hand evil the game with the reset rule off', () => {
  const game = houseGame({});
  g.startGame(game, 'p0', { shuffle: (l) => l });
  for (const p of game.room.players) g.confirmRole(game, p.id);
  hammer(game);
  assert.equal(game.state.phase, 'over');
  assert.equal(game.state.winReason, 'win.hammer');
});

test('rejections accumulate across approved teams when the reset rule is off', () => {
  const game = houseGame({});
  g.startGame(game, 'p0', { shuffle: (l) => l });
  for (const p of game.room.players) g.confirmRole(game, p.id);

  g.proposeTeam(game, 'p0', ['p0', 'p1']);
  for (const p of game.room.players) g.castVote(game, p.id, false);
  runQuest(game);
  assert.equal(game.state.round, 1);
  assert.equal(game.state.rejects, 1, 'an approved and completed quest does not clear the count');

  for (let i = 0; i < 4; i++) {
    const team = game.room.players.slice(0, g.currentTeamSize(game)).map((p) => p.id);
    g.proposeTeam(game, leaderId(game), team);
    for (const p of game.room.players) g.castVote(game, p.id, false);
  }
  assert.equal(game.state.phase, 'over');
  assert.equal(game.state.winReason, 'win.hammer');
});

test('the reset rule clears on approval, but five later rejections still give evil the game', () => {
  const game = houseGame({ resetRejects: true });
  g.startGame(game, 'p0', { shuffle: (l) => l });
  for (const p of game.room.players) g.confirmRole(game, p.id);

  for (let i = 0; i < 4; i++) {
    g.proposeTeam(game, leaderId(game), ['p0', 'p1']);
    for (const p of game.room.players) g.castVote(game, p.id, false);
  }
  approveTeam(game, ['p0', 'p1']);
  assert.equal(game.state.rejects, 0);
  for (const id of game.state.team) g.playCard(game, id, true);

  hammer(game);
  assert.equal(game.state.phase, 'over');
  assert.equal(game.state.winReason, 'win.hammer');
});

test('a game restored without house rules plays by the book', () => {
  const game = houseGame({ resetRejects: true, hiddenVotes: true });
  g.startGame(game, 'p0', { shuffle: (l) => l });
  for (const p of game.room.players) g.confirmRole(game, p.id);
  Reflect.deleteProperty(game.state, 'houseRules'); // a snapshot from before the rules existed
  g.proposeTeam(game, 'p0', ['p0', 'p1']);
  for (const p of game.room.players) g.castVote(game, p.id, false);
  const view = g.viewFor(game, 'p1');
  assertPhase(view, 'team');
  assert.ok(view.lastVote, 'ballots are public again');
  for (let i = 0; i < 4; i++) {          // four more, for five rejections in all
    g.proposeTeam(game, game.room.players[game.state.leaderIndex]!.id, ['p0', 'p1']);
    for (const p of game.room.players) g.castVote(game, p.id, false);
  }
  assert.equal(game.state.winReason, 'win.hammer');
});
