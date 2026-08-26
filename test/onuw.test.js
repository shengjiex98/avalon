import test from 'node:test';
import assert from 'node:assert/strict';

import * as w from '../src/games/onuw/game.js';
import {
  NIGHT_ORDER, buildDeck, decideWinners, defaultOptions,
  nightLength, nightScript, roomForOptions, stepMillis, tallyVotes,
} from '../src/games/onuw/rules.js';

// A clock the tests own outright, so a 90-second night takes no time at all.
let clock = 1_700_000_000_000;
const now = () => clock;

/** A game dealt exactly as `deck` says: seat i gets deck[i], the rest is centre. */
function dealt(deck, names = ['Ann', 'Bo', 'Cai', 'Dee', 'Eli', 'Fay', 'Gus'], { ready = true } = {}) {
  const count = deck.length - 3;
  const game = w.createGame('TEST', { now });
  names.slice(0, count).forEach((name, i) => w.addPlayer(game, { id: `p${i}`, name }));
  w.startGame(game, 'p0', { shuffle: (l) => l, now });
  // Override the deal; startGame shuffled seats and cards through identity.
  // Replace the shuffled deal with the exact one under test.
  game.startRoles = Object.fromEntries(game.players.map((p, i) => [p.id, deck[i]]));
  game.centreStart = deck.slice(count);
  game.finalRoles = { ...game.startRoles };
  game.centre = game.centreStart.slice();
  game.script = nightScript(deck);
  game.info = {};
  game.swaps = [];
  game.nightActions = {};
  if (ready) for (const p of game.players) w.confirmRole(game, p.id, { now });
  return game;
}

/** Run the clock forward until the named step is the current one. */
function stepTo(game, key) {
  for (let guard = 0; guard < 50; guard++) {
    if (w.currentStep(game)?.key === key) return;
    clock = game.stepEndsAt;
    w.tick(game, clock);
  }
  throw new Error(`never reached step ${key}`);
}

/** Run the clock forward until dawn. */
function finishNight(game) {
  for (let guard = 0; guard < 50 && game.phase === 'night'; guard++) {
    clock = game.stepEndsAt;
    w.tick(game, clock);
  }
  assert.equal(game.phase, 'day', 'the night should have ended');
}

const infoFor = (game, id, key) => (game.info[id] ?? []).find((e) => e.key === key);
const roleId = (game, role) => game.players.find((p) => game.startRoles[p.id] === role).id;

// ---------------------------------------------------------------- deck

test('the deck is always three cards larger than the table', () => {
  for (let n = 3; n <= 10; n++) assert.equal(buildDeck(n, defaultOptions(n)).length, n + 3);
});

test('a deck that cannot fit is refused rather than silently trimmed', () => {
  assert.equal(roomForOptions(3), 1);
  assert.throws(() => buildDeck(3, { minion: true, drunk: true, insomniac: true }), { key: 'tooManyRoles' });
  assert.throws(() => buildDeck(2, {}), { key: 'badPlayerCount' });
});

// ---------------------------------------------------------------- the script

test('the night clock waits until every player is ready', () => {
  const game = dealt(
    ['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner'],
    undefined,
    { ready: false },
  );

  assert.equal(game.phase, 'reveal');
  assert.equal(game.step, -1);
  assert.equal(game.stepEndsAt, 0);
  assert.equal(w.nextDeadline(game), null, 'the room must not schedule a timer yet');
  assert.equal(w.viewFor(game, 'p0', clock).night, null);

  w.confirmRole(game, 'p0', { now });
  w.confirmRole(game, 'p1', { now });
  assert.equal(game.phase, 'reveal', 'one unread role still holds the game');
  assert.deepEqual(w.viewFor(game, 'p0', clock).waitingFor, ['p2']);

  const startedAt = clock;
  w.confirmRole(game, 'p2', { now });
  assert.equal(game.phase, 'night');
  assert.equal(w.currentStep(game).key, 'nightfall');
  assert.equal(game.stepEndsAt, startedAt + stepMillis(game.script[0], game.pace));
  assert.equal(w.viewFor(game, 'p0', clock).night.msLeft, stepMillis(game.script[0], game.pace));
  assert.ok(w.nextDeadline(game) > startedAt);
});

test('the reveal view shows readiness without leaking anyone else\'s card', () => {
  const game = dealt(
    ['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner'],
    undefined,
    { ready: false },
  );
  w.confirmRole(game, 'p0', { now });

  const view = w.viewFor(game, 'p1', clock);
  assert.deepEqual(view.players.map((p) => p.ready), [true, false, false]);
  assert.deepEqual(view.waitingFor, ['p1', 'p2']);
  assert.ok(view.players.every((p) => p.startRole === undefined));
  assert.equal(view.you.role, 'werewolf');
});

test('the script holds the deck\'s waking roles, in the canonical order', () => {
  const full = buildDeck(10, defaultOptions(10));
  assert.deepEqual(nightScript(full).map((s) => s.key), ['nightfall', ...NIGHT_ORDER]);
  assert.ok(nightScript(full).every((s) => s.seconds > 0));
});

test('a role nobody agreed to play is never called', () => {
  // The lobby shows the deck, so calling absent roles hides nothing and only
  // costs the table time.
  const deck = ['werewolf', 'werewolf', 'villager', 'seer', 'robber', 'troublemaker'];
  const called = nightScript(deck).map((s) => s.key);
  assert.deepEqual(called, ['nightfall', 'werewolf', 'seer', 'robber', 'troublemaker']);
  for (const absent of ['minion', 'mason', 'drunk', 'insomniac']) {
    assert.ok(!called.includes(absent), `${absent} is not in this deck`);
  }
});

test('a role whose card sits in the centre is still called', () => {
  // Three players; the Seer, Robber and Troublemaker cards are all in the
  // middle. Nobody knows that, so the night must not give it away.
  const game = dealt(['werewolf', 'werewolf', 'villager', 'seer', 'robber', 'troublemaker']);
  const called = [];
  for (let guard = 0; guard < 50 && game.phase === 'night'; guard++) {
    called.push(w.currentStep(game).key);
    clock = game.stepEndsAt;
    w.tick(game, clock);
  }
  assert.deepEqual(called, ['nightfall', 'werewolf', 'seer', 'robber', 'troublemaker']);
});

test('the pace changes how long the night takes, not what happens in it', () => {
  const deck = buildDeck(5, defaultOptions(5));
  assert.ok(nightLength(deck, 'brisk') < nightLength(deck, 'normal'));
  assert.ok(nightLength(deck, 'relaxed') > nightLength(deck, 'normal'));
  assert.deepEqual(nightScript(deck).map((s) => s.key), nightScript(deck).map((s) => s.key));
});

test('a step never ends early, even once the only actor has chosen', () => {
  const game = dealt(['seer', 'werewolf', 'villager', 'robber', 'troublemaker', 'tanner']);
  stepTo(game, 'seer');
  const deadline = game.stepEndsAt;
  w.submitNight(game, 'p0', { mode: 'centre', centres: [0, 1] });

  assert.equal(w.currentStep(game).key, 'seer', 'still the seer step');
  assert.equal(game.stepEndsAt, deadline, 'ending early would announce that the seer is in play');
  w.tick(game, deadline - 1);
  assert.equal(w.currentStep(game).key, 'seer');
  w.tick(game, deadline);
  assert.notEqual(w.currentStep(game).key, 'seer');
});

test('acting out of turn is refused', () => {
  const game = dealt(['seer', 'werewolf', 'villager', 'robber', 'troublemaker', 'tanner']);
  assert.throws(() => w.submitNight(game, 'p0', { mode: 'centre', centres: [0, 1] }), { key: 'notYourTurn' });
  stepTo(game, 'seer');
  w.submitNight(game, 'p0', { mode: 'centre', centres: [0, 1] });
  assert.throws(() => w.submitNight(game, 'p0', { mode: 'centre', centres: [0, 2] }), { key: 'alreadyActed' });
});

// ---------------------------------------------------------------- no leaks

test('a night view never says who is awake or who has acted', () => {
  const game = dealt(['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner']);
  stepTo(game, 'seer');
  w.submitNight(game, 'p0', { mode: 'player', target: 'p1' });

  for (const p of game.players) {
    const view = w.viewFor(game, p.id, clock);
    assert.deepEqual(view.waitingFor, [], 'nobody is waited on by name');
    for (const other of view.players) {
      assert.equal(other.acted, undefined, `${p.id} could see whether ${other.id} has acted`);
      assert.equal(other.startRole, undefined);
    }
    assert.equal(view.centre, null);
  }
});

test('everyone sees the same step and the same clock', () => {
  const game = dealt(['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner']);
  stepTo(game, 'robber');
  const nights = game.players.map((p) => w.viewFor(game, p.id, clock).night);
  assert.ok(nights.every((n) => n.key === 'robber'));
  assert.equal(new Set(nights.map((n) => n.msLeft)).size, 1, 'one clock for the room');
  assert.equal(new Set(nights.map((n) => n.index)).size, 1);
});

test('only the player whose step it is gets controls or knowledge', () => {
  const game = dealt(['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner']);
  stepTo(game, 'seer');
  const seer = w.viewFor(game, 'p0', clock);
  assert.equal(seer.you.awake, true);
  assert.equal(seer.you.action, 'seer');

  // A sleeping player keeps their own earlier findings and gains nothing new.
  for (const other of ['p1', 'p2']) {
    const view = w.viewFor(game, other, clock);
    assert.equal(view.you.awake, false);
    assert.equal(view.you.action, null);
    const learned = JSON.stringify(view.info);
    assert.ok(!learned.includes('sawPlayer'), `${other} saw the seer's reading`);
    assert.ok(!learned.includes('Ann'), `${other} was told something about the seer`);
  }
});

// ---------------------------------------------------------------- roles

test('a pair of werewolves gets its own step and sees each other', () => {
  const game = dealt(['werewolf', 'werewolf', 'villager', 'seer', 'robber', 'troublemaker']);
  stepTo(game, 'werewolf');
  const view = w.viewFor(game, 'p0', clock);

  assert.equal(view.you.awake, true, 'a paired wolf is awake, not asleep');
  assert.equal(view.you.action, null, 'but has no centre card to look at');
  assert.deepEqual(view.info.map((k) => k.key), ['onuw.info.packmates']);
  assert.deepEqual(view.info[0].params.names, ['Bo']);
});

test('a lone werewolf may look at one centre card', () => {
  const game = dealt(['werewolf', 'villager', 'seer', 'werewolf', 'robber', 'troublemaker']);
  stepTo(game, 'werewolf');
  const view = w.viewFor(game, 'p0', clock);
  assert.equal(view.you.action, 'loneWolf');
  assert.deepEqual(view.info.map((k) => k.key), ['onuw.info.loneWolf']);

  w.submitNight(game, 'p0', { centre: 1 });
  // The card is readable straight away, while the wolf is still awake.
  const seen = w.viewFor(game, 'p0', clock).info.find((e) => e.key === 'onuw.info.sawCentre');
  assert.equal(seen.params.role, 'robber');
});

test('the minion sees the werewolves and they do not see the minion', () => {
  const game = dealt(['minion', 'werewolf', 'seer', 'robber', 'troublemaker', 'villager']);
  stepTo(game, 'minion');
  const seen = w.viewFor(game, 'p0', clock).info;
  assert.equal(seen[0].key, 'onuw.info.minionSees');
  assert.deepEqual(seen[0].params.names, ['Bo']);

  const wolf = w.staticKnowledge(game, 'p1');   // the wolf step is already behind us
  assert.ok(!JSON.stringify(wolf).includes('Ann'), 'the wolf is not told about the minion');
});

test('a mason with no partner is told so', () => {
  const pair = dealt(['mason', 'mason', 'seer', 'robber', 'troublemaker', 'werewolf']);
  assert.deepEqual(w.staticKnowledge(pair, 'p0')[0].params.names, ['Bo']);
  const alone = dealt(['mason', 'werewolf', 'seer', 'robber', 'troublemaker', 'mason']);
  assert.equal(w.staticKnowledge(alone, 'p0')[0].key, 'onuw.info.masonAlone');
});

test('the seer looks at one player or two centre cards, not both', () => {
  const game = dealt(['seer', 'werewolf', 'robber', 'troublemaker', 'villager', 'tanner']);
  stepTo(game, 'seer');
  assert.throws(() => w.submitNight(game, 'p0', { mode: 'player', target: 'p0' }), { key: 'badTarget' });
  assert.throws(() => w.submitNight(game, 'p0', { mode: 'centre', centres: [0, 0] }), { key: 'badCentreCard' });

  w.submitNight(game, 'p0', { mode: 'centre', centres: [0, 2] });
  finishNight(game);
  const seen = infoFor(game, 'p0', 'onuw.info.sawTwoCentre');
  assert.equal(seen.params.roleA, 'troublemaker');
  assert.equal(seen.params.roleB, 'tanner');
});

test('the robber takes a card and is told what they now hold', () => {
  const game = dealt(['robber', 'werewolf', 'seer', 'troublemaker', 'villager', 'tanner']);
  stepTo(game, 'robber');
  w.submitNight(game, 'p0', { target: 'p1' });
  finishNight(game);

  assert.equal(infoFor(game, 'p0', 'onuw.info.robbed').params.role, 'werewolf');
  assert.equal(game.finalRoles.p0, 'werewolf');
  assert.equal(game.finalRoles.p1, 'robber');
});

test('the troublemaker swaps two others without learning anything', () => {
  const game = dealt(['troublemaker', 'werewolf', 'seer', 'robber', 'villager', 'tanner']);
  stepTo(game, 'troublemaker');
  assert.throws(() => w.submitNight(game, 'p0', { targets: ['p0', 'p1'] }), { key: 'troublemakerNotSelf' });
  w.submitNight(game, 'p0', { targets: ['p1', 'p2'] });
  finishNight(game);

  assert.equal(game.finalRoles.p1, 'seer');
  assert.equal(game.finalRoles.p2, 'werewolf');
  assert.ok(!JSON.stringify(game.info.p0).includes('werewolf'));
});

test('the drunk must swap, and swaps even after running out of time', () => {
  const game = dealt(['drunk', 'werewolf', 'seer', 'robber', 'villager', 'tanner']);
  stepTo(game, 'drunk');
  assert.throws(() => w.submitNight(game, 'p0', { skip: true }), { key: 'drunkMustSwap' });
  w.submitNight(game, 'p0', { centre: 2 });
  finishNight(game);
  assert.equal(game.finalRoles.p0, 'tanner');
  assert.equal(game.centre[2], 'drunk');
  assert.ok(!JSON.stringify(game.info.p0).includes('tanner'), 'the drunk stays in the dark');

  const dozy = dealt(['drunk', 'werewolf', 'seer', 'robber', 'villager', 'tanner']);
  finishNight(dozy);   // never acts
  assert.notEqual(dozy.finalRoles.p0, 'drunk', 'a silent Drunk still swaps');
  assert.ok(dozy.centre.includes('drunk'));
});

test('the night resolves in wake order, not submission order', () => {
  // The Robber (step 6) takes the werewolf; the Troublemaker (step 7) moves it on.
  const game = dealt(['troublemaker', 'robber', 'werewolf', 'seer', 'villager', 'tanner', 'minion']);
  stepTo(game, 'robber');
  w.submitNight(game, 'p1', { target: 'p2' });
  stepTo(game, 'troublemaker');
  w.submitNight(game, 'p0', { targets: ['p1', 'p3'] });
  finishNight(game);

  assert.equal(infoFor(game, 'p1', 'onuw.info.robbed').params.role, 'werewolf',
    'the robber saw what they took, before the troublemaker interfered');
  assert.equal(game.finalRoles.p1, 'seer');
  assert.equal(game.finalRoles.p3, 'werewolf');
});

test('the insomniac sees the card they end the night holding', () => {
  const game = dealt(['insomniac', 'robber', 'werewolf', 'seer', 'villager', 'tanner']);
  stepTo(game, 'robber');
  w.submitNight(game, 'p1', { target: 'p0' });
  finishNight(game);
  assert.equal(infoFor(game, 'p0', 'onuw.info.insomniac').params.role, 'robber');
});

// ---------------------------------------------------------------- day

test('votes are counted, and a one-vote-each stand-off kills nobody', () => {
  assert.deepEqual([...tallyVotes(['a', 'b', 'c'], { a: 'b', b: 'c', c: 'a' }).dead], []);
  assert.deepEqual([...tallyVotes(['a', 'b', 'c'], { a: 'b', b: 'c', c: 'b' }).dead], ['b']);
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
  assert.deepEqual([...decideWinners(roles, new Set(['p0']))], []);
});

test('with no werewolf at the table the minion wins by getting somebody hanged', () => {
  const roles = { p0: 'minion', p1: 'villager', p2: 'seer' };
  // Nobody dies: the pack never existed, so the village is safe.
  assert.deepEqual([...decideWinners(roles, new Set())], ['village']);
  // An innocent hangs and the minion, alive or not, has done his job.
  assert.deepEqual([...decideWinners(roles, new Set(['p1']))], ['werewolf']);
  assert.deepEqual([...decideWinners(roles, new Set(['p0', 'p1']))], ['werewolf']);
  // Only the minion hangs: he loses, and so does everyone else.
  assert.deepEqual([...decideWinners(roles, new Set(['p0']))], []);
});

// ------------------------------------------------- house rule: decisive vote

const DECISIVE = { decisiveVote: true };

test('a decisive vote scores a table with a werewolf in it exactly as the book does', () => {
  const roles = { p0: 'werewolf', p1: 'villager', p2: 'minion' };
  for (const dead of [['p0'], ['p1'], ['p2'], ['p0', 'p1'], []]) {
    assert.deepEqual(
      [...decideWinners(roles, new Set(dead), DECISIVE)],
      [...decideWinners(roles, new Set(dead))],
      `dead: ${dead.join() || 'nobody'}`,
    );
  }
});

test('a decisive vote makes the lone minion the pack the village has to catch', () => {
  const roles = { p0: 'minion', p1: 'villager', p2: 'seer' };
  // Hanging him is the catch the book denies the village.
  assert.deepEqual([...decideWinners(roles, new Set(['p0']), DECISIVE)], ['village']);
  // And it stays the catch when the tie takes an innocent down with him.
  assert.deepEqual([...decideWinners(roles, new Set(['p0', 'p1']), DECISIVE)], ['village']);
  // Hanging only innocents is still his win, exactly as it is by the book.
  assert.deepEqual([...decideWinners(roles, new Set(['p1']), DECISIVE)], ['werewolf']);
  // Killing nobody was never wrong, and is not now.
  assert.deepEqual([...decideWinners(roles, new Set(), DECISIVE)], ['village']);
});

test('a decisive vote leaves no ending without a winner', () => {
  const roles = { p0: 'villager', p1: 'villager', p2: 'seer' };
  assert.deepEqual([...decideWinners(roles, new Set(['p0']))], [], 'by the book, nobody wins');
  assert.deepEqual([...decideWinners(roles, new Set(['p0']), DECISIVE)], ['werewolf']);
  assert.deepEqual([...decideWinners(roles, new Set(), DECISIVE)], ['village']);
});

test('a decisive vote does not save the werewolf side from a dead tanner', () => {
  const roles = { p0: 'minion', p1: 'tanner', p2: 'seer' };
  assert.deepEqual([...decideWinners(roles, new Set(['p1']), DECISIVE)], ['tanner']);
  assert.deepEqual([...decideWinners(roles, new Set(['p0', 'p1']), DECISIVE)].sort(), ['tanner', 'village']);

  const noPack = { p0: 'villager', p1: 'tanner', p2: 'seer' };
  assert.deepEqual([...decideWinners(noPack, new Set(['p1']), DECISIVE)], ['tanner']);
});

test('a new table plays with the decisive vote, and only the host can drop it', () => {
  const game = w.createGame('TEST', { now });
  ['Ann', 'Bo', 'Cai'].forEach((name, i) => w.addPlayer(game, { id: `p${i}`, name }));
  assert.equal(game.houseRules.decisiveVote, true, 'a new table plays with it');
  assert.equal(w.viewFor(game, 'p1', clock).houseRules.decisiveVote, true, 'and can see that it does');
  assert.throws(() => w.setOptions(game, 'p1', { houseRules: { decisiveVote: false } }), { key: 'hostOnly' });
  w.setOptions(game, 'p0', { houseRules: { decisiveVote: false } });
  assert.equal(w.viewFor(game, 'p1', clock).houseRules.decisiveVote, false);
  w.setOptions(game, 'p0', { houseRules: { decisiveVote: true } });
  assert.equal(w.viewFor(game, 'p1', clock).houseRules.decisiveVote, true);
});

test('the vote is scored by the house rule the table is playing with', () => {
  // No werewolf among the three players: the minion is the only enemy left.
  const deck = ['minion', 'villager', 'seer', 'werewolf', 'werewolf', 'villager'];
  const hang = (game) => {
    finishNight(game);
    w.startVote(game, 'p0');
    w.castVote(game, 'p1', 'p0');
    w.castVote(game, 'p2', 'p0');
    w.castVote(game, 'p0', 'p1');
    assert.deepEqual(game.dead, ['p0']);
    return game.winners;
  };

  assert.deepEqual(hang(dealt(deck)), ['village'], 'by default the table caught the pack');

  const byTheBook = dealt(deck);
  byTheBook.houseRules = { decisiveVote: false };
  assert.deepEqual(hang(byTheBook), [], 'switched off, the same vote wins for nobody');
});

test('the table\u2019s choice survives a game ending and the next deal', () => {
  const game = dealt(['minion', 'villager', 'seer', 'werewolf', 'werewolf', 'villager']);
  game.houseRules = { decisiveVote: false };
  finishNight(game);
  w.startVote(game, 'p0');
  for (const [voter, target] of [['p0', 'p1'], ['p1', 'p0'], ['p2', 'p0']]) w.castVote(game, voter, target);
  w.resetToLobby(game, 'p0', { now });
  assert.equal(game.phase, 'lobby');
  assert.equal(game.houseRules.decisiveVote, false, 'the table agreed it, not that one game');
});

test('a room restored from before house rules existed keeps the scoring it started under', () => {
  const game = dealt(['minion', 'villager', 'seer', 'werewolf', 'werewolf', 'villager']);
  delete game.houseRules;   // a snapshot taken by an older server
  finishNight(game);
  w.startVote(game, 'p0');
  for (const [voter, target] of [['p1', 'p0'], ['p2', 'p0'], ['p0', 'p1']]) w.castVote(game, voter, target);
  assert.deepEqual(game.winners, [], 'the book\u2019s ending, not the variant\u2019s');
  assert.deepEqual(w.viewFor(game, 'p0', clock).houseRules, { decisiveVote: false });
});

test('a lone minion is told the decisive vote has made him the quarry', () => {
  const decisive = dealt(['minion', 'villager', 'seer', 'werewolf', 'werewolf', 'villager']);
  stepTo(decisive, 'minion');
  assert.ok(infoFor(decisive, 'p0', 'onuw.info.minionIsPack'));
  assert.equal(infoFor(decisive, 'p0', 'onuw.info.minionAlone'), undefined);

  const byTheBook = dealt(['minion', 'villager', 'seer', 'werewolf', 'werewolf', 'villager']);
  byTheBook.houseRules = { decisiveVote: false };
  stepTo(byTheBook, 'minion');
  assert.ok(infoFor(byTheBook, 'p0', 'onuw.info.minionAlone'));
  assert.equal(infoFor(byTheBook, 'p0', 'onuw.info.minionIsPack'), undefined);
});

test('a tanner death still costs the minion the win', () => {
  const roles = { p0: 'minion', p1: 'tanner', p2: 'seer' };
  assert.deepEqual([...decideWinners(roles, new Set(['p1']))], ['tanner']);
});

test('the tanner wins by dying, and takes the werewolves down with him', () => {
  const roles = { p0: 'tanner', p1: 'werewolf', p2: 'villager' };
  assert.deepEqual([...decideWinners(roles, new Set(['p0']))], ['tanner']);
  assert.deepEqual([...decideWinners(roles, new Set(['p0', 'p1']))].sort(), ['tanner', 'village']);
});

test('a full three player game plays through to a verdict', () => {
  const game = dealt(['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner']);
  stepTo(game, 'seer');
  w.submitNight(game, 'p0', { mode: 'player', target: 'p1' });
  stepTo(game, 'robber');
  w.submitNight(game, 'p2', { target: 'p1' });
  finishNight(game);

  assert.equal(infoFor(game, 'p0', 'onuw.info.sawPlayer').params.role, 'werewolf');
  assert.throws(() => w.castVote(game, 'p0', 'p1'), { key: 'wrongPhase' });

  w.startVote(game, 'p0');
  assert.throws(() => w.castVote(game, 'p0', 'p0'), { key: 'cannotVoteSelf' });
  w.castVote(game, 'p0', 'p2');
  w.castVote(game, 'p1', 'p2');
  w.castVote(game, 'p2', 'p0');

  assert.equal(game.phase, 'over');
  assert.deepEqual(game.dead, ['p2']);
  assert.equal(game.finalRoles.p2, 'werewolf');
  assert.deepEqual(game.winners, ['village']);
});

test('the hunter takes their target down too', () => {
  const game = dealt(['hunter', 'werewolf', 'villager', 'seer', 'robber', 'troublemaker']);
  finishNight(game);
  w.startVote(game, 'p0');
  w.castVote(game, 'p0', 'p1');
  w.castVote(game, 'p1', 'p0');
  w.castVote(game, 'p2', 'p0');

  assert.deepEqual(game.dead.slice().sort(), ['p0', 'p1'], 'the hunter died and shot the wolf');
  assert.deepEqual(game.winners, ['village']);
});

test('everything is revealed once the votes are in', () => {
  const game = dealt(['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner']);
  stepTo(game, 'robber');
  w.submitNight(game, 'p2', { target: 'p1' });
  finishNight(game);
  w.startVote(game, 'p0');
  for (const [voter, target] of [['p0', 'p2'], ['p1', 'p2'], ['p2', 'p0']]) w.castVote(game, voter, target);

  const view = w.viewFor(game, 'p1', clock);
  assert.ok(view.players.every((p) => p.startRole && p.finalRole));
  assert.equal(view.centre.length, 3);
  assert.equal(view.night, null, 'the clock is gone by then');
  assert.ok(view.swaps.length >= 1);
  assert.equal(view.youWon, true, 'you are the card you finish holding');
  assert.equal(w.viewFor(game, 'p2', clock).youWon, false);
});

test('play again reshuffles the same table', () => {
  const game = dealt(['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner']);
  finishNight(game);
  w.startVote(game, 'p0');
  for (const [voter, target] of [['p0', 'p2'], ['p1', 'p2'], ['p2', 'p0']]) w.castVote(game, voter, target);

  assert.throws(() => w.resetToLobby(game, 'p1'), { key: 'hostOnly' });
  w.resetToLobby(game, 'p0');
  assert.equal(game.phase, 'lobby');
  assert.equal(game.players.length, 3);
  assert.deepEqual(game.dead, []);
  assert.equal(game.step, -1);
  assert.deepEqual(game.script, []);
  assert.deepEqual(w.viewFor(game, 'p0', clock).players[0].startRole, undefined);
});

test('the host can abandon an active night without changing the table settings', () => {
  const game = dealt(['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner']);
  game.pace = 'fast';
  assert.equal(game.phase, 'night');
  assert.throws(() => w.restartToLobby(game, 'p1'), { key: 'hostOnly' });
  w.restartToLobby(game, 'p0');
  assert.equal(game.phase, 'lobby');
  assert.equal(game.players.length, 3);
  assert.equal(game.pace, 'fast');
  assert.deepEqual(game.startRoles, {});
  assert.deepEqual(game.script, []);
});
