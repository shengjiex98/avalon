import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

import { installDom } from './dom-shim.js';

test('the emitted browser entry graph loads without TypeScript or source maps', async () => {
  const { fixtures } = installDom();
  const manifest = JSON.parse(await readFile(new URL('../build/public/.vite/manifest.json', import.meta.url), 'utf8'));
  const entry = manifest['index.html'];
  assert.equal(entry?.isEntry, true);
  await import(`../build/public/${entry.file}`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fixtures.langToggle.textContent, '中文');

  const files = await readdir(new URL('../build/public/', import.meta.url), { recursive: true });
  assert.equal(files.some((file) => file.endsWith('.ts') || file.endsWith('.map')), false);
  for (const file of files.filter((name) => name.endsWith('.js'))) {
    const source = await readFile(new URL(`../build/public/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /(?:from\s+|import\()['"][^'"]+\.ts['"]/);
  }
});
