// The game switcher, and every One Night Werewolf screen rendered from views
// the real engine produced.
import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from './dom-shim.js';
import * as w from '../src/games/onuw/game.js';
import { nightScript, stepMillis } from '../src/games/onuw/rules.js';

let clock = 1_700_000_000_000;
const now = () => clock;

const dom = installDom();
const onuwUi = await import('../public/games/onuw.js');
const client = await import('../public/app.js');
await client.ready;
const { app, render } = client;

function home({ lang = 'en' } = {}) {
  dom.location.hash = '';
  app.lang = lang; app.server = ''; app.serverStatus = 'ready'; app.code = null; app.view = null;
  dom.calls.length = 0;
  render();
  return dom.fixtures.view;
}

/** A dealt werewolf game, exactly as the deck says. */
function dealt(deck, names = ['Ann', '张三', 'Cai', 'Dee'], { ready = true } = {}) {
  const count = deck.length - 3;
  const game = w.createGame('WXYZ', { now });
  names.slice(0, count).forEach((name, i) => w.addPlayer(game, { id: `p${i}`, name }));
  w.startGame(game, 'p0', { shuffle: (l) => l, now });
  game.startRoles = Object.fromEntries(game.players.map((p, i) => [p.id, deck[i]]));
  game.centreStart = deck.slice(count);
  game.finalRoles = { ...game.startRoles };
  game.centre = game.centreStart.slice();
  game.script = nightScript(deck);
  game.info = {};
  game.swaps = [];
  game.actions = {};
  if (ready) for (const p of game.players) w.confirmRole(game, p.id, { now });
  return game;
}

/** Wind the shared clock forward to a named step. */
function stepTo(game, key) {
  for (let guard = 0; guard < 50; guard++) {
    if (w.currentStep(game)?.key === key) return;
    clock = game.stepEndsAt;
    w.tick(game, clock);
  }
  throw new Error(`never reached ${key}`);
}

function finishNight(game) {
  for (let guard = 0; guard < 50 && game.phase === 'night'; guard++) {
    clock = game.stepEndsAt;
    w.tick(game, clock);
  }
}

/** Draw what `playerId` sees right now. */
function show(game, playerId, lang = 'en') {
  app.lang = lang; app.server = ''; app.serverStatus = 'ready'; app.code = game.code; app.playerId = playerId;
  app.selection = []; app.centres = []; app.seerMode = 'player'; app.infoPopup = null;
  app.view = w.viewFor(game, playerId, clock);
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
  stepTo(game, 'seer');
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
  assert.equal(view.byClass('role-options').length, 1);
  assert.equal(view.byClass('role-option').length, 6);
  assert.ok(view.byClass('role-option').some((row) => row.className.includes('selected')),
    'selected roles have a visible row state');

  // Three players hold six cards: the five core ones leave room for one more.
  assert.throws(() => w.setOptions(game, 'p0', { minion: true, drunk: true }), { key: 'tooManyRoles' });
});

// ---------------------------------------------------------------- the night

test('players inspect their card and mark ready before the countdown appears', () => {
  const game = dealt(
    ['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner'],
    undefined,
    { ready: false },
  );
  let view = show(game, 'p0');

  assert.match(view.text, /Look at your card/);
  assert.equal(view.byId('nightClock'), null, 'the countdown has not started');
  assert.equal(labelled(view, /^Ready$/).length, 1);
  assert.equal(view.byClass('role-name').length, 0, 'the card starts hidden');

  view.byId('cardToggle').dispatch('click');
  assert.equal(dom.fixtures.view.byClass('role-name')[0].text, 'Seer');

  dom.calls.length = 0;
  labelled(dom.fixtures.view, /^Ready$/)[0].dispatch('click');
  assert.equal(dom.calls.find((c) => c.path.endsWith('/action')).body.type, 'confirm');

  w.confirmRole(game, 'p0', { now });
  view = show(game, 'p0');
  assert.match(view.text, /Ready\. Waiting for: 张三, Cai/);
  assert.equal(labelled(view, /^Ready$/).length, 0);
  assert.equal(view.byClass('tag').filter((tag) => tag.text === '◆').length, 1);

  w.confirmRole(game, 'p1', { now });
  w.confirmRole(game, 'p2', { now });
  view = show(game, 'p0');
  assert.match(view.text, /Everyone, close your eyes/);
  assert.match(view.byId('nightClock').text, /^\d+$/);
});

test('everyone sees the same announcement and the same countdown', () => {
  const game = dealt(['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner']);
  stepTo(game, 'seer');

  const screens = game.players.map((p) => show(game, p.id).text);
  for (const text of screens) {
    assert.match(text, /Seer, wake up/, 'the whole table hears the same call');
    assert.match(text, /Step 3 of 5/);
  }
  assert.match(dom.fixtures.view.byId('nightClock').text, /^\d+$/, 'a countdown is on screen');
});

test('the night screen never says who is awake or acting', () => {
  const game = dealt(['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner']);
  stepTo(game, 'seer');
  for (const p of game.players) {
    const view = show(game, p.id);
    assert.ok(!/Still acting|Waiting for|◆/.test(view.text), `${p.name}'s screen names someone`);
  }
});

test('a player whose step it is not gets no controls at all', () => {
  const game = dealt(['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner']);
  stepTo(game, 'seer');
  const bystander = show(game, 'p1');
  assert.match(bystander.text, /Eyes closed/);
  assert.equal(labelled(bystander, /^Confirm$/).length, 0);
  assert.equal(bystander.byClass('player').filter((n) => n.tagName === 'BUTTON').length, 0);
});

test('the night calls the deck\'s roles and no others', () => {
  // Three players; Mason, Drunk, Insomniac and Minion are not in this deck.
  const game = dealt(['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner']);
  const heard = [];
  for (let guard = 0; guard < 50 && game.phase === 'night'; guard++) {
    heard.push(show(game, 'p1').text);
    clock = game.stepEndsAt;
    w.tick(game, clock);
  }
  const all = heard.join('\n');
  for (const absent of [/Masons, wake up/, /Drunk, wake up/, /Insomniac, wake up/, /Minion, wake up/]) {
    assert.doesNotMatch(all, absent, 'the lobby already showed the deck; calling absent roles just wastes time');
  }
  // The Seer, Robber and Troublemaker cards are all in the centre here, and
  // are called anyway — that part really is secret.
  for (const called of [/Seer, wake up/, /Robber, wake up/, /Troublemaker, wake up/]) {
    assert.match(all, called);
  }
  assert.equal(heard.length, game.script.length);
});

test('the card starts hidden and opens in a dismissible popup', () => {
  const game = dealt(['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner']);
  stepTo(game, 'seer');
  const view = show(game, 'p0');

  const tools = view.byClass('info-buttons')[0];
  assert.deepEqual(buttons(tools).map((button) => button.text), ['Your card', 'Roles and night order']);
  assert.equal(view.byClass('role-name').length, 0, 'the dealt card is absent by default');

  view.byId('cardToggle').dispatch('click');
  const open = dom.fixtures.view;
  assert.equal(open.byClass('role-name')[0].text, 'Seer');
  assert.equal(app.infoPopup, 'onuw-card');

  open.byId('infoPopupBackdrop').dispatch('click');
  assert.equal(app.infoPopup, null);
  assert.equal(dom.fixtures.view.byClass('role-name').length, 0, 'clicking outside hides it again');
});

test('One Night Werewolf uses the shared host-only reset control', () => {
  const game = dealt(['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner']);
  assert.equal(show(game, 'p1').byId('resetGame'), null);

  const hostView = show(game, game.hostId);
  dom.calls.length = 0;
  dom.state.confirmResult = true;
  hostView.byId('resetGame').dispatch('click');
  const call = dom.calls.find((entry) => entry.path.endsWith('/action'));
  assert.equal(call.body.type, 'reset');
});

test('the reference popup lists the deck, the abilities and the order', () => {
  const game = dealt(['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner']);
  stepTo(game, 'seer');
  const view = show(game, 'p1');

  assert.match(view.text, /Roles and night order/);
  assert.ok(!/Night order/.test(view.text), 'collapsed by default');

  view.byId('refToggle').dispatch('click');
  const open = dom.fixtures.view;
  assert.match(open.text, /In this game \(6 cards\)/);
  assert.match(open.text, /Werewolf/);
  assert.match(open.text, /Swap your card with another player/, 'abilities are spelled out');
  assert.match(open.text, /Night order/);
  const order = open.byClass('order')[0].childNodes.map((li) => li.textContent);
  assert.deepEqual(order, ['Everyone closes their eyes', 'Werewolf', 'Seer', 'Robber', 'Troublemaker']);
  assert.equal(order.filter((_, i) => open.byClass('order')[0].childNodes[i].className === 'now').length, 1);

  open.byId('infoPopupBackdrop').dispatch('click');
  assert.ok(!/Night order/.test(dom.fixtures.view.text), 'and closes from the backdrop');
});

test('a paired werewolf is awake and sees their partner', () => {
  const game = dealt(['werewolf', 'werewolf', 'villager', 'seer', 'robber', 'troublemaker']);
  stepTo(game, 'werewolf');
  const view = show(game, 'p0');

  assert.match(view.text, /Your turn/, 'a paired wolf is not told they are asleep');
  assert.match(view.text, /Your fellow werewolf: 张三/, 'and sees who that is, during their own step');
  assert.equal(labelled(view, /^Confirm$/).length, 0, 'a pair has no centre card to look at');
});

test('a lone werewolf may look at one centre card, or decline', () => {
  const game = dealt(['werewolf', 'villager', 'seer', 'werewolf', 'robber', 'troublemaker']);
  stepTo(game, 'werewolf');
  const view = show(game, 'p0');
  assert.match(view.text, /You are the only werewolf/);
  assert.equal(view.byClass('role-name').length, 0, 'the role stays hidden until asked for');
  view.byId('cardToggle').dispatch('click');
  assert.equal(dom.fixtures.view.byClass('role-name')[0].text, 'Werewolf');
  dom.fixtures.view.byId('infoPopupBackdrop').dispatch('click');

  const cards = dom.fixtures.view.byClass('centre-card');
  assert.equal(cards.length, 3);
  assert.ok(cards.every((c) => c.className.includes('card-back')), 'the centre uses illustrated card backs');
  assert.ok(cards.every((c) => !c.text.includes('?')), 'the card art replaces the question marks');

  assert.equal(labelled(view, /^Confirm$/)[0].disabled, true);
  cards[1].dispatch('click');
  assert.deepEqual(app.centres, [1]);
  assert.equal(labelled(dom.fixtures.view, /^Confirm$/)[0].disabled, false);

  dom.calls.length = 0;
  labelled(dom.fixtures.view, /Do nothing/)[0].dispatch('click');
  assert.equal(dom.calls.find((c) => c.path.endsWith('/action')).body.action.skip, true);
});

test('a lone werewolf sees the inspected centre card as a card front', () => {
  const game = dealt(['werewolf', 'villager', 'seer', 'werewolf', 'robber', 'troublemaker']);
  stepTo(game, 'werewolf');
  w.submitNight(game, 'p0', { centre: 1 });

  const view = show(game, 'p0');
  assert.equal(view.byClass('role-card-front').length, 1);
  assert.equal(view.byClass('role-card-name')[0].text, 'Robber');
  assert.match(view.text, /Centre card 2 was Robber/);
});

test('the seer chooses between one player and two centre cards', () => {
  const game = dealt(['seer', 'werewolf', 'villager', 'robber', 'troublemaker', 'tanner']);
  stepTo(game, 'seer');
  let view = show(game, 'p0');
  assert.equal(labelled(view, /One player/).length, 1);
  assert.equal(labelled(view, /Two centre cards/).length, 1);

  const rows = view.byClass('player').filter((n) => n.tagName === 'BUTTON');
  assert.equal(rows.find((r) => r.text.includes('Ann')).disabled, true);
  rows.find((r) => r.text.includes('张三')).dispatch('click');
  dom.calls.length = 0;
  labelled(dom.fixtures.view, /^Confirm$/)[0].dispatch('click');
  assert.deepEqual(dom.calls.find((c) => c.path.endsWith('/action')).body.action,
    { mode: 'player', target: 'p1' });

  view = show(game, 'p0');
  labelled(view, /Two centre cards/)[0].dispatch('click');
  const cards = dom.fixtures.view.byClass('centre-card');
  cards[0].dispatch('click');
  cards[1].dispatch('click');
  cards[2].dispatch('click');
  assert.deepEqual(app.centres, [0, 1], 'the third click is ignored');
  assert.match(dom.fixtures.view.text, /Selected 2\/2/);
});

test('the seer sees inspected roles as card fronts', () => {
  const playerGame = dealt(['seer', 'werewolf', 'villager', 'robber', 'troublemaker', 'tanner']);
  stepTo(playerGame, 'seer');
  w.submitNight(playerGame, 'p0', { mode: 'player', target: 'p1' });
  let view = show(playerGame, 'p0');
  assert.equal(view.byClass('role-card-front').length, 1);
  assert.equal(view.byClass('role-card-name')[0].text, 'Werewolf');

  const centreGame = dealt(['seer', 'werewolf', 'villager', 'robber', 'troublemaker', 'tanner']);
  stepTo(centreGame, 'seer');
  w.submitNight(centreGame, 'p0', { mode: 'centre', centres: [0, 2] });
  view = show(centreGame, 'p0');
  assert.equal(view.byClass('role-card-front').length, 2);
  assert.deepEqual(view.byClass('role-card-name').map((n) => n.text), ['Robber', 'Tanner']);
});

test('the troublemaker must pick two players, neither of them themselves', () => {
  const game = dealt(['troublemaker', 'werewolf', 'villager', 'seer', 'robber', 'tanner']);
  stepTo(game, 'troublemaker');
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
  stepTo(game, 'drunk');
  const view = show(game, 'p0');
  assert.match(view.text, /You will not see it/);
  assert.equal(labelled(view, /Do nothing/).length, 0, 'the Drunk must swap');
  assert.ok(view.byClass('centre-card').every((c) => c.className.includes('card-back')),
    'the Drunk only sees card backs');
});

test('the language toggle leaves the active night recording alone', () => {
  const game = dealt(['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner']);
  stepTo(game, 'seer');
  app.muted = false;
  show(game, 'p0', 'zh');
  onuwUi.onView();
  const chinese = dom.AudioStub.instances.at(-1);
  assert.match(chinese.src, /audio\/onuw\/zh\/wake-seer\.mp3$/);

  dom.fixtures.langToggle.dispatch('click');
  assert.equal(chinese.paused, false);
  assert.match(chinese.src, /audio\/onuw\/zh\/wake-seer\.mp3$/);

  app.view = { ...app.view, night: null };
  onuwUi.onView();
});

test('a redraw paints the time actually left, not the step\'s full length', () => {
  // Tapping mute redraws the pane. It used to reinstate the countdown from the
  // last server frame, so the clock jumped back to full for a moment.
  const game = dealt(['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner']);
  stepTo(game, 'seer');

  const realNow = Date.now;
  let fake = 5_000_000;
  Date.now = () => fake;
  try {
    show(game, 'p0');
    onuwUi.onView();                       // the frame that anchors the clock
    const full = Math.ceil(app.view.night.msLeft / 1000);
    assert.ok(full >= 10, 'the seer gets a decent while');

    fake += 9000;                          // nine seconds go by
    dom.fixtures.view.byId('voiceToggle').dispatch('click');   // redraw

    const shown = Number(dom.fixtures.view.byId('nightClock').text);
    assert.ok(shown <= full - 8, `the clock jumped back to ${shown} of ${full}`);
    const bar = dom.fixtures.view.byId('nightBar').getAttribute('style');
    assert.doesNotMatch(bar, /width:100%/, 'the bar refilled too');

    app.muted = false;
  } finally {
    Date.now = realNow;
    app.view = { ...app.view, night: null };
    onuwUi.onView();                       // stop the interval
  }
});

test('a frame painted before the clock is anchored still shows the time', () => {
  // Happens on the first paint after a reconnect: render runs with no local
  // anchor for this step, and used to show zero.
  const game = dealt(['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner']);
  stepTo(game, 'seer');
  app.stepEndsAt = 0;
  app.clockStep = null;

  const view = show(game, 'p0');
  const shown = Number(view.byId('nightClock').text);
  assert.ok(shown > 1, `the clock showed ${shown}`);
  assert.equal(shown, Math.ceil(app.view.night.msLeft / 1000));
});

test('the voice can be muted, and the choice sticks', () => {
  const game = dealt(['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner']);
  stepTo(game, 'seer');
  const view = show(game, 'p0');
  const toggle = view.byId('voiceToggle');
  assert.match(toggle.text, /🔊/);
  toggle.dispatch('click');
  assert.equal(app.muted, true);
  assert.equal(dom.localStorage.getItem('avalon.muted'), '1');
  assert.match(dom.fixtures.view.byId('voiceToggle').text, /✕/);
  dom.fixtures.view.byId('voiceToggle').dispatch('click');
  assert.equal(app.muted, false);
});

test('the lobby lets the host set the night pace', () => {
  const game = w.createGame('WXYZ', { now });
  ['Ann', '张三', 'Cai'].forEach((name, i) => w.addPlayer(game, { id: `p${i}`, name }));
  const view = show(game, 'p0');
  assert.match(view.text, /Night pace/);
  assert.match(view.text, /The night takes about \d+ seconds/);
  assert.match(view.byId('pace-normal').className, /primary/);

  dom.calls.length = 0;
  view.byId('pace-brisk').dispatch('click');
  assert.equal(dom.calls.find((c) => c.path.endsWith('/action')).body.options.pace, 'brisk');
});

// ---------------------------------------------------------------- day, vote, end

test('the morning tells each player only what they learned', () => {
  const game = dealt(['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner']);
  stepTo(game, 'seer');
  w.submitNight(game, 'p0', { mode: 'player', target: 'p1' });
  stepTo(game, 'robber');
  w.submitNight(game, 'p2', { target: 'p1' });
  finishNight(game);

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
  stepTo(game, 'seer');
  w.submitNight(game, 'p0', { mode: 'player', target: 'p1' });
  stepTo(game, 'robber');
  w.submitNight(game, 'p2', { target: 'p1' });
  finishNight(game);
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
  stepTo(game, 'seer');
  w.submitNight(game, 'p0', { mode: 'player', target: 'p1' });
  stepTo(game, 'robber');
  w.submitNight(game, 'p2', { target: 'p1' });
  finishNight(game);
  w.startVote(game, 'p0');
  for (const [voter, target] of [['p0', 'p2'], ['p1', 'p2'], ['p2', 'p0']]) w.castVote(game, voter, target);

  const view = show(game, 'p0');
  assert.match(view.text, /You won\./);
  assert.match(view.text, /Village win/);
  assert.match(view.text, /Killed: Cai/);
  assert.match(view.text, /Cai robbed 张三/, 'the night is reconstructed');
  // The seat reads as symbols; the sentence stays on as the accessible name.
  const cai = view.byClass('player').find((row) => row.byClass('name')[0]?.text === 'Cai');
  const card = cai.byClass('tag')[0];
  assert.match(card.text, /Robber\s*→\s*Werewolf/, 'the card that arrived, and the one that stayed');
  assert.equal(card.getAttribute('aria-label'), 'dealt Robber → ended Werewolf');
  assert.match(cai.byClass('tag')[1].text, /☞\s*Ann/, 'and who they pointed at');
  // The centre is finally face up.
  assert.ok(view.byClass('centre-card').every((c) => !c.text.includes('?')));
  assertNoRawKeys(view, 'end screen');

  const loser = show(game, 'p2');
  assert.match(loser.text, /You lost\./);
});

test('the end screen keeps each seat\u2019s tags inside the seat\u2019s box', () => {
  // A recap row carries several wordy tags. They ride in one wrapping strip, so
  // a narrow screen breaks them under the name instead of pushing the row —
  // and with it the page — wider than the viewport.
  const game = dealt(['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner']);
  finishNight(game);
  w.startVote(game, 'p0');
  for (const [voter, target] of [['p0', 'p2'], ['p1', 'p2'], ['p2', 'p0']]) w.castVote(game, voter, target);

  const view = show(game, 'p0');
  const rows = view.byClass('player');
  assert.equal(rows.length, game.players.length);
  for (const row of rows) {
    const strips = row.byClass('player-tags');
    assert.equal(strips.length, 1, 'one strip per seat');
    assert.equal(row.byClass('tag').length, strips[0].byClass('tag').length,
      'every tag sits inside it');
  }
});

test('the whole werewolf game reads in Chinese', () => {
  const game = dealt(['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner']);
  stepTo(game, 'seer');
  const night = show(game, 'p0', 'zh');
  assert.match(night.text, /预言家请睁眼/, 'the announcement is spoken in the reader\u2019s language');
  assert.match(night.text, /查看一名玩家/);
  assertNoRawKeys(night, 'Chinese night');

  stepTo(game, 'seer');
  w.submitNight(game, 'p0', { mode: 'player', target: 'p1' });
  stepTo(game, 'robber');
  w.submitNight(game, 'p2', { target: 'p1' });
  finishNight(game);
  const day = show(game, 'p0', 'zh');
  assert.match(day.text, /张三 的牌是狼人。/);
  assertNoRawKeys(day, 'Chinese day');
});

test('each night step starts the middle pane at the top again', () => {
  // The night never changes phase or round, so without a per-step key the
  // pane would carry one step's scroll offset into the next.
  const game = dealt(['seer', 'werewolf', 'robber', 'villager', 'troublemaker', 'tanner']);
  const view = show(game, 'p1');
  assert.equal(game.phase, 'night');

  view.byClass('phase-area')[0].scrollTo_(140);
  show(game, 'p1');
  assert.equal(view.byClass('phase-area')[0].scrollTop, 140, 'a redraw within a step holds its place');

  clock = game.stepEndsAt;
  w.tick(game, clock);
  show(game, 'p1');
  assert.equal(view.byClass('phase-area')[0].scrollTop, 0, 'a new step is new content');
});
