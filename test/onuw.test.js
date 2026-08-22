import test from 'node:test';
import assert from 'node:assert/strict';

import * as w from '../src/games/onuw/game.js';
import { buildDeck, decideWinners, defaultOptions, roomForOptions, tallyVotes } from '../src/games/onuw/rules.js';

/**
 * A game dealt exactly as `deck` says: seat i gets deck[i], the rest is the
 * centre. Nothing here is random.
 */
function dealt(deck, names = ['Ann', 'Bo', 'Cai', 'Dee', 'Eli', 'Fay', 'Gus']) {
  const count = deck.length - 3;
  const game = w.createGame('TEST');
  names.slice(0, count).forEach((name, i) => w.addPlayer(game, { id: `p${i}`, name }));
  game.phase = 'night';
  game.startRoles = Object.fromEntries(game.players.map((p, i) => [p.id, deck[i]]));
  game.centreStart = deck.slice(count);
  return game;
}

/**
 * Let every actor the test does not care about pass, so the night resolves.
 * The Drunk cannot pass, so decks under test avoid one unless it is the point.
 */
function settle(game) {
  for (const p of game.players) {
    if (p.id in game.actions) continue;
    const kind = w.actionFor(game, p.id);
    if (kind) w.submitNight(game, p.id, { skip: true });
  }
}

const infoFor = (game, id, key) => (game.info[id] ?? []).find((e) => e.key === key);

test('the deck is always three cards larger than the table', () => {
  for (let n = 3; n <= 10; n++) {
    assert.equal(buildDeck(n, defaultOptions(n)).length, n + 3);
  }
});

test('a deck that cannot fit is refused rather than silently trimmed', () => {
  // Three players leave one slot beyond the core five cards.
  assert.equal(roomForOptions(3), 1);
  assert.throws(() => buildDeck(3, { minion: true, drunk: true, insomniac: true }), { key: 'tooManyRoles' });
  assert.throws(() => buildDeck(2, {}), { key: 'badPlayerCount' });
});

test('two werewolves see each other; a lone wolf is told they are alone', () => {
  const pair = dealt(['werewolf', 'werewolf', 'seer', 'robber', 'troublemaker', 'villager']);
  assert.deepEqual(w.staticKnowledge(pair, 'p0').map((k) => k.key), ['onuw.info.packmates']);
  assert.deepEqual(w.staticKnowledge(pair, 'p0')[0].params.names, ['Bo']);
  assert.equal(w.actionFor(pair, 'p0'), null, 'a pair has nothing to decide');

  const lone = dealt(['werewolf', 'seer', 'robber', 'troublemaker', 'werewolf', 'villager']);
  assert.deepEqual(w.staticKnowledge(lone, 'p0').map((k) => k.key), ['onuw.info.loneWolf']);
  assert.equal(w.actionFor(lone, 'p0'), 'loneWolf', 'a lone wolf may peek at the centre');
});

test('the minion sees the werewolves and they do not see the minion', () => {
  const game = dealt(['minion', 'werewolf', 'seer', 'robber', 'troublemaker', 'villager']);
  const seen = w.staticKnowledge(game, 'p0');
  assert.equal(seen[0].key, 'onuw.info.minionSees');
  assert.deepEqual(seen[0].params.names, ['Bo']);
  assert.deepEqual(w.staticKnowledge(game, 'p1').map((k) => k.key), ['onuw.info.loneWolf']);
  assert.ok(!JSON.stringify(w.staticKnowledge(game, 'p1')).includes('Ann'), 'the wolf is not told about the minion');
});

test('a mason with no partner is told so', () => {
  const pair = dealt(['mason', 'mason', 'seer', 'robber', 'troublemaker', 'werewolf']);
  assert.deepEqual(w.staticKnowledge(pair, 'p0')[0].params.names, ['Bo']);
  const alone = dealt(['mason', 'werewolf', 'seer', 'robber', 'troublemaker', 'mason']);
  assert.equal(w.staticKnowledge(alone, 'p0')[0].key, 'onuw.info.masonAlone');
});

test('the seer looks at one player or two centre cards, not both', () => {
  const game = dealt(['seer', 'werewolf', 'robber', 'troublemaker', 'villager', 'tanner']);
  assert.throws(() => w.submitNight(game, 'p0', { mode: 'player', target: 'p0' }), { key: 'badTarget' });
  assert.throws(() => w.submitNight(game, 'p0', { mode: 'centre', centres: [0, 0] }), { key: 'badCentreCard' });

  w.submitNight(game, 'p0', { mode: 'centre', centres: [0, 2] });
  settle(game);
  const seen = infoFor(game, 'p0', 'onuw.info.sawTwoCentre');
  assert.equal(seen.params.roleA, 'troublemaker');
  assert.equal(seen.params.roleB, 'tanner');
});

test('the robber takes a card and is told what they now hold', () => {
  const game = dealt(['robber', 'werewolf', 'seer', 'troublemaker', 'villager', 'tanner']);
  w.submitNight(game, 'p0', { target: 'p1' });
  settle(game);

  assert.equal(infoFor(game, 'p0', 'onuw.info.robbed').params.role, 'werewolf');
  assert.equal(game.finalRoles.p0, 'werewolf', 'the robber becomes the werewolf');
  assert.equal(game.finalRoles.p1, 'robber', 'and hands over the robber card');
});

test('the troublemaker swaps two others without learning anything', () => {
  const game = dealt(['troublemaker', 'werewolf', 'seer', 'robber', 'villager', 'tanner']);
  assert.throws(() => w.submitNight(game, 'p0', { targets: ['p0', 'p1'] }), { key: 'troublemakerNotSelf' });
  w.submitNight(game, 'p0', { targets: ['p1', 'p2'] });
  settle(game);

  assert.equal(game.finalRoles.p1, 'seer');
  assert.equal(game.finalRoles.p2, 'werewolf');
  const learned = JSON.stringify(game.info.p0);
  assert.ok(!learned.includes('werewolf'), 'the troublemaker is never told what moved');
});

test('the drunk must swap with the centre and is not told what they took', () => {
  const game = dealt(['drunk', 'werewolf', 'seer', 'robber', 'villager', 'tanner']);
  assert.throws(() => w.submitNight(game, 'p0', { skip: true }), { key: 'drunkMustSwap' });
  w.submitNight(game, 'p0', { centre: 2 });
  settle(game);

  assert.equal(game.finalRoles.p0, 'tanner');
  assert.equal(game.centre[2], 'drunk');
  assert.ok(!JSON.stringify(game.info.p0).includes('tanner'), 'the drunk stays in the dark');
});

test('the night resolves in wake order, not submission order', () => {
  // Robber (50) takes the werewolf, then the Troublemaker (60) moves it on.
  const game = dealt(['troublemaker', 'robber', 'werewolf', 'seer', 'villager', 'tanner', 'minion']);
  w.submitNight(game, 'p0', { targets: ['p1', 'p3'] });   // submitted first
  w.submitNight(game, 'p1', { target: 'p2' });            // resolved first
  settle(game);

  assert.equal(infoFor(game, 'p1', 'onuw.info.robbed').params.role, 'werewolf',
    'the robber saw what they took, before the troublemaker interfered');
  assert.equal(game.finalRoles.p1, 'seer', 'the troublemaker then moved it away');
  assert.equal(game.finalRoles.p3, 'werewolf');
});

test('the insomniac sees the card they end the night holding', () => {
  const game = dealt(['insomniac', 'robber', 'werewolf', 'seer', 'villager', 'tanner']);
  w.submitNight(game, 'p1', { target: 'p0' });    // the robber takes the insomniac's card
  settle(game);
  assert.equal(infoFor(game, 'p0', 'onuw.info.insomniac').params.role, 'robber');
  assert.equal(game.finalRoles.p0, 'robber');
});

test('the night waits only for players who have something to decide', () => {
  const game = dealt(['villager', 'werewolf', 'werewolf', 'seer', 'minion', 'tanner', 'robber']);
  assert.deepEqual(w.pendingActors(game).map((p) => p.id), ['p3'], 'only the seer acts');
  w.submitNight(game, 'p3', { mode: 'centre', centres: [0, 1] });
  assert.equal(game.phase, 'day');
});

test('a night with every actor in the centre resolves immediately', () => {
  const game = w.createGame('TEST');
  ['Ann', 'Bo', 'Cai'].forEach((name, i) => w.addPlayer(game, { id: `p${i}`, name }));
  const deck = ['werewolf', 'werewolf', 'villager', 'seer', 'robber', 'troublemaker'];
  w.startGame(game, 'p0', { shuffle: (list) => (typeof list[0] === 'string' ? deck : list) });
  assert.equal(game.phase, 'day', 'nobody had a decision to make');
});

test('votes are counted, and a one-vote-each stand-off kills nobody', () => {
  assert.deepEqual([...tallyVotes(['a', 'b', 'c'], { a: 'b', b: 'c', c: 'a' }).dead], []);
  assert.deepEqual([...tallyVotes(['a', 'b', 'c'], { a: 'b', b: 'c', c: 'b' }).dead], ['b']);
  // A tie at the top kills everyone tied.
  assert.deepEqual([...tallyVotes(['a', 'b', 'c', 'd'], { a: 'b', b: 'a', c: 'a', d: 'b' }).dead].sort(), ['a', 'b']);
});

test('the village wins by killing a werewolf', () => {
  const roles = { p0: 'werewolf', p1: 'villager', p2: 'seer' };
  assert.deepEqual([...decideWinners(roles, new Set(['p0']))], ['village']);
  assert.deepEqual([...decideWinners(roles, new Set(['p1']))], ['werewolf']);
});

test('with every werewolf in the centre, the village must kill nobody', () => {
  const roles = { p0: 'villager', p1: 'villager', p2: 'seer' };
  assert.deepEqual([...decideWinners(roles, new Set())], ['village']);
  assert.deepEqual([...decideWinners(roles, new Set(['p0']))], [], 'lynching an innocent loses it');
});

test('the tanner wins by dying, and takes the werewolves down with him', () => {
  const roles = { p0: 'tanner', p1: 'werewolf', p2: 'villager' };
  assert.deepEqual([...decideWinners(roles, new Set(['p0']))], ['tanner']);
  // Tanner and a wolf both die: the village wins too.
  assert.deepEqual([...decideWinners(roles, new Set(['p0', 'p1']))].sort(), ['tanner', 'village']);
});

test('a full three player game plays through to a verdict', () => {
  const game = dealt(['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner']);
  w.submitNight(game, 'p0', { mode: 'player', target: 'p1' });
  w.submitNight(game, 'p2', { target: 'p1' });
  settle(game);
  assert.equal(game.phase, 'day');

  assert.equal(infoFor(game, 'p0', 'onuw.info.sawPlayer').params.role, 'werewolf');
  assert.throws(() => w.castVote(game, 'p0', 'p1'), { key: 'wrongPhase' });

  w.startVote(game, 'p0');
  assert.throws(() => w.castVote(game, 'p0', 'p0'), { key: 'cannotVoteSelf' });
  w.castVote(game, 'p0', 'p2');
  w.castVote(game, 'p1', 'p2');
  w.castVote(game, 'p2', 'p0');

  assert.equal(game.phase, 'over');
  assert.deepEqual(game.dead, ['p2']);
  // The robber took the wolf card, so the table killed the werewolf after all.
  assert.equal(game.finalRoles.p2, 'werewolf');
  assert.deepEqual(game.winners, ['village']);
});

test('the hunter takes their target down too', () => {
  const game = dealt(['hunter', 'werewolf', 'villager', 'seer', 'robber', 'troublemaker']);
  game.phase = 'day';
  game.finalRoles = { ...game.startRoles };
  w.startVote(game, 'p0');
  w.castVote(game, 'p0', 'p1');
  w.castVote(game, 'p1', 'p0');
  w.castVote(game, 'p2', 'p0');

  assert.deepEqual(game.dead.sort(), ['p0', 'p1'], 'the hunter died and shot the wolf');
  assert.deepEqual(game.winners, ['village']);
});

test('a view never shows another player\'s card before the game ends', () => {
  const game = dealt(['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner']);
  for (const p of game.players) {
    const view = w.viewFor(game, p.id);
    assert.equal(view.centre, null, 'the centre stays face down');
    for (const other of view.players) {
      assert.equal(other.startRole, undefined, `${p.id} could see ${other.id}'s card`);
      assert.equal(other.finalRole, undefined);
    }
  }
  // The seer's own view names only their own card.
  assert.equal(w.viewFor(game, 'p0').you.role, 'seer');
});

test('everything is revealed once the votes are in', () => {
  const game = dealt(['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner']);
  w.submitNight(game, 'p0', { mode: 'player', target: 'p1' });
  w.submitNight(game, 'p2', { target: 'p1' });
  settle(game);
  w.startVote(game, 'p0');
  for (const [voter, target] of [['p0', 'p2'], ['p1', 'p2'], ['p2', 'p0']]) w.castVote(game, voter, target);

  const view = w.viewFor(game, 'p1');
  assert.ok(view.players.every((p) => p.startRole && p.finalRole));
  assert.equal(view.centre.length, 3);
  assert.ok(view.swaps.length >= 1, 'the night is explained afterwards');
  // p1 was dealt the werewolf but the robber took it, so p1 ends on the
  // village side and wins with them: you are the card you finish holding.
  assert.equal(game.startRoles.p1, 'werewolf');
  assert.equal(game.finalRoles.p1, 'robber');
  assert.equal(view.youWon, true);
  assert.equal(w.viewFor(game, 'p2').youWon, false, 'the robber ended up the wolf, and died for it');
});

test('play again reshuffles the same table', () => {
  const game = dealt(['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner']);
  w.submitNight(game, 'p0', { mode: 'centre', centres: [0, 1] });
  w.submitNight(game, 'p2', { target: 'p1' });
  settle(game);
  w.startVote(game, 'p0');
  for (const [voter, target] of [['p0', 'p2'], ['p1', 'p2'], ['p2', 'p0']]) w.castVote(game, voter, target);

  assert.throws(() => w.resetToLobby(game, 'p1'), { key: 'hostOnly' });
  w.resetToLobby(game, 'p0');
  assert.equal(game.phase, 'lobby');
  assert.equal(game.players.length, 3);
  assert.deepEqual(game.dead, []);
  assert.deepEqual(w.viewFor(game, 'p0').players[0].startRole, undefined);
});
