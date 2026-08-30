// Renders every phase of a real game. The views come from the actual engine,
// so a mismatch between what the server sends and what the client reads shows
// up here rather than on someone's phone.
import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from './dom-shim.js';
import * as g from '../src/server/games/avalon/game.ts';
import { sideOf } from '../src/server/games/avalon/rules.ts';

const dom = installDom();
const client = await import('../src/client/app.ts');
await client.ready;
const { app, render } = client;

/** A deterministic five-player game, past role confirmation unless asked. */
function newGame({ confirm = true } = {}) {
  const game = g.createGame('WXYZ');
  ['Ann', '张三', 'Cai', 'Dee', 'Eli'].forEach((name, i) => g.addPlayer(game, { id: `p${i}`, name }));
  // Pin the deck: the lobby otherwise picks one to suit the table size.
  g.setOptions(game, 'p0', { percival: false, morgana: false, mordred: false, oberon: false });
  g.startGame(game, 'p0', { shuffle: (l) => l });
  game.state.leaderIndex = 0;
  if (confirm) for (const p of game.room.players) g.confirmRole(game, p.id);
  return game;
}

/** Draw what `playerId` would see right now. */
function show(game, playerId, lang = 'en') {
  app.lang = lang;
  app.server = '';
  app.serverStatus = 'ready';
  app.code = game.room.code;
  app.playerId = playerId;
  app.selection = [];
  app.infoPopup = null;
  app.view = g.viewFor(game, playerId);
  render();
  return dom.fixtures.view;
}

test('the Avalon lobby uses the shared aligned role picker', () => {
  const game = g.createGame('WXYZ');
  ['Ann', '张三', 'Cai', 'Dee', 'Eli'].forEach((name, i) => g.addPlayer(game, { id: `p${i}`, name }));
  g.setOptions(game, 'p0', { percival: true });
  const view = show(game, 'p0');
  assert.equal(view.byClass('role-options').length, 1);
  assert.equal(view.byClass('role-option').length, 4);
  const percival = view.byClass('role-option').find((row) => row.text.includes('Percival'));
  assert.match(percival.className, /selected/);
  assert.equal(percival.byClass('role-option-name')[0].text, 'Percival');
  assert.match(percival.byClass('role-option-description')[0].text, /Merlin/);
});

const buttons = (node) => node.findAll((n) => n.tagName === 'BUTTON');
const labelled = (node, re) => buttons(node).filter((b) => re.test(b.text));
const evilId = (game) => game.room.players.find((p) => sideOf(game.state.roles[p.id]) === 'evil').id;
const goodId = (game) => game.room.players.find((p) => sideOf(game.state.roles[p.id]) === 'good').id;
const roleId = (game, role) => game.room.players.find((p) => game.state.roles[p.id] === role).id;

// Any of these appearing verbatim means a string was never translated.
const KEY_PREFIXES = ['log', 'err', 'role', 'roleDesc', 'phase', 'vote', 'quest', 'board', 'team',
                      'win', 'over', 'lobby', 'home', 'server', 'know', 'side', 'reveal', 'assassin'];
function assertNoRawKeys(view, where) {
  const raw = new RegExp(`\\b(${KEY_PREFIXES.join('|')})\\.[a-zA-Z]\\w*`, 'g');
  const hits = view.text.match(raw) ?? [];
  assert.deepEqual(hits, [], `untranslated key(s) rendered in ${where}`);
}

test('the reveal screen shows your own role and waits for everyone', () => {
  const game = newGame({ confirm: false });
  const merlin = roleId(game, 'merlin');
  const view = show(game, merlin);

  const self = view.byClass('player').find((row) => row.byClass('name')[0]?.text === game.room.players.find((p) => p.id === merlin).name);
  assert.match(self.className, /is-you/, 'the current player is a styled row, not another tag');
  assert.equal(self.byClass('tag').some((tag) => tag.text === 'you'), false);
  assert.ok(self.byClass('player-number').length, 'the seat number rides on the avatar');
  assert.doesNotMatch(view.text, /Merlin/, 'the role starts hidden');
  view.byId('roleToggle').dispatch('click');
  const open = dom.fixtures.view;
  assert.match(open.text, /Merlin/);
  assert.match(open.text, /Good/);
  open.byId('infoPopupBackdrop').dispatch('click');
  assert.doesNotMatch(dom.fixtures.view.text, /Merlin/, 'clicking outside hides it again');
  assert.equal(labelled(view, /I have seen my role/).length, 1);
  assertNoRawKeys(view, 'reveal screen');

  // Confirming swaps the button for a list of who is still reading.
  g.confirmRole(game, merlin);
  const after = show(game, merlin);
  assert.equal(labelled(after, /I have seen my role/).length, 0);
  assert.match(after.text, /Waiting for:/);
});

test('Avalon offers matching role and reference popups', () => {
  const game = newGame({ confirm: false });
  const view = show(game, 'p0');
  const tools = view.byClass('info-buttons')[0];
  assert.deepEqual(buttons(tools).map((button) => button.text), ['Show my role', 'Roles in this game']);
  assert.doesNotMatch(view.text, /Role guide/);

  view.byId('avalonRefToggle').dispatch('click');
  const open = dom.fixtures.view;
  assert.match(open.text, /Role guide \(5 players\)/);
  assert.match(open.text, /Merlin/);
  assert.match(open.text, /Assassin/);
  assert.match(open.text, /Loyal Servant of Arthur ×2/);
  assert.match(open.text, /Guide good without revealing yourself/);
  open.byId('infoPopupBackdrop').dispatch('click');
  assert.doesNotMatch(dom.fixtures.view.text, /Role guide/);
});

test('only the host can confirm an active-game reset', () => {
  const game = newGame();
  let view = show(game, 'p1');
  assert.equal(view.byId('resetGame'), null);

  view = show(game, game.room.hostId);
  dom.calls.length = 0;
  dom.state.confirmations.length = 0;
  dom.state.confirmResult = false;
  view.byId('resetGame').dispatch('click');
  assert.deepEqual(dom.state.confirmations, [
    'Reset this game? The current game will end and everyone will return to the lobby.',
  ]);
  assert.equal(dom.calls.find((entry) => entry.path.endsWith('/action')), undefined);

  dom.state.confirmResult = true;
  view.byId('resetGame').dispatch('click');
  const call = dom.calls.find((entry) => entry.path.endsWith('/action'));
  assert.equal(call.body.type, 'reset');
});

test('the reset confirmation follows the host language', () => {
  const game = newGame();
  const view = show(game, game.room.hostId, 'zh');
  dom.state.confirmations.length = 0;
  dom.state.confirmResult = false;
  view.byId('resetGame').dispatch('click');
  assert.deepEqual(dom.state.confirmations, [
    '确定要重置本局游戏吗？当前游戏将结束，所有玩家都会返回等待室。',
  ]);
  dom.state.confirmResult = true;
});

test('Merlin is shown who is evil, but never told their roles', () => {
  const game = newGame();
  const merlin = roleId(game, 'merlin');
  const view = show(game, merlin);
  view.byId('roleToggle').dispatch('click');

  const evilNames = game.room.players
    .filter((p) => sideOf(game.state.roles[p.id]) === 'evil')
    .map((p) => p.name);
  // The marker is the moon sigil the reveal card teaches, not the word "evil".
  const tags = dom.fixtures.view.byClass('faction-sigil').filter((t) => t.className.includes('mini'));
  assert.equal(tags.length, evilNames.length, 'one marker per evil player');
  assert.ok(tags.every((t) => t.text === '☾' && t.getAttribute('aria-label') === 'evil'),
    'and it still says which side it means');

  // Each marker sits in a row naming that player, and nothing names a role.
  const rows = tags.map((t) => t.parentNode.text);
  for (const name of evilNames) assert.ok(rows.some((r) => r.includes(name)), `${name} is listed`);
  for (const row of rows) {
    assert.ok(!/Morgana|Mordred|Oberon|Minion|Assassin/.test(row), `a role name leaked: ${row}`);
  }
});

test('a loyal servant is told plainly that they know nothing', () => {
  const game = newGame();
  const view = show(game, roleId(game, 'servant'));
  view.byId('roleToggle').dispatch('click');
  assert.match(dom.fixtures.view.text, /Loyal Servant/);
  assert.match(dom.fixtures.view.text, /know nothing about the other players/i);
});

test('the leader gets pickable players and a disabled submit until the team is full', () => {
  const game = newGame();
  const view = show(game, 'p0');
  assert.match(view.text, /You are the leader/);

  const submit = labelled(view, /Propose team/)[0];
  assert.ok(submit, 'there is a submit button');
  assert.equal(submit.disabled, true, 'nothing is selected yet');

  // Player rows are buttons for the leader.
  const rows = view.byClass('player').filter((n) => n.tagName === 'BUTTON');
  assert.equal(rows.length, 5);
  rows[0].dispatch('click');
  rows[1].dispatch('click');
  assert.deepEqual(app.selection, ['p0', 'p1']);
  assert.equal(labelled(dom.fixtures.view, /Propose team/)[0].disabled, false);
  assert.match(dom.fixtures.view.text, /Selected 2\/2/);
});

test('a non-leader sees who is choosing and cannot pick', () => {
  const game = newGame();
  const view = show(game, 'p1');
  assert.match(view.text, /Ann is the leader/);
  assert.equal(labelled(view, /Propose team/).length, 0);
  assert.equal(view.byClass('player').filter((n) => n.tagName === 'BUTTON').length, 0);
});

test('the vote screen offers approve and reject, then reports the tally', () => {
  const game = newGame();
  g.proposeTeam(game, 'p0', ['p0', 'p1']);
  g.castVote(game, 'p0', true);
  let view = show(game, 'p2');
  assert.match(view.text, /Do you approve this team\?/);
  assert.match(view.text, /Proposed team: Ann, 张三/);
  assert.equal(labelled(view, /^Approve$/).length, 1);
  assert.equal(labelled(view, /^Reject$/).length, 1);
  const annPending = view.byClass('player').find((row) => row.text.includes('Ann'));
  const locked = annPending.byClass('status-glyph');
  assert.equal(locked.length, 1, 'a locked-in choice shows as one token');
  assert.equal(locked[0].text, '◆');
  assert.equal(locked[0].getAttribute('title'), 'Voted');
  assert.doesNotMatch(annPending.text, /Approve|Reject|✓|✕/, 'a pending choice stays secret');
  assertNoRawKeys(view, 'vote');

  g.castVote(game, 'p1', false);
  for (const p of game.room.players.slice(2)) g.castVote(game, p.id, true);
  view = show(game, 'p2');
  assert.match(view.text, /4 approve, 1 reject/);
  assert.match(view.text, /approved/);
  // Resolved votes read as a tick or a cross, each still named for a reader.
  const resultRows = view.byClass('vote-result')[0].byClass('player');
  const token = (name) => resultRows.find((row) => row.text.includes(name)).byClass('tag')[0];
  assert.equal(token('Ann').text, '✓');
  assert.equal(token('Ann').getAttribute('aria-label'), 'Approve');
  assert.equal(token('张三').text, '✕');
  assert.equal(token('张三').getAttribute('aria-label'), 'Reject');
});

test('only evil players are offered a fail card', () => {
  const game = newGame();
  const evil = evilId(game);
  const good = goodId(game);
  g.proposeTeam(game, 'p0', [good, evil]);
  for (const p of game.room.players) g.castVote(game, p.id, true);

  const evilView = show(game, evil);
  assert.equal(labelled(evilView, /^Success$/).length, 1);
  assert.equal(labelled(evilView, /^Fail$/).length, 1);

  const goodView = show(game, good);
  assert.equal(labelled(goodView, /^Success$/).length, 1);
  assert.equal(labelled(goodView, /^Fail$/).length, 0, 'good players get no fail button');
  assert.match(goodView.text, /must play Success/);

  // A player not on the quest just watches.
  const bystander = game.room.players.map((p) => p.id).find((id) => id !== good && id !== evil);
  const watching = show(game, bystander);
  assert.equal(labelled(watching, /^Success$/).length, 0);
});

test('the board marks a failed quest and warns on the fifth rejection', () => {
  const game = newGame();
  // Fail quest one.
  const evil = evilId(game);
  const good = goodId(game);
  g.proposeTeam(game, 'p0', [good, evil]);
  for (const p of game.room.players) g.castVote(game, p.id, true);
  g.playCard(game, good, true);
  g.playCard(game, evil, false);

  let view = show(game, 'p0');
  assert.equal(view.byClass('quest').filter((q) => q.className.includes('fail')).length, 1);
  assert.match(view.text, /Rejected proposals: 0\/5/);

  // Now stack up four rejections.
  for (let i = 0; i < 4; i++) {
    const leader = game.room.players[game.state.leaderIndex].id;
    g.proposeTeam(game, leader, game.room.players.slice(0, g.currentTeamSize(game)).map((p) => p.id));
    for (const p of game.room.players) g.castVote(game, p.id, false);
  }
  view = show(game, 'p0');
  assert.match(view.text, /One more rejection and evil wins/);
  assert.equal(view.byClass('pip').filter((p) => p.className.includes('on')).length, 4);
});

test('the assassin is asked to name Merlin and good players are not', () => {
  const game = newGame();
  for (let round = 0; round < 3; round++) {
    const leader = game.room.players[game.state.leaderIndex].id;
    const team = game.room.players.slice(0, g.currentTeamSize(game)).map((p) => p.id);
    g.proposeTeam(game, leader, team);
    for (const p of game.room.players) g.castVote(game, p.id, true);
    for (const id of team) g.playCard(game, id, true);
  }
  assert.equal(game.state.phase, 'assassin');

  const assassin = roleId(game, 'assassin');
  const view = show(game, assassin);
  assert.match(view.text, /Name Merlin to steal the game/);
  const kill = labelled(view, /Assassinate/)[0];
  assert.equal(kill.disabled, true, 'no target picked yet');

  const others = show(game, roleId(game, 'servant'));
  assert.match(others.text, /Assassin is choosing a target/);
  assert.equal(labelled(others, /Assassinate/).length, 0);
});

test('the end screen names the winner and reveals every role', () => {
  const game = newGame();
  for (let round = 0; round < 3; round++) {
    const leader = game.room.players[game.state.leaderIndex].id;
    const team = game.room.players.slice(0, g.currentTeamSize(game)).map((p) => p.id);
    g.proposeTeam(game, leader, team);
    for (const p of game.room.players) g.castVote(game, p.id, true);
    for (const id of team) g.playCard(game, id, true);
  }
  g.assassinate(game, roleId(game, 'assassin'), roleId(game, 'merlin'));

  const view = show(game, 'p1');
  assert.match(view.text, /Evil wins!/);
  assert.match(view.text, /The Assassin found Merlin/);
  assert.match(view.text, /Merlin/);
  assert.match(view.text, /Loyal Servant/);
  assert.match(view.text, /Assassin/);
  assertNoRawKeys(view, 'end screen');
});

test('the whole game reads in Chinese too', () => {
  const game = newGame();
  g.proposeTeam(game, 'p0', ['p0', 'p1']);
  const view = show(game, 'p2', 'zh');
  assert.match(view.text, /投票表决/);
  assert.match(view.text, /赞成/);
  assert.match(view.text, /反对/);
  assert.match(view.text, /提名队伍：Ann、张三/, 'Chinese uses its own list separator');
  assertNoRawKeys(view, 'Chinese vote screen');
});

test('the history reads as sentences, not keys, in both languages', () => {
  const game = newGame();
  g.proposeTeam(game, 'p0', ['p0', 'p1']);
  for (const p of game.room.players) g.castVote(game, p.id, true);

  const en = show(game, 'p0');
  assert.match(en.text, /Ann proposed Ann, 张三/);
  assert.match(en.text, /Team approved \(5–0\)/);

  const zh = show(game, 'p0', 'zh');
  assert.match(zh.text, /Ann 提名了 Ann、张三/);
  assert.match(zh.text, /队伍通过（5–0）/);
  assertNoRawKeys(zh, 'Chinese history');
});

test('the battle report keeps every completed game and colors players by side', () => {
  const game = newGame();
  const finishByRejections = () => {
    for (let i = 0; i < 5; i++) {
      g.proposeTeam(game, game.room.players[game.state.leaderIndex].id, ['p0', 'p1']);
      for (const player of game.room.players) g.castVote(game, player.id, false);
    }
  };

  finishByRejections();
  g.resetToLobby(game, 'p0');
  g.startGame(game, 'p0', { shuffle: (list) => list });
  for (const player of game.room.players) g.confirmRole(game, player.id);
  game.state.leaderIndex = 0;
  finishByRejections();
  g.resetToLobby(game, 'p0');

  const view = show(game, 'p0', 'zh');
  const results = view.byClass('game-result');
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.match(result.text, /^获胜：.+失败：.+$/);
    assert.equal(result.byClass('evil').length, 2);
    assert.equal(result.byClass('good').length, 3);
    assert.doesNotMatch(result.text, /梅林|刺客|忠臣|爪牙/);
  }
});

// Every click redraws the whole view. These guard the things a redraw used to
// throw away: where the middle pane was scrolled to, and whether the player
// had the journal open.

test('the middle pane keeps its scroll position across a redraw', () => {
  const game = newGame();
  g.proposeTeam(game, 'p0', ['p0', 'p1']);
  const view = show(game, 'p2');

  view.byClass('phase-area')[0].scrollTo_(180);
  render();
  assert.equal(view.byClass('phase-area')[0].scrollTop, 180);

  // A new phase is new content, so it starts at the top again.
  for (const p of game.room.players) g.castVote(game, p.id, true);
  app.view = g.viewFor(game, 'p2');
  render();
  assert.equal(view.byClass('phase-area')[0].scrollTop, 0);
});

test('the journal stays open across a redraw', () => {
  const game = newGame();
  g.proposeTeam(game, 'p0', ['p0', 'p1']);
  const view = show(game, 'p2');

  const journal = view.byClass('journal')[0];
  assert.equal(journal.open, false);
  journal.open = true;
  journal.dispatch('toggle', { target: journal });

  render();
  assert.equal(view.byClass('journal')[0].open, true, 'a redraw must not shut the log');
});

// ---------------------------------------------------------------- the lobby

/** A lobby of `count` players, nobody having touched a switch. */
function lobby(count = 7) {
  const game = g.createGame('WXYZ');
  ['Ann', '张三', 'Cai', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jon']
    .slice(0, count).forEach((name, i) => g.addPlayer(game, { id: `p${i}`, name }));
  return game;
}

test('the lobby names the characters the table will be dealt', () => {
  const view = show(lobby(7), 'p0');
  const deck = view.byClass('deck')[0].findAll((n) => n.className?.includes('tag'));
  assert.deepEqual(deck.map((tag) => tag.text),
    ['Merlin', 'Percival', 'Loyal Servant of Arthur ×2', 'Assassin', 'Morgana', 'Oberon']);
  assert.deepEqual(deck.map((tag) => tag.className.includes('evil')),
    [false, false, false, true, true, true], 'each side is coloured as its own');
  assertNoRawKeys(view, 'the lobby');
});

test('the deck follows the table size, and the toggles follow the deck', () => {
  let view = show(lobby(5), 'p0');
  assert.match(view.byClass('deck')[0].text, /Morgana/);
  assert.doesNotMatch(view.byClass('deck')[0].text, /Oberon/);
  const selected = view.byClass('role-option')
    .filter((row) => row.className.includes('selected'))
    .map((row) => row.byClass('role-option-name')[0].text);
  assert.deepEqual(selected, ['Percival', 'Morgana']);

  view = show(lobby(10), 'p0');
  assert.match(view.byClass('deck')[0].text, /Oberon/);
  assert.match(view.byClass('deck')[0].text, /Loyal Servant of Arthur ×4/);
});

test('a lobby that cannot be dealt says so instead of showing a deck', () => {
  const game = lobby(5);
  g.setOptions(game, 'p0', { mordred: true });   // one evil too many at five
  const view = show(game, 'p0');
  assert.equal(view.byClass('deck').length, 0);
  assert.match(view.text, /do not fit 5 players/);
});

test('the lobby offers the house rules, and only the host may throw them', () => {
  const game = lobby(5);
  let view = show(game, 'p0');
  assert.match(view.text, /House rules/);
  assert.deepEqual(view.byClass('house-rule-name').map((n) => n.text),
    ['Random leader', 'Hidden votes', 'Reset rejection count']);
  assert.match(view.text, /never who voted which way/, 'a variant explains itself, switch untouched');
  assert.equal(view.byClass('role-option').length, 4, 'a house rule is not one of the cards');
  assert.equal(view.byClass('house-rule').filter((r) => r.className.includes('selected')).length, 0,
    'the printed game is what a new table plays');

  dom.calls.length = 0;
  const box = view.byClass('house-rule')[1].findAll((n) => n.tagName === 'INPUT')[0];
  box.checked = true;
  box.dispatch('change');
  const sent = dom.calls.find((c) => c.path.endsWith('/action'));
  assert.deepEqual(sent.body.options, { houseRules: { hiddenVotes: true } });

  g.setOptions(game, 'p0', { houseRules: { hiddenVotes: true } });
  view = show(game, 'p0');
  assert.match(view.byClass('house-rule')[1].className, /selected/);

  view = show(game, 'p1');   // not the host
  assert.equal(view.byClass('house-rule')[1].findAll((n) => n.tagName === 'INPUT')[0].disabled, true);
});

test('the house rules in force are named in the reference panel, in both languages', () => {
  const game = lobby(5);
  g.setOptions(game, 'p0', { houseRules: { resetRejects: true } });
  g.startGame(game, 'p0', { shuffle: (l) => l });
  for (const p of game.room.players) g.confirmRole(game, p.id);

  let view = show(game, 'p0');
  assert.doesNotMatch(view.text, /Reset rejection count/, 'it lives behind the reference button');
  view.byId('avalonRefToggle').dispatch('click');
  view = dom.fixtures.view;
  assert.match(view.text, /Reset rejection count/);
  assert.doesNotMatch(view.text, /Hidden votes/, 'only the ones this table agreed to');
  assertNoRawKeys(view, 'the reference panel with a house rule');

  view = show(game, 'p0', 'zh');
  view.byId('avalonRefToggle').dispatch('click');
  assert.match(dom.fixtures.view.text, /重置流局计数/);
});

// ---------------------------------------------------------------- hidden votes

/** A five-player game, past the first vote, playing with the given rules. */
function voted(rules) {
  const game = lobby(5);
  g.setOptions(game, 'p0', {
    percival: false, morgana: false, mordred: false, oberon: false, houseRules: rules,
  });
  g.startGame(game, 'p0', { shuffle: (l) => l });
  for (const p of game.room.players) g.confirmRole(game, p.id);
  g.proposeTeam(game, 'p0', ['p0', 'p1']);
  game.room.players.forEach((p, i) => g.castVote(game, p.id, i < 2));   // 2–3, rejected
  return game;
}

test('an open vote shows the tally and every ballot behind it', () => {
  const view = show(voted({}), 'p2');
  const result = view.byClass('vote-result')[0];
  assert.match(result.text, /Vote result: 2 approve, 3 reject — rejected/);
  assert.equal(result.byClass('verdict').length, 5);
  assert.deepEqual(result.byClass('verdict').map((tag) => tag.text), ['✓', '✓', '✕', '✕', '✕']);
});

test('a hidden vote shows the tally and no ballots at all', () => {
  const view = show(voted({ hiddenVotes: true }), 'p2');
  const result = view.byClass('vote-result')[0];
  assert.match(result.text, /Vote result: 2 approve, 3 reject — rejected/);
  assert.equal(result.byClass('verdict').length, 0, 'nobody is shown as having voted either way');
  assert.match(result.text, /Only the tally is published/);
  assertNoRawKeys(view, 'a hidden vote');
});

test('the reset rule still warns that the fifth rejection gives evil the game', () => {
  const game = voted({ resetRejects: true });
  for (let i = 0; i < 3; i++) {          // four rejections in all: one to go
    g.proposeTeam(game, game.room.players[game.state.leaderIndex].id, ['p0', 'p1']);
    for (const p of game.room.players) g.castVote(game, p.id, false);
  }
  assert.match(show(game, 'p2').byClass('banner')[0].text, /evil wins/);
});
