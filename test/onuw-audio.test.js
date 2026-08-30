import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from './dom-shim.js';

const dom = installDom();
const onuw = await import('../src/client/games/onuw.ts');

const app = {
  lang: 'zh', muted: false, clockStep: null, stepEndsAt: 0,
  view: {
    code: 'WXYZ', gameId: 'onuw', phase: 'night', version: 1, hostId: 'p0',
    me: { id: 'p0', name: 'Ann', avatar: null },
    you: {
      id: 'p0', name: 'Ann', avatar: null, role: 'werewolf', team: 'werewolf',
      awake: true, action: 'loneWolf', acted: false,
    },
    players: [{ id: 'p0', name: 'Ann', avatar: null, seat: 0 }],
    log: [],
    setup: { minPlayers: 3, maxPlayers: 10, options: [], houseRules: [], paces: [] },
    houseRules: {}, deck: {}, centreCount: 3, info: [],
    night: { index: 0, total: 2, key: 'werewolf', msLeft: 10_000, msTotal: 10_000 },
    nightScript: ['werewolf', 'seer'],
  },
};

const renderer = onuw.createRenderer({ app, T: (key) => key, send() {}, joinNames() {}, render() {} });

test('the game module exposes constructed renderers, not mutable bindings', () => {
  assert.equal(onuw.bind, undefined);
  assert.equal(typeof renderer.onView, 'function');
});

test('night calls and dawn use queued, language-specific recordings', () => {
  renderer.onView();
  const audio = dom.AudioStub.instances.at(-1);
  assert.match(audio.src, /audio\/onuw\/zh\/wake-werewolf\.mp3$/);

  app.view.night = { index: 1, total: 2, key: 'seer', msLeft: 10_000, msTotal: 10_000 };
  renderer.onView();
  assert.match(audio.src, /audio\/onuw\/zh\/sleep-werewolf\.mp3$/);

  audio.finish();
  assert.match(audio.src, /audio\/onuw\/zh\/wake-seer\.mp3$/);

  app.view.night = { index: 2, total: 3, key: 'dawn', msLeft: 8_000, msTotal: 8_000 };
  app.view.nightScript = ['werewolf', 'seer', 'dawn'];
  renderer.onView();
  assert.match(audio.src, /audio\/onuw\/zh\/sleep-seer\.mp3$/);

  audio.finish();
  assert.match(audio.src, /audio\/onuw\/zh\/wake-dawn\.mp3$/);

  app.view.night = null;
  renderer.onView();
  assert.equal(audio.paused, true);
});

test('muting cancels an in-progress recording', () => {
  app.view.night = { index: 0, total: 2, key: 'werewolf', msLeft: 10_000, msTotal: 10_000 };
  app.muted = false;
  renderer.onView();
  const audio = dom.AudioStub.instances.at(-1);
  assert.equal(audio.paused, false);

  app.muted = true;
  app.view.night = { index: 1, total: 2, key: 'seer', msLeft: 10_000, msTotal: 10_000 };
  renderer.onView();
  assert.equal(audio.paused, true);
  assert.equal(audio.src, '');

  app.view.night = null;
  renderer.onView();
});

test('switching languages leaves the current call alone and applies next step', () => {
  app.lang = 'zh';
  app.muted = false;
  app.view.night = { index: 0, total: 2, key: 'werewolf', msLeft: 10_000, msTotal: 10_000 };
  renderer.onView();
  const audio = dom.AudioStub.instances.at(-1);
  assert.match(audio.src, /audio\/onuw\/zh\/wake-werewolf\.mp3$/);

  app.lang = 'en';
  assert.equal(audio.paused, false);
  assert.match(audio.src, /audio\/onuw\/zh\/wake-werewolf\.mp3$/);

  app.view.night = { index: 1, total: 2, key: 'seer', msLeft: 10_000, msTotal: 10_000 };
  renderer.onView();
  assert.match(audio.src, /audio\/onuw\/en\/sleep-werewolf\.mp3$/);
  audio.finish();
  assert.match(audio.src, /audio\/onuw\/en\/wake-seer\.mp3$/);

  app.view.night = null;
  renderer.onView();
  assert.equal(audio.paused, true);
});

test('disposing the renderer stops its owned audio and clock', () => {
  app.lang = 'en';
  app.muted = false;
  app.view.night = { index: 0, total: 2, key: 'werewolf', msLeft: 10_000, msTotal: 10_000 };
  renderer.onView();
  const audio = dom.AudioStub.instances.at(-1);
  assert.equal(audio.paused, false);
  renderer.dispose();
  assert.equal(audio.paused, true);
  assert.equal(audio.src, '');
});
