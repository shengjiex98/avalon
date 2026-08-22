// Without a browser in CI, this is what stops the UI shipping a raw key like
// "team.submit" because someone renamed a string in one language only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { STRINGS } from '../public/i18n.js';
import { ROLES } from '../src/rules.js';

const read = (rel) => readFile(new URL(rel, import.meta.url), 'utf8');

test('every literal key the client renders exists in both languages', async () => {
  const source = await read('../public/app.js');
  const keys = new Set();
  for (const m of source.matchAll(/\bT\(\s*'([\w.]+)'/g)) keys.add(m[1]);
  for (const m of source.matchAll(/data-i18n="([\w.]+)"/g)) keys.add(m[1]);
  assert.ok(keys.size > 40, `expected the client to use many keys, found ${keys.size}`);

  for (const key of [...keys].sort()) {
    for (const lang of Object.keys(STRINGS)) {
      assert.ok(key in STRINGS[lang], `${lang} is missing "${key}" (used in app.js)`);
    }
  }
});

test('the HTML shell only references keys that exist', async () => {
  const html = await read('../public/index.html');
  for (const m of html.matchAll(/data-i18n="([\w.]+)"/g)) {
    for (const lang of Object.keys(STRINGS)) {
      assert.ok(m[1] in STRINGS[lang], `${lang} is missing "${m[1]}" (used in index.html)`);
    }
  }
});

test('every role has a name and a description in both languages', () => {
  for (const role of Object.keys(ROLES)) {
    for (const lang of Object.keys(STRINGS)) {
      assert.ok(STRINGS[lang][`role.${role}`], `${lang}: role.${role}`);
      assert.ok(STRINGS[lang][`roleDesc.${role}`], `${lang}: roleDesc.${role}`);
    }
  }
});

test('every error the server can throw has a message in both languages', async () => {
  const sources = await Promise.all(['../src/game.js', '../src/rules.js', '../src/rooms.js', '../src/server.js'].map(read));
  const thrown = new Set();
  for (const src of sources) {
    for (const m of src.matchAll(/new GameError\('([\w.]+)'/g)) thrown.add(m[1]);
    for (const m of src.matchAll(/require_\([^,]+,\s*'([\w.]+)'/g)) thrown.add(m[1]);
    for (const m of src.matchAll(/error:\s*'([\w.]+)'/g)) thrown.add(m[1]);
  }
  thrown.delete('notFound'); // plain HTTP 404, never shown to a player
  assert.ok(thrown.size > 15, `expected to find the error keys, found ${thrown.size}`);

  for (const key of [...thrown].sort()) {
    for (const lang of Object.keys(STRINGS)) {
      assert.ok(`err.${key}` in STRINGS[lang], `${lang} is missing err.${key}`);
    }
  }
});

test('every win reason the engine sets has a message in both languages', async () => {
  const src = await read('../src/game.js');
  const reasons = [...src.matchAll(/'(win\.\w+)'/g)].map((m) => m[1]);
  assert.ok(reasons.length >= 4);
  for (const key of reasons) {
    for (const lang of Object.keys(STRINGS)) assert.ok(STRINGS[lang][key], `${lang}: ${key}`);
  }
});

test('every log event the engine emits has a message in both languages', async () => {
  const src = await read('../src/game.js');
  const keys = [...src.matchAll(/logEvent\(g,\s*'(log\.\w+)'/g)].map((m) => m[1]);
  const conditional = [...src.matchAll(/logEvent\(g,\s*\w+\s*\?\s*'(log\.\w+)'\s*:\s*'(log\.\w+)'/g)].flatMap((m) => [m[1], m[2]]);
  const all = new Set([...keys, ...conditional]);
  assert.ok(all.size >= 8, `expected the log keys, found ${all.size}`);
  for (const key of all) {
    for (const lang of Object.keys(STRINGS)) assert.ok(STRINGS[lang][key], `${lang}: ${key}`);
  }
});
