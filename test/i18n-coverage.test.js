// Without a browser in CI, this is what stops the UI shipping a raw key like
// "team.submit" because someone renamed a string in one language only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

import { STRINGS } from '../src/client/i18n.ts';
import { ROLES } from '../src/server/games/avalon/rules.ts';

const read = (rel) => readFile(new URL(rel, import.meta.url), 'utf8');

/** Every server source file, so a newly added game cannot skip these checks. */
async function serverSources() {
  const dir = new URL('../src/server/', import.meta.url);
  const files = await readdir(dir, { recursive: true });
  const sources = files.filter((f) => f.endsWith('.js') || f.endsWith('.ts')).sort();
  assert.ok(sources.length >= 5, `expected to find the server sources, found ${sources.length}`);
  return Promise.all(sources.map((f) => readFile(new URL(f, dir), 'utf8')));
}

/** Every client source, so a game's panels cannot skip the check either. */
async function clientSources() {
  const dir = new URL('../src/client/', import.meta.url);
  const files = await readdir(dir, { recursive: true });
  const modules = files.filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts')).sort();
  assert.ok(modules.length >= 4, `expected to find the client sources, found ${modules.length}`);
  return Promise.all(modules.map((file) => readFile(new URL(file, dir), 'utf8')));
}

test('every literal key the client renders exists in both languages', async () => {
  const source = (await clientSources()).join('\n');
  const keys = new Set();
  for (const m of source.matchAll(/\bT\(\s*'([\w.]+)'/g)) keys.add(m[1]);
  for (const m of source.matchAll(/data-i18n="([\w.]+)"/g)) keys.add(m[1]);
  assert.ok(keys.size > 40, `expected the client to use many keys, found ${keys.size}`);

  for (const key of [...keys].sort()) {
    for (const lang of Object.keys(STRINGS)) {
      assert.ok(key in STRINGS[lang], `${lang} is missing "${key}" (used in app.ts)`);
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
  const sources = await serverSources();
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
  const src = (await serverSources()).join('\n');
  const reasons = [...src.matchAll(/'(win\.\w+)'/g)].map((m) => m[1]);
  assert.ok(reasons.length >= 4);
  for (const key of reasons) {
    for (const lang of Object.keys(STRINGS)) assert.ok(STRINGS[lang][key], `${lang}: ${key}`);
  }
});

test('every log event the engine emits has a message in both languages', async () => {
  const src = (await serverSources()).join('\n');
  const keys = [...src.matchAll(/logEvent\(g,\s*'(log\.\w+)'/g)].map((m) => m[1]);
  const conditional = [...src.matchAll(/logEvent\(g,\s*\w+\s*\?\s*'(log\.\w+)'\s*:\s*'(log\.\w+)'/g)].flatMap((m) => [m[1], m[2]]);
  const all = new Set([...keys, ...conditional]);
  assert.ok(all.size >= 8, `expected the log keys, found ${all.size}`);
  for (const key of all) {
    for (const lang of Object.keys(STRINGS)) assert.ok(STRINGS[lang][key], `${lang}: ${key}`);
  }
});
