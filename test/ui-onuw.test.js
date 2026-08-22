// The game switcher, and every One Night Werewolf screen rendered from views
// the real engine produced.
import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from './dom-shim.js';
import * as w from '../src/games/onuw/game.js';

const dom = installDom();
const client = await import('../public/app.js');
await client.ready;
const { app, render } = client;

function home({ lang = 'en' } = {}) {
  dom.location.hash = '';
  app.lang = lang; app.code = null; app.view = null; app.serverOk = true;
  dom.calls.length = 0;
  render();
  return dom.fixtures.view;
}

/** A dealt werewolf game, exactly as the deck says. */
function dealt(deck, names = ['Ann', '张三', 'Cai', 'Dee']) {
  const count = deck.length - 3;
  const game = w.createGame('WXYZ');
  names.slice(0, count).forEach((name, i) => w.addPlayer(game, { id: `p${i}`, name }));
  game.phase = 'night';
  game.startRoles = Object.fromEntries(game.players.map((p, i) => [p.id, deck[i]]));
  game.centreStart = deck.slice(count);
  return game;
}

function settle(game) {
  for (const p of game.players) {
    if (p.id in game.actions) continue;
    if (w.actionFor(game, p.id)) w.submitNight(game, p.id, { skip: true });
  }
}

/** Draw what `playerId` sees right now. */
function show(game, playerId, lang = 'en') {
  app.lang = lang; app.code = game.code; app.playerId = playerId; app.serverOk = true;
  app.selection = []; app.centres = []; app.seerMode = 'player'; app.showRole = true;
  app.view = w.viewFor(game, playerId);
  render();
  return dom.fixtures.view;
}

const buttons = (n) => n.findAll((x) => x.tagName === 'BUTTON');
const labelled = (n, re) => buttons(n).filter((b) => re.test(b.text));
const roleId = (game, role) => game.players.find((p) => game.startRoles[p.id] === role).id;

const KEY_RE = /\b(onuw|log|err|game|lobby|over|reveal)\.[a-zA-Z]\w*/g;
const assertNoRawKeys = (view, where) =>
  assert.deepEqual(view.text.match(KEY_RE) ?? [], [], `untranslated key in ${where}`);

// ---------------------------------------------------------------- switcher

test('the top bar offers both games, with one of them active', () => {
  home();
  const seg = dom.fixtures.gameSwitch;
  assert.deepEqual(buttons(seg).map((b) => b.text), ['Avalon', 'One Night Werewolf']);
  assert.match(seg.byId('game-avalon').className, /\bon\b/);
  assert.doesNotMatch(seg.byId('game-onuw').className, /\bon\b/);
});

test('the switcher is in Chinese too', () => {
  home({ lang: 'zh' });
  assert.deepEqual(buttons(dom.fixtures.gameSwitch).map((b) => b.text), ['阿瓦隆', '一夜狼人']);
});

test('switching on the home screen changes what Create would make', async () => {
  home();
  dom.fixtures.gameSwitch.byId('game-onuw').dispatch('click');

  assert.equal(app.gameId, 'onuw');
  assert.equal(dom.localStorage.getItem('avalon.game'), 'onuw', 'the choice is remembered');
  assert.match(dom.fixtures.gameSwitch.byId('game-onuw').className, /\bon\b/);
  assert.match(dom.fixtures.view.text, /One night, one werewolf hunt/, 'the blurb follows the game');

  dom.state.responses.set('/api/rooms', { code: 'NEW1' });
  dom.fixtures.view.byId('nameInput').value = 'Ann';
  dom.fixtures.view.byId('createBtn').dispatch('click');
  await new Promise((r) => setTimeout(r, 0));

  const created = dom.calls.find((c) => c.path === '/api/rooms' && c.method === 'POST');
  assert.equal(created.body.game, 'onuw', 'the room is created for the chosen game');

  dom.fixtures.gameSwitch.byId('game-avalon').dispatch('click');   // put it back
});

test('in a lobby the host switches the room, and nobody else can', () => {
  const game = w.createGame('WXYZ');
  ['Ann', '张三', 'Cai'].forEach((name, i) => w.addPlayer(game, { id: `p${i}`, name }));

  show(game, 'p0');   // the host
  assert.equal(dom.fixtures.gameSwitch.byId('game-avalon').disabled, false);
  dom.calls.length = 0;
  dom.fixtures.gameSwitch.byId('game-avalon').dispatch('click');
  const sent = dom.calls.find((c) => c.path.endsWith('/action'));
  assert.equal(sent.body.type, 'setGame');
  assert.equal(sent.body.game, 'avalon');

  show(game, 'p1');   // not the host
  assert.equal(dom.fixtures.gameSwitch.byId('game-avalon').disabled, true);
  assert.equal(dom.fixtures.gameSwitch.byId('game-onuw').disabled, false, 'the active game stays readable');
});

test('a running game cannot be switched out from under the table', () => {
  const game = dealt(['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner']);
  show(game, 'p0');
  assert.equal(dom.fixtures.gameSwitch.byId('game-avalon').disabled, true);
});

// ---------------------------------------------------------------- lobby

test('the werewolf lobby shows the deck it is about to shuffle', () => {
  const game = w.createGame('WXYZ');
  ['Ann', '张三', 'Cai'].forEach((name, i) => w.addPlayer(game, { id: `p${i}`, name }));
  const view = show(game, 'p0');

  assert.match(view.text, /Cards in play/);
  assert.match(view.text, /Werewolf ×2/, 'the deck is spelled out, not just counted');
  assert.match(view.text, /three more cards than players/);
  assert.ok(labelled(view, /Start game/).length, 'three players is enough for this game');
});

test('the lobby refuses a deck that does not fit and says so', () => {
  const game = w.createGame('WXYZ');
  ['Ann', '张三', 'Cai'].forEach((name, i) => w.addPlayer(game, { id: `p${i}`, name }));
  const view = show(game, 'p0');
  assert.match(view.text, /1 optional cards fit/);

  // Three players hold six cards: the five core ones leave room for one more.
  assert.throws(() => w.setOptions(game, 'p0', { minion: true, drunk: true }), { key: 'tooManyRoles' });
});

// ---------------------------------------------------------------- the night

test('a villager is told to go back to sleep', () => {
  const game = dealt(['villager', 'werewolf', 'werewolf', 'seer', 'robber', 'troublemaker']);
  const view = show(game, 'p0');
  assert.match(view.text, /Villager/);
  assert.match(view.text, /You sleep through the night/);
  assert.equal(labelled(view, /Confirm/).length, 0);
  assertNoRawKeys(view, 'villager night');
});

test('the werewolves see each other without being offered a peek', () => {
  const game = dealt(['werewolf', 'werewolf', 'villager', 'seer', 'robber', 'troublemaker']);
  const view = show(game, 'p0');
  assert.match(view.text, /Your fellow werewolf: 张三/);
  assert.equal(labelled(view, /Confirm/).length, 0, 'a pair has nothing to decide');
});

test('a lone werewolf may look at one centre card, or decline', () => {
  const game = dealt(['werewolf', 'villager', 'seer', 'werewolf', 'robber', 'troublemaker']);
  const view = show(game, 'p0');
  assert.match(view.text, /You are the only werewolf/);

  const cards = view.byClass('centre-card');
  assert.equal(cards.length, 3);
  assert.ok(cards.every((c) => c.text.includes('?')), 'the centre stays face down');

  const confirm = labelled(view, /^Confirm$/)[0];
  assert.equal(confirm.disabled, true);
  cards[1].dispatch('click');
  assert.deepEqual(app.centres, [1]);
  assert.equal(labelled(dom.fixtures.view, /^Confirm$/)[0].disabled, false);

  dom.calls.length = 0;
  labelled(dom.fixtures.view, /Do nothing/)[0].dispatch('click');
  assert.equal(dom.calls.find((c) => c.path.endsWith('/action')).body.action.skip, true);
});

test('the seer chooses between one player and two centre cards', () => {
  const game = dealt(['seer', 'werewolf', 'villager', 'robber', 'troublemaker', 'tanner']);
  let view = show(game, 'p0');
  assert.equal(labelled(view, /One player/).length, 1);
  assert.equal(labelled(view, /Two centre cards/).length, 1);

  // Player mode: the seer cannot pick themselves.
  const rows = view.byClass('player').filter((n) => n.tagName === 'BUTTON');
  assert.equal(rows.find((r) => r.text.includes('Ann')).disabled, true);
  rows.find((r) => r.text.includes('张三')).dispatch('click');
  dom.calls.length = 0;
  labelled(dom.fixtures.view, /^Confirm$/)[0].dispatch('click');
  assert.deepEqual(dom.calls.find((c) => c.path.endsWith('/action')).body.action,
    { mode: 'player', target: 'p1' });

  // Centre mode: exactly two, no more.
  view = show(game, 'p0');
  labelled(view, /Two centre cards/)[0].dispatch('click');
  const cards = dom.fixtures.view.byClass('centre-card');
  cards[0].dispatch('click');
  cards[1].dispatch('click');
  cards[2].dispatch('click');
  assert.deepEqual(app.centres, [0, 1], 'the third click is ignored');
  assert.match(dom.fixtures.view.text, /Selected 2\/2/);
});

test('the troublemaker must pick two players, neither of them themselves', () => {
  const game = dealt(['troublemaker', 'werewolf', 'villager', 'seer', 'robber', 'tanner']);
  const view = show(game, 'p0');
  const rows = view.byClass('player').filter((n) => n.tagName === 'BUTTON');
  assert.equal(rows.find((r) => r.text.includes('Ann')).disabled, true);

  assert.equal(labelled(view, /^Confirm$/)[0].disabled, true);
  rows[1].dispatch('click');
  assert.equal(labelled(dom.fixtures.view, /^Confirm$/)[0].disabled, true, 'one is not enough');
  dom.fixtures.view.byClass('player').filter((n) => n.tagName === 'BUTTON')[2].dispatch('click');
  assert.equal(labelled(dom.fixtures.view, /^Confirm$/)[0].disabled, false);
});

test('the drunk is not offered a way out', () => {
  const game = dealt(['drunk', 'werewolf', 'villager', 'seer', 'robber', 'tanner']);
  const view = show(game, 'p0');
  assert.match(view.text, /You will not see it/);
  assert.equal(labelled(view, /Do nothing/).length, 0, 'the Drunk must swap');
});

// ---------------------------------------------------------------- day, vote, end

test('the morning tells each player only what they learned', () => {
  const game = dealt(['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner']);
  w.submitNight(game, 'p0', { mode: 'player', target: 'p1' });
  w.submitNight(game, 'p2', { target: 'p1' });
  settle(game);

  const seer = show(game, 'p0');
  assert.match(seer.text, /张三 had Werewolf/);
  assert.match(seer.text, /Start the vote/, 'the host opens the vote when talking is done');
  assertNoRawKeys(seer, 'day, seer');

  const robber = show(game, 'p2');
  assert.match(robber.text, /You robbed 张三 and are now Werewolf/);
  assert.ok(!/张三 had Werewolf/.test(robber.text), "the robber does not see the seer's reading");
  assert.equal(labelled(robber, /Start the vote/).length, 0, 'only the host starts it');
});

test('voting points at one player and never at yourself', () => {
  const game = dealt(['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner']);
  w.submitNight(game, 'p0', { mode: 'player', target: 'p1' });
  w.submitNight(game, 'p2', { target: 'p1' });
  settle(game);
  w.startVote(game, 'p0');

  const view = show(game, 'p0');
  assert.match(view.text, /Point at one player/);
  const rows = view.byClass('player').filter((n) => n.tagName === 'BUTTON');
  assert.equal(rows.find((r) => r.text.includes('Ann')).disabled, true);

  rows.find((r) => r.text.includes('Cai')).dispatch('click');
  dom.calls.length = 0;
  labelled(dom.fixtures.view, /^Confirm$/)[0].dispatch('click');
  assert.equal(dom.calls.find((c) => c.path.endsWith('/action')).body.target, 'p2');
});

test('the end screen explains the night and the verdict', () => {
  const game = dealt(['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner']);
  w.submitNight(game, 'p0', { mode: 'player', target: 'p1' });
  w.submitNight(game, 'p2', { target: 'p1' });
  settle(game);
  w.startVote(game, 'p0');
  for (const [voter, target] of [['p0', 'p2'], ['p1', 'p2'], ['p2', 'p0']]) w.castVote(game, voter, target);

  const view = show(game, 'p0');
  assert.match(view.text, /You won\./);
  assert.match(view.text, /Village win/);
  assert.match(view.text, /Killed: Cai/);
  assert.match(view.text, /Cai robbed 张三/, 'the night is reconstructed');
  assert.match(view.text, /dealt Robber/);
  assert.match(view.text, /ended Werewolf/);
  // The centre is finally face up.
  assert.ok(view.byClass('centre-card').every((c) => !c.text.includes('?')));
  assertNoRawKeys(view, 'end screen');

  const loser = show(game, 'p2');
  assert.match(loser.text, /You lost\./);
});

test('the whole werewolf game reads in Chinese', () => {
  const game = dealt(['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner']);
  const night = show(game, 'p0', 'zh');
  assert.match(night.text, /预言家/);
  assert.match(night.text, /查看一名玩家/);
  assertNoRawKeys(night, 'Chinese night');

  w.submitNight(game, 'p0', { mode: 'player', target: 'p1' });
  w.submitNight(game, 'p2', { target: 'p1' });
  settle(game);
  const day = show(game, 'p0', 'zh');
  assert.match(day.text, /张三 的牌是狼人。/);
  assertNoRawKeys(day, 'Chinese day');
});
