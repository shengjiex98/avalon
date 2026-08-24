// Renders every phase of a real game. The views come from the actual engine,
// so a mismatch between what the server sends and what the client reads shows
// up here rather than on someone's phone.
import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from './dom-shim.js';
import * as g from '../src/games/avalon/game.js';
import { sideOf } from '../src/games/avalon/rules.js';

const dom = installDom();
const client = await import('../public/app.js');
await client.ready;
const { app, render } = client;

/** A deterministic five-player game, past role confirmation unless asked. */
function newGame({ confirm = true } = {}) {
  const game = g.createGame('WXYZ');
  ['Ann', '张三', 'Cai', 'Dee', 'Eli'].forEach((name, i) => g.addPlayer(game, { id: `p${i}`, name }));
  g.startGame(game, 'p0', { shuffle: (l) => l });
  game.leaderIndex = 0;
  if (confirm) for (const p of game.players) g.confirmRole(game, p.id);
  return game;
}

/** Draw what `playerId` would see right now. */
function show(game, playerId, lang = 'en') {
  app.lang = lang;
  app.code = game.code;
  app.playerId = playerId;
  app.serverOk = true;
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
const evilId = (game) => game.players.find((p) => sideOf(game.roles[p.id]) === 'evil').id;
const goodId = (game) => game.players.find((p) => sideOf(game.roles[p.id]) === 'good').id;
const roleId = (game, role) => game.players.find((p) => game.roles[p.id] === role).id;

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

test('only the host sees the active-game reset control', () => {
  const game = newGame();
  let view = show(game, 'p1');
  assert.equal(view.byId('resetGame'), null);

  view = show(game, game.hostId);
  dom.calls.length = 0;
  view.byId('resetGame').dispatch('click');
  const call = dom.calls.find((entry) => entry.path.endsWith('/action'));
  assert.equal(call.body.type, 'reset');
});

test('Merlin is shown who is evil, but never told their roles', () => {
  const game = newGame();
  const merlin = roleId(game, 'merlin');
  const view = show(game, merlin);
  view.byId('roleToggle').dispatch('click');

  const evilNames = game.players
    .filter((p) => sideOf(game.roles[p.id]) === 'evil')
    .map((p) => p.name);
  const tags = dom.fixtures.view.byClass('tag').filter((t) => t.text === 'evil');
  assert.equal(tags.length, evilNames.length, 'one marker per evil player');

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
  assert.match(annPending.text, /Voted/);
  assert.doesNotMatch(annPending.text, /Approve|Reject/, 'a pending choice stays secret');
  assertNoRawKeys(view, 'vote');

  g.castVote(game, 'p1', false);
  for (const p of game.players.slice(2)) g.castVote(game, p.id, true);
  view = show(game, 'p2');
  assert.match(view.text, /4 approve, 1 reject/);
  assert.match(view.text, /approved/);
  const resultRows = view.byClass('vote-result')[0].byClass('player');
  assert.match(resultRows.find((row) => row.text.includes('Ann')).text, /Approve/);
  assert.match(resultRows.find((row) => row.text.includes('张三')).text, /Reject/);
});

test('only evil players are offered a fail card', () => {
  const game = newGame();
  const evil = evilId(game);
  const good = goodId(game);
  g.proposeTeam(game, 'p0', [good, evil]);
  for (const p of game.players) g.castVote(game, p.id, true);

  const evilView = show(game, evil);
  assert.equal(labelled(evilView, /^Success$/).length, 1);
  assert.equal(labelled(evilView, /^Fail$/).length, 1);

  const goodView = show(game, good);
  assert.equal(labelled(goodView, /^Success$/).length, 1);
  assert.equal(labelled(goodView, /^Fail$/).length, 0, 'good players get no fail button');
  assert.match(goodView.text, /must play Success/);

  // A player not on the quest just watches.
  const bystander = game.players.map((p) => p.id).find((id) => id !== good && id !== evil);
  const watching = show(game, bystander);
  assert.equal(labelled(watching, /^Success$/).length, 0);
});

test('the board marks a failed quest and warns on the fifth rejection', () => {
  const game = newGame();
  // Fail quest one.
  const evil = evilId(game);
  const good = goodId(game);
  g.proposeTeam(game, 'p0', [good, evil]);
  for (const p of game.players) g.castVote(game, p.id, true);
  g.playCard(game, good, true);
  g.playCard(game, evil, false);

  let view = show(game, 'p0');
  assert.equal(view.byClass('quest').filter((q) => q.className.includes('fail')).length, 1);
  assert.match(view.text, /Rejected proposals: 0\/5/);

  // Now stack up four rejections.
  for (let i = 0; i < 4; i++) {
    const leader = game.players[game.leaderIndex].id;
    g.proposeTeam(game, leader, game.players.slice(0, g.currentTeamSize(game)).map((p) => p.id));
    for (const p of game.players) g.castVote(game, p.id, false);
  }
  view = show(game, 'p0');
  assert.match(view.text, /One more rejection and evil wins/);
  assert.equal(view.byClass('pip').filter((p) => p.className.includes('on')).length, 4);
});

test('the assassin is asked to name Merlin and good players are not', () => {
  const game = newGame();
  for (let round = 0; round < 3; round++) {
    const leader = game.players[game.leaderIndex].id;
    const team = game.players.slice(0, g.currentTeamSize(game)).map((p) => p.id);
    g.proposeTeam(game, leader, team);
    for (const p of game.players) g.castVote(game, p.id, true);
    for (const id of team) g.playCard(game, id, true);
  }
  assert.equal(game.phase, 'assassin');

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
    const leader = game.players[game.leaderIndex].id;
    const team = game.players.slice(0, g.currentTeamSize(game)).map((p) => p.id);
    g.proposeTeam(game, leader, team);
    for (const p of game.players) g.castVote(game, p.id, true);
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
  for (const p of game.players) g.castVote(game, p.id, true);

  const en = show(game, 'p0');
  assert.match(en.text, /Ann proposed Ann, 张三/);
  assert.match(en.text, /Team approved \(5–0\)/);

  const zh = show(game, 'p0', 'zh');
  assert.match(zh.text, /Ann 提名了 Ann、张三/);
  assert.match(zh.text, /队伍通过（5–0）/);
  assertNoRawKeys(zh, 'Chinese history');
});
