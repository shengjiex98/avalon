import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from './dom-shim.js';

const dom = installDom();
const onuw = await import('../public/games/onuw.js');

const app = {
  lang: 'zh', muted: false, clockStep: null, stepEndsAt: 0,
  view: {
    night: { index: 0, key: 'werewolf', msLeft: 10_000, msTotal: 10_000 },
    nightScript: ['werewolf', 'seer'],
  },
};

onuw.bind({ app, T: (key) => key, send() {}, joinNames() {}, render() {} });

test('night calls use queued, language-specific recordings', () => {
  onuw.onView();
  const audio = dom.AudioStub.instances.at(-1);
  assert.match(audio.src, /audio\/onuw\/zh\/wake-werewolf\.mp3$/);

  app.view.night = { index: 1, key: 'seer', msLeft: 10_000, msTotal: 10_000 };
  onuw.onView();
  assert.match(audio.src, /audio\/onuw\/zh\/sleep-werewolf\.mp3$/);

  audio.finish();
  assert.match(audio.src, /audio\/onuw\/zh\/wake-seer\.mp3$/);

  app.view.night = null;
  onuw.onView();
  assert.equal(audio.paused, true);
});

test('muting cancels an in-progress recording', () => {
  app.view.night = { index: 0, key: 'werewolf', msLeft: 10_000, msTotal: 10_000 };
  app.muted = false;
  onuw.onView();
  const audio = dom.AudioStub.instances.at(-1);
  assert.equal(audio.paused, false);

  app.muted = true;
  app.view.night = { index: 1, key: 'seer', msLeft: 10_000, msTotal: 10_000 };
  onuw.onView();
  assert.equal(audio.paused, true);
  assert.equal(audio.src, '');

  app.view.night = null;
  onuw.onView();
});

test('switching languages discards old audio and restarts only the current call', () => {
  app.lang = 'zh';
  app.muted = false;
  app.view.night = { index: 1, key: 'seer', msLeft: 10_000, msTotal: 10_000 };
  onuw.onView();
  const chinese = dom.AudioStub.instances.at(-1);
  assert.match(chinese.src, /audio\/onuw\/zh\/wake-seer\.mp3$/);

  app.lang = 'en';
  onuw.onLanguageChange();
  const english = dom.AudioStub.instances.at(-1);
  assert.notEqual(english, chinese, 'late events from the old source are isolated');
  assert.equal(chinese.paused, true);
  assert.equal(chinese.src, '');
  assert.match(english.src, /audio\/onuw\/en\/wake-seer\.mp3$/);
  assert.doesNotMatch(english.src, /sleep-werewolf/, 'the current step is not replayed as a transition');

  chinese.finish();
  assert.match(english.src, /audio\/onuw\/en\/wake-seer\.mp3$/, 'an old completion cannot advance the new queue');

  app.view.night = null;
  onuw.onView();
  assert.equal(english.paused, true);
  assert.equal(english.src, '');
  english.finish();
  assert.equal(english.src, '', 'a late completion cannot restart audio after night');
});
