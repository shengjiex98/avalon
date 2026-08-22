import test from 'node:test';
import assert from 'node:assert/strict';

import * as g from '../src/game.js';
import { sideOf } from '../src/rules.js';

/** A deterministic game: `shuffle` is identity, so roles land in a known order. */
function setup(count = 5, options = {}) {
  const game = g.createGame('TEST');
  for (let i = 0; i < count; i++) g.addPlayer(game, { id: `p${i}`, name: `P${i}` });
  g.setOptions(game, 'p0', options);
  g.startGame(game, 'p0', { shuffle: (list) => list });
  game.leaderIndex = 0; // startGame randomises the first leader; pin it for the tests
  for (const p of game.players) g.confirmRole(game, p.id);
  return game;
}

const evilIds = (game) => game.players.filter((p) => sideOf(game.roles[p.id]) === 'evil').map((p) => p.id);
const leaderId = (game) => game.players[game.leaderIndex].id;

/** Propose the given team and have everyone approve it. */
function approveTeam(game, team) {
  g.proposeTeam(game, leaderId(game), team);
  for (const p of game.players) g.castVote(game, p.id, true);
}

/** Run one quest to completion with `fails` fail cards played by evil. */
function runQuest(game, { fails = 0 } = {}) {
  const size = g.currentTeamSize(game);
  const evil = evilIds(game);
  const team = [...evil.slice(0, fails), ...game.players.map((p) => p.id).filter((id) => !evil.slice(0, fails).includes(id))].slice(0, size);
  approveTeam(game, team);
  for (const id of team) g.playCard(game, id, !(evil.includes(id) && fails-- > 0));
}

test('a five player game deals three good and two evil', () => {
  const game = setup(5);
  assert.equal(game.phase, 'team');
  assert.equal(evilIds(game).length, 2);
  assert.equal(Object.values(game.roles).filter((r) => r === 'merlin').length, 1);
});

test('players cannot join once the game has started', () => {
  const game = setup(5);
  assert.throws(() => g.addPlayer(game, { id: 'x', name: 'Late' }), { key: 'gameAlreadyStarted' });
});

test('rejoining with the same id keeps the seat and role', () => {
  const game = setup(5);
  const before = game.roles.p2;
  const again = g.addPlayer(game, { id: 'p2', name: 'P2' });
  assert.equal(again.name, 'P2');
  assert.equal(game.roles.p2, before);
  assert.equal(game.players.length, 5);
});

test('duplicate names are refused in the lobby', () => {
  const game = g.createGame('TEST');
  g.addPlayer(game, { id: 'a', name: 'Arthur' });
  assert.throws(() => g.addPlayer(game, { id: 'b', name: 'arthur' }), { key: 'nameTaken' });
  assert.throws(() => g.addPlayer(game, { id: 'c', name: '   ' }), { key: 'nameRequired' });
});

test('only the leader proposes, and only a full team', () => {
  const game = setup(5);
  const notLeader = game.players[1].id;
  assert.throws(() => g.proposeTeam(game, notLeader, ['p0', 'p1']), { key: 'notLeader' });
  assert.throws(() => g.proposeTeam(game, 'p0', ['p0']), { key: 'wrongTeamSize' });
  assert.throws(() => g.proposeTeam(game, 'p0', ['p0', 'p0']), { key: 'duplicateMember' });
  assert.throws(() => g.proposeTeam(game, 'p0', ['p0', 'ghost']), { key: 'unknownMember' });
});

test('a tied vote is a rejection and passes leadership on', () => {
  const game = setup(6);
  g.proposeTeam(game, 'p0', ['p0', 'p1']);
  game.players.forEach((p, i) => g.castVote(game, p.id, i < 3)); // 3–3
  assert.equal(game.lastVote.approved, false);
  assert.equal(game.rejects, 1);
  assert.equal(game.phase, 'team');
  assert.equal(leaderId(game), 'p1');
});

test('five rejections in a row hand the game to evil', () => {
  const game = setup(5);
  for (let i = 0; i < 5; i++) {
    g.proposeTeam(game, leaderId(game), ['p0', 'p1']);
    for (const p of game.players) g.castVote(game, p.id, false);
  }
  assert.equal(game.phase, 'over');
  assert.equal(game.winner, 'evil');
  assert.equal(game.winReason, 'win.hammer');
});

test('an approved vote resets the rejection counter', () => {
  const game = setup(5);
  g.proposeTeam(game, 'p0', ['p0', 'p1']);
  for (const p of game.players) g.castVote(game, p.id, false);
  assert.equal(game.rejects, 1);
  approveTeam(game, ['p0', 'p1']);
  assert.equal(game.rejects, 0);
  assert.equal(game.phase, 'quest');
});

test('nobody votes twice and nobody plays two cards', () => {
  const game = setup(5);
  g.proposeTeam(game, 'p0', ['p0', 'p1']);
  g.castVote(game, 'p0', true);
  assert.throws(() => g.castVote(game, 'p0', false), { key: 'alreadyVoted' });
  for (const p of game.players.slice(1)) g.castVote(game, p.id, true);
  g.playCard(game, 'p0', true);
  assert.throws(() => g.playCard(game, 'p0', true), { key: 'alreadyPlayed' });
  assert.throws(() => g.playCard(game, 'p2', true), { key: 'notOnTeam' });
});

test('good players cannot play a fail card', () => {
  const game = setup(5);
  const good = game.players.find((p) => sideOf(game.roles[p.id]) === 'good').id;
  const evil = evilIds(game)[0];
  approveTeam(game, [good, evil]);
  assert.throws(() => g.playCard(game, good, false), { key: 'goodMustSucceed' });
  g.playCard(game, good, true);
  g.playCard(game, evil, false);
  assert.equal(game.quests[0].success, false);
});

test('quest four in a seven player game survives a single fail card', () => {
  const game = setup(7);
  runQuest(game, { fails: 0 });
  runQuest(game, { fails: 0 });
  runQuest(game, { fails: 0 });
  assert.equal(game.phase, 'assassin', 'three successes end the quest phase');

  const other = setup(7);
  runQuest(other, { fails: 1 });          // quest 1 fails
  runQuest(other, { fails: 0 });
  runQuest(other, { fails: 0 });
  assert.equal(other.round, 3);
  assert.equal(other.failsRequired, undefined);
  assert.equal(g.currentFailsRequired(other), 2);
  runQuest(other, { fails: 1 });          // one fail is not enough on quest 4
  assert.equal(other.quests[3].success, true);
});

test('three failed quests end the game before the assassin acts', () => {
  const game = setup(5);
  runQuest(game, { fails: 1 });
  runQuest(game, { fails: 1 });
  runQuest(game, { fails: 1 });
  assert.equal(game.phase, 'over');
  assert.equal(game.winner, 'evil');
  assert.equal(game.winReason, 'win.threeFails');
});

test('the assassin steals the win by naming Merlin', () => {
  const game = setup(5);
  runQuest(game); runQuest(game); runQuest(game);
  assert.equal(game.phase, 'assassin');

  const assassin = game.players.find((p) => game.roles[p.id] === 'assassin').id;
  const merlin = game.players.find((p) => game.roles[p.id] === 'merlin').id;
  const otherEvil = evilIds(game).find((id) => id !== assassin);

  assert.throws(() => g.assassinate(game, merlin, merlin), { key: 'assassinOnly' });
  assert.throws(() => g.assassinate(game, assassin, otherEvil), { key: 'targetMustBeGood' });

  g.assassinate(game, assassin, merlin);
  assert.equal(game.winner, 'evil');
  assert.equal(game.winReason, 'win.merlinSlain');
});

test('good keeps the win when the assassin misses', () => {
  const game = setup(5);
  runQuest(game); runQuest(game); runQuest(game);
  const assassin = game.players.find((p) => game.roles[p.id] === 'assassin').id;
  const decoy = game.players.find((p) => game.roles[p.id] === 'servant').id;
  g.assassinate(game, assassin, decoy);
  assert.equal(game.winner, 'good');
  assert.equal(game.winReason, 'win.threeSuccesses');
});

test('a view never leaks another player\'s role while the game runs', () => {
  const game = setup(7, { percival: true, morgana: true, mordred: true });
  for (const viewer of game.players) {
    const view = g.viewFor(game, viewer.id);
    for (const p of view.players) {
      if (p.id === viewer.id) continue;
      assert.equal(p.role, undefined, `${viewer.id} could see ${p.id}'s role`);
    }
    const known = new Set(view.knowledge.map((k) => k.playerId));
    assert.ok(!known.has(viewer.id), 'a player is never in their own knowledge list');
  }
});

test('Merlin\'s view shows evil minus Mordred, and Percival sees two candidates', () => {
  const game = setup(7, { percival: true, morgana: true, mordred: true });
  const idOf = (role) => game.players.find((p) => game.roles[p.id] === role).id;
  const merlinView = g.viewFor(game, idOf('merlin'));
  const seen = merlinView.knowledge.map((k) => k.playerId);
  assert.ok(!seen.includes(idOf('mordred')));
  assert.ok(seen.includes(idOf('assassin')) && seen.includes(idOf('morgana')));

  const percivalView = g.viewFor(game, idOf('percival'));
  assert.deepEqual(
    percivalView.knowledge.map((k) => k.hint),
    ['merlinOrMorgana', 'merlinOrMorgana'],
  );
});

test('all roles are revealed once the game is over', () => {
  const game = setup(5);
  runQuest(game); runQuest(game); runQuest(game);
  const assassin = game.players.find((p) => game.roles[p.id] === 'assassin').id;
  g.assassinate(game, assassin, game.players.find((p) => game.roles[p.id] === 'servant').id);
  const view = g.viewFor(game, game.players[3].id);
  assert.ok(view.players.every((p) => typeof p.role === 'string'));
});

test('the view tells each client who the game is waiting on', () => {
  const game = setup(5);
  assert.deepEqual(g.viewFor(game, 'p0').waitingFor, ['p0'], 'the leader must propose');
  g.proposeTeam(game, 'p0', ['p0', 'p1']);
  g.castVote(game, 'p0', true);
  assert.deepEqual(g.viewFor(game, 'p0').waitingFor, ['p1', 'p2', 'p3', 'p4']);
});

test('play again returns the same table to the lobby', () => {
  const game = setup(5);
  runQuest(game, { fails: 1 }); runQuest(game, { fails: 1 }); runQuest(game, { fails: 1 });
  assert.throws(() => g.resetToLobby(game, 'p1'), { key: 'hostOnly' });
  g.resetToLobby(game, 'p0');
  assert.equal(game.phase, 'lobby');
  assert.equal(game.players.length, 5);
  assert.deepEqual(game.quests, []);
  assert.equal(game.winner, null);
  assert.deepEqual(g.viewFor(game, 'p0').players[0].role, undefined);
});

test('leaving is a lobby-only move and hands the host role on', () => {
  const game = g.createGame('TEST');
  for (let i = 0; i < 5; i++) g.addPlayer(game, { id: `p${i}`, name: `P${i}` });
  g.removePlayer(game, 'p0');
  assert.equal(game.hostId, 'p1');
  assert.equal(game.players.length, 4);
  g.addPlayer(game, { id: 'p9', name: 'P9' });
  g.startGame(game, 'p1', { shuffle: (l) => l });
  assert.throws(() => g.removePlayer(game, 'p2'), { key: 'cannotLeaveMidGame' });
});
