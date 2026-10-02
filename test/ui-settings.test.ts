import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UiSettings } from '../src/server/ui-settings.ts';

test('appearance defaults safely on missing or invalid storage without rewriting it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'avalon-ui-settings-'));
  const file = join(directory, 'ui-settings.json');
  const events: string[] = [];
  const logger = (_level: string, event: string) => { events.push(event); };
  assert.equal(new UiSettings({ file, logger }).current().theme, 'crystal');
  assert.deepEqual(events, []);
  for (const input of ['{broken', '{"theme":"unknown"}', 'null', '{"theme":"toString"}']) {
    await writeFile(file, input);
    assert.equal(new UiSettings({ file, logger }).current().theme, 'crystal');
    assert.equal(await readFile(file, 'utf8'), input);
  }
  assert.equal(events.length, 4);
});

test('appearance is atomically saved outside releases and returned as an independent value', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'avalon-ui-settings-'));
  const file = join(directory, 'private', 'ui-settings.json');
  const settings = new UiSettings({ file, logger: () => {} });
  await settings.setTheme('classic');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { theme: 'classic' });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(directory, 'private')), ['ui-settings.json']);
  const copy = settings.current();
  copy.theme = 'crystal';
  assert.equal(settings.current().theme, 'classic');
  const restarted = new UiSettings({ file, logger: () => {} });
  assert.equal(restarted.current().theme, 'classic');
  await restarted.setTheme('crystal');
  assert.equal(new UiSettings({ file }).current().theme, 'crystal');
});

test('competing theme saves commit in submission order without exposing pending values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'avalon-ui-settings-'));
  const file = join(directory, 'ui-settings.json');
  const settings = new UiSettings({ file, logger: () => {} });
  const saves = [settings.setTheme('classic'), settings.setTheme('crystal'), settings.setTheme('classic')];
  assert.equal(settings.current().theme, 'crystal');
  await Promise.all(saves);
  assert.equal(settings.current().theme, 'classic');
  assert.equal(new UiSettings({ file }).current().theme, 'classic');
});
