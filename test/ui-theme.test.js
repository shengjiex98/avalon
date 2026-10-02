import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import { createThemeController } from '../src/client/theme.ts';
import { createStore } from '../src/client/storage.ts';
import { installDom } from './dom-shim.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const theme = (dom) => dom.document.documentElement.getAttribute('data-theme');

test('theme synchronization preserves live DOM and skips hidden tabs', async (t) => {
  const dom = installDom();
  const callbacks = [];
  t.mock.method(globalThis, 'setInterval', (callback, delay) => {
    callbacks.push({ callback, delay });
    return { unref() {} };
  });
  let selected = 'classic';
  let requests = 0;
  const controller = createThemeController({
    app: { server: '' }, store: createStore(dom.localStorage),
    load: async () => { requests += 1; return { theme: selected }; },
  });
  const input = dom.document.createElement('input');
  input.value = 'A name still being typed';
  dom.fixtures.view.append(input);
  controller.start();
  controller.start();
  await tick();
  assert.equal(theme(dom), 'classic');
  assert.equal(dom.fixtures.themeColor.getAttribute('content'), '#12141c');
  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0].delay, 30_000);
  selected = 'crystal';
  callbacks[0].callback();
  await tick();
  assert.equal(theme(dom), 'crystal');
  assert.equal(dom.fixtures.themeColor.getAttribute('content'), '#080d1c');
  assert.equal(dom.fixtures.view.childNodes[0], input);
  assert.equal(input.value, 'A name still being typed');
  dom.document.visibilityState = 'hidden';
  const before = requests;
  callbacks[0].callback();
  dom.fire('focus');
  await tick();
  assert.equal(requests, before);
  dom.document.visibilityState = 'visible';
  selected = 'classic';
  dom.fire('visibilitychange');
  await tick();
  assert.equal(theme(dom), 'classic');
});

test('a failed or invalid settings response keeps the last server-confirmed appearance', async () => {
  const dom = installDom();
  const store = createStore(dom.localStorage);
  store.setTheme(dom.location.origin, 'classic');
  let result = { theme: 'unknown' };
  const controller = createThemeController({
    app: { server: '' }, store,
    load: async () => { if (!result) throw new Error('unavailable'); return result; },
  });
  await controller.refresh();
  assert.equal(theme(dom), 'classic');
  result = null;
  await controller.refresh();
  assert.equal(theme(dom), 'classic');
  assert.equal(store.themeFor(dom.location.origin), 'classic');
});

test('server changes invalidate cached appearance and discard delayed responses', async () => {
  const dom = installDom();
  const app = { server: 'https://one.example' };
  const store = createStore(dom.localStorage);
  store.setTheme(app.server, 'classic');
  let resolveOld;
  let requests = 0;
  const controller = createThemeController({
    app, store,
    load: () => {
      requests += 1;
      return requests === 1 ? new Promise((resolve) => { resolveOld = resolve; })
        : Promise.resolve({ theme: 'crystal' });
    },
  });
  const old = controller.refresh();
  assert.equal(controller.refresh(), old, 'an in-flight poll is reused');
  assert.equal(theme(dom), 'classic');
  app.server = 'https://two.example';
  await controller.refresh();
  assert.equal(theme(dom), 'crystal');
  resolveOld({ theme: 'classic' });
  await old;
  assert.equal(theme(dom), 'crystal');
  assert.equal(store.themeFor('https://two.example'), 'crystal');
  assert.equal(store.themeFor('https://one.example'), null);
});

test('unavailable browser storage never prevents applying a server theme', async () => {
  const dom = installDom();
  const controller = createThemeController({
    app: { server: '' },
    store: createStore({
      getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); },
    }),
    load: async () => ({ theme: 'classic' }),
  });
  await controller.refresh();
  assert.equal(theme(dom), 'classic');
});

test('the pre-paint cache applies only known themes belonging to the selected backend', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const source = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const run = (href, cached, remembered = null) => {
    const root = { dataset: { theme: 'crystal' } };
    const meta = { content: '#080d1c' };
    runInNewContext(source, {
      location: { origin: new URL(href).origin, href }, URL,
      AVALON_CONFIG: { apiBase: 'https://games.example' },
      localStorage: { getItem: (key) => key === 'avalon.ui-theme' ? JSON.stringify(cached) : remembered },
      document: { documentElement: root, getElementById: () => meta },
    });
    return { theme: root.dataset.theme, color: meta.content };
  };
  assert.deepEqual(run('http://localhost:8420', { server: 'http://localhost:8420', theme: 'classic' }), {
    theme: 'classic', color: '#12141c',
  });
  assert.equal(run('http://localhost:8420', { server: 'https://other.example', theme: 'classic' }).theme, 'crystal');
  assert.equal(run('http://localhost:8420', { server: 'http://localhost:8420', theme: 'arbitrary-css' }).theme, 'crystal');
  assert.equal(run('https://shengjiex98.github.io/avalon/', { server: 'https://games.example', theme: 'classic' }).theme, 'classic');
  assert.equal(run('https://shengjiex98.github.io/avalon/?server=https://other.example', {
    server: 'https://games.example', theme: 'classic',
  }).theme, 'crystal');
});
