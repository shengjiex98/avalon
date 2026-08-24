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
