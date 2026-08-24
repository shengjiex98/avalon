// Guards the two deliberate entry points: a self-contained Node deployment
// and the official Pages client pointed at a compatible Node server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stampFrontend } from '../scripts/stamp-frontend-version.mjs';

const read = (rel) => readFile(new URL(rel, import.meta.url), 'utf8');

test('every page load resolves the current server-hosted version', async () => {
  const bootstrap = await read('../public/bootstrap.js');
  assert.match(bootstrap, /version\.json/);
  assert.match(bootstrap, /cache:\s*'no-store'/);
  assert.match(bootstrap, /app\.js\?v=/);
});

test('the Pages artifact fingerprints its complete module graph', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'avalon-version-'));
  await mkdir(join(dir, 'games'));
  await writeFile(join(dir, 'app.js'), "import './ui.js';\nimport * as game from './games/index.js';\n");
  await writeFile(join(dir, 'ui.js'), 'export const ui = true;\n');
  await writeFile(join(dir, 'games/index.js'), "export { ui } from '../ui.js';\n");

  await stampFrontend(dir, 'abc123');

  assert.deepEqual(JSON.parse(await readFile(join(dir, 'version.json'), 'utf8')), { version: 'abc123' });
  assert.match(await readFile(join(dir, 'app.js'), 'utf8'), /\.\/ui\.js\?v=abc123/);
  assert.match(await readFile(join(dir, 'app.js'), 'utf8'), /\.\/games\/index\.js\?v=abc123/);
  assert.match(await readFile(join(dir, 'games/index.js'), 'utf8'), /\.\.\/ui\.js\?v=abc123/);
});

test('the connection banner lives outside the top bar', async () => {
  const html = await read('../public/index.html');
  const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  assert.ok(!header.includes('id="conn"'), 'the banner must not sit in the header');
  assert.match(html, /<div id="conn" class="conn-banner"/);
});

test('the browser defaults to Node but can remember one HTTPS backend', async () => {
  const source = await read('../public/app.js');
  const config = await read('../public/config.js');
  assert.match(source, /API_PROTOCOL\s*=\s*1/);
  assert.match(source, /PAGES_ORIGIN\s*=\s*'https:\/\/shengjiex98\.github\.io'/);
  assert.match(source, /location\.origin !== PAGES_ORIGIN/);
  assert.match(source, /normaliseServer\(API_BASE\)/);
  assert.match(source, /avalon\.server/);
  assert.match(source, /url\.protocol === 'https:'/);
  assert.match(source, /fetch\(app\.server \+ path,/);
  assert.match(source, /new EventSource\(`\$\{app\.server\}\/api\/rooms\//);
  assert.match(source, /url\.search = app\.server \? `\?server=/);
  assert.match(config, /export const API_BASE = ''/);
});

test('the Pages workflow tests and publishes only the browser client', async () => {
  const workflow = await read('../.github/workflows/pages.yml');
  assert.match(workflow, /npm test/);
  assert.match(workflow, /API_BASE:\s*\$\{\{ vars\.API_BASE \}\}/);
  assert.match(workflow, /writeFileSync\("public\/config\.js"/);
  assert.match(workflow, /stamp-frontend-version\.mjs public "\$GITHUB_SHA"/);
  assert.match(workflow, /actions\/deploy-pages/);
  assert.match(workflow, /path:\s*public/);
  assert.doesNotMatch(workflow, /ALLOW_ORIGIN/);
});
