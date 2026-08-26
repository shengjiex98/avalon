// Guards the two deliberate entry points -- a self-contained Node deployment
// and the official Pages client pointed at a compatible Node server -- and the
// pipeline that keeps the two on the same commit.
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

test('the deploy workflow tests and publishes only the browser client', async () => {
  const workflow = await read('../.github/workflows/deploy.yml');
  assert.match(workflow, /npm test/);
  assert.match(workflow, /API_BASE:\s*\$\{\{ vars\.API_BASE \}\}/);
  assert.match(workflow, /writeFileSync\("public\/config\.js"/);
  assert.match(workflow, /stamp-frontend-version\.mjs public "\$GITHUB_SHA"/);
  assert.match(workflow, /actions\/deploy-pages/);
  assert.match(workflow, /path:\s*public/);
  assert.doesNotMatch(workflow, /ALLOW_ORIGIN/);
});

test('the client is published only after the server takes the same commit', async () => {
  const workflow = await read('../.github/workflows/deploy.yml');
  const server = workflow.indexOf('deploy-server:');
  const pages = workflow.indexOf('deploy-pages:');
  assert.ok(server !== -1 && pages !== -1);
  assert.ok(server < pages, 'the server must be deployed before the Pages client');
  assert.match(workflow.slice(pages), /needs:\s*deploy-server/);
  assert.match(workflow.slice(server, pages), /needs:\s*test/);
});

test('the deploy job proves the server took the commit before publishing the client', async () => {
  const workflow = await read('../.github/workflows/deploy.yml');

  // A status message is a hint; the health endpoint is the evidence. Accepting
  // the message alone would let anyone who knows the topic publish a client
  // against a server that never updated.
  assert.match(workflow, /\.commit \/\/ empty/);
  assert.match(workflow, /\[ "\$commit" = "\$GITHUB_SHA" \]/);

  // since= must be captured before the trigger, or a fast deploy is missed.
  assert.ok(workflow.indexOf('since=$(date +%s)') < workflow.indexOf('publish\n'),
    'capture since before publishing');

  assert.match(workflow, /failed \$GITHUB_SHA[^\n]*\n\s*echo "::error/, 'fail fast on a rollback');
  assert.match(workflow, /busy \$GITHUB_SHA/, 'a game in progress is a wait, not a failure');

  // Scoped to this job: deploy-pages still needs id-token for actions/deploy-pages.
  const job = workflow.slice(workflow.indexOf('deploy-server:'), workflow.indexOf('deploy-pages:'));
  assert.doesNotMatch(job, /tailscale|id-token|secrets\.TS_/, 'CI needs no tailnet identity');
});

test('the deployment listener cannot be talked into running anything', async () => {
  const listener = await read('../deploy/listen.mjs');

  // The topic is public by design, so the message is data, never a command.
  assert.match(listener, /\^deploy \[0-9a-f\]\{40\}\$/);
  assert.match(listener, /spawn\('systemctl', \['--user', 'start', 'avalon-update\.service'\]/);
  assert.doesNotMatch(listener, /shell:\s*true|\bexec\(|execSync/, 'no shell may see a message');
});

test('a current tree with stale code running still gets restarted', async () => {
  const update = await read('../deploy/update.sh');

  // Comparing only the tree calls a stale process "already current" and never
  // restarts it -- the tree can move without this script (a manual pull, or a
  // checkout whose restart failed).
  assert.match(update, /health=\$\(running_health\)/);
  assert.match(update, /running=.*sed -n '1p'/);
  assert.match(update, /api\/health/);
  assert.match(update, /\[ -z "\$running" \] && exit 0/, 'an unknown commit must not force a restart');

  // A reset when the tree is already right buys nothing and destroys anything
  // uncommitted sitting in it.
  assert.match(update, /\[ "\$previous" = "\$target" \] \|\| git reset --hard --quiet "\$target"/);
});

test('the update gate asks the server before anything is replaced', async () => {
  const gate = await read('../deploy/gate.sh');
  const update = await read('../deploy/update.sh');

  assert.match(gate, /api\/health\/update/);
  assert.match(gate, /409\)[^\n]*exit 75/, '409 is the only busy answer');
  assert.match(gate, /AVALON_FORCE/);

  // The checkout itself changes what open browsers are served, so the gate has
  // to run before it, not merely before the restart.
  assert.ok(update.indexOf('gate.sh') < update.indexOf('git reset --hard --quiet "$target"'),
    'update.sh must consult the gate before moving the working tree');
  assert.match(update, /systemctl --user restart avalon/);
});

test('only known-equal state versions bypass the update gate', async () => {
  const update = await read('../deploy/update.sh');
  const unit = await read('../deploy/avalon.service');

  assert.match(update, /h\.stateVersion \?\? ""/);
  assert.match(update, /target:src\/state-version\.js/);
  assert.ok(update.includes("sed -n 's/.*STATE_VERSION = \\([0-9][0-9]*\\).*/\\1/p'"));
  assert.match(update,
    /if \[ -n "\$running_sv" \] && \[ -n "\$target_sv" \] && \[ "\$running_sv" = "\$target_sv" \]; then/);

  const comparison = update.indexOf('if [ -n "$running_sv" ]');
  const fallback = update.indexOf('else', comparison);
  const gate = update.indexOf('gate.sh', fallback);
  const reset = update.indexOf('git reset --hard --quiet "$target"');
  assert.ok(comparison < fallback && fallback < gate && gate < reset,
    'every unknown or unequal version must gate before checkout');
  assert.match(unit, /StateDirectory=avalon/);
});
