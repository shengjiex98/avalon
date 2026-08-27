// Guards the two deliberate entry points -- a self-contained Node deployment
// and the official Pages client pointed at a compatible Node server -- and the
// pipeline that keeps the two on the same commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
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

test('the deploy workflow tests an exact server artifact and publishes the browser client', async () => {
  const workflow = await read('../.github/workflows/deploy.yml');
  assert.match(workflow, /npm test/);
  assert.match(workflow, /package-release\.sh "\$GITHUB_SHA" dist/);
  assert.match(workflow, /tar -xzf "dist\/\$archive" --strip-components=1 -C tested-release/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /GH_REPO:\s*\$\{\{ github\.repository \}\}/);
  assert.match(workflow, /gh release upload "\$release_tag"/);
  assert.match(workflow, /API_BASE:\s*\$\{\{ vars\.API_BASE \}\}/);
  assert.match(workflow, /writeFileSync\("public\/config\.js"/);
  assert.match(workflow, /stamp-frontend-version\.mjs public "\$GITHUB_SHA"/);
  assert.match(workflow, /actions\/deploy-pages/);
  assert.match(workflow, /path:\s*public/);
  assert.doesNotMatch(workflow, /ALLOW_ORIGIN/);
});

test('the client is published only after the server takes the same commit', async () => {
  const workflow = await read('../.github/workflows/deploy.yml');
  const artifact = workflow.indexOf('publish-artifact:');
  const server = workflow.indexOf('deploy-server:');
  const pages = workflow.indexOf('deploy-pages:');
  assert.ok(artifact !== -1 && server !== -1 && pages !== -1);
  assert.ok(artifact < server && server < pages,
    'the tested artifact must be published before the server and Pages client');
  assert.match(workflow.slice(pages), /needs:\s*deploy-server/);
  assert.match(workflow.slice(server, pages), /needs:\s*publish-artifact/);
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
  assert.match(listener, /\^deploy \(\[0-9a-f\]\{40\}\)\$/);
  assert.match(listener, /spawn\('systemctl', \['--user', 'start', `avalon-update@\$\{commit\}\.service`\]/);
  assert.match(listener, /import \{ spawn \} from 'node:child_process'/);
  assert.doesNotMatch(listener, /shell:\s*true|execSync|import \{[^}]*\bexec\b/,
    'no shell may see a message');

  const controller = await read('../deploy/controller.sh');
  assert.match(controller, /\[ "\$target" != "\$current_main" \]/);
  assert.doesNotMatch(controller, /source_repo|git -C/);
});

test('a current tree with stale code running still gets restarted', async () => {
  const update = await read('../deploy/update.sh');

  // Comparing only the tree calls a stale process "already current" and never
  // restarts it -- the tree can move without this script (a manual pull, or a
  // checkout whose restart failed).
  const lib = await read('../deploy/lib.sh');
  assert.match(update, /running=\$\(avalon_health \| sed -n '1p'\)/);
  assert.match(lib, /api\/health/);
  assert.match(lib, /h\.commit \?\? ""/);
  assert.match(update, /\[ -z "\$running" \] && exit 0/, 'an unknown commit must not force a restart');

  // A reset when the tree is already right buys nothing and destroys anything
  // uncommitted sitting in it.
  assert.match(update, /\[ "\$previous" = "\$target" \] \|\| git reset --hard --quiet "\$target"/);
});

/**
 * Run deploy/gate.sh against a stub server. The gate is the one place that
 * decides whether the running process may be replaced, so it is worth asking
 * it rather than reading it: these are exit codes, not greps.
 */
async function askGate({ running, target, updateStatus = 409, down = false, force = false }) {
  const home = await mkdtemp(join(tmpdir(), 'avalon-gate-home-'));   // no ~/.config/avalon.env
  const server = createServer((req, res) => {
    if (req.url === '/api/health') {
      const body = { ok: true, service: 'avalon' };
      if (running !== undefined) body.stateVersion = running;
      body.commit = 'f'.repeat(40);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(body));
    }
    res.writeHead(updateStatus, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  if (down) await new Promise((r) => server.close(r));   // nothing listening at all

  try {
    const gate = fileURLToPath(new URL('../deploy/gate.sh', import.meta.url));
    const env = { ...process.env, HOME: home, PORT: String(port) };
    // A case's declared inputs must win over ambient values from its caller or
    // host config. Inheriting either value silently inverts the answer this
    // helper exists to check.
    delete env.TARGET_STATE_VERSION;
    delete env.AVALON_FORCE;
    if (target !== undefined) env.TARGET_STATE_VERSION = String(target);
    if (force) env.AVALON_FORCE = '1';
    // Async, not spawnSync: the stub above is served by this very event loop,
    // so blocking it would deadlock against the gate's own health request.
    return await new Promise((resolve) => {
      const child = spawn('sh', [gate], { env });
      let stderr = '';
      child.stderr.on('data', (b) => { stderr += b; });
      child.on('close', (code) => resolve({ code, stderr }));
    });
  } finally {
    if (!down) await new Promise((r) => server.close(r));
  }
}

test('a lossless restart is allowed even mid-game', async () => {
  const { code, stderr } = await askGate({ running: 1, target: 1, updateStatus: 409 });
  assert.equal(code, 0, 'matching state versions restore every room');
  assert.match(stderr, /restart-compatible/);
});

test('an incompatible restart waits for the table to clear', async () => {
  assert.equal((await askGate({ running: 1, target: 2, updateStatus: 409 })).code, 75);
  assert.equal((await askGate({ running: 1, target: 2, updateStatus: 200 })).code, 0,
    'no game in progress, nothing to lose');
});

test('an unknown state version on either side fails closed', async () => {
  assert.equal((await askGate({ running: 1, updateStatus: 409 })).code, 75,
    'a target that does not declare one is not known to match');
  assert.equal((await askGate({ running: undefined, target: 1, updateStatus: 409 })).code, 75,
    'a server too old to report one is not known to match either');
});

test('a server that is not running is nothing to protect', async () => {
  assert.equal((await askGate({ running: 1, target: 2, down: true })).code, 0);
});

test('AVALON_FORCE skips the question entirely', async () => {
  const { code, stderr } = await askGate({ running: 1, target: 2, updateStatus: 409, force: true });
  assert.equal(code, 0);
  assert.match(stderr, /forced/);
});

test('the gate is asked before anything is replaced', async () => {
  const update = await read('../deploy/update.sh');
  const gate = await read('../deploy/gate.sh');

  // The checkout itself changes what open browsers are served, so both the
  // host check and the gate have to run before it, not merely before the
  // restart. A node version this host cannot run is not worth moving for.
  const node = update.indexOf('case "$(node -v)"');
  const asked = update.indexOf('"$here/gate.sh"');
  const reset = update.indexOf('git reset --hard --quiet "$target"');
  assert.ok(node !== -1 && asked !== -1 && reset !== -1);
  assert.ok(node < asked && asked < reset,
    'check the runtime, then the gate, then move the working tree');

  // The gate cannot answer without knowing what is being deployed, and it must
  // learn it as a version rather than a commit: nothing in it knows about git.
  assert.match(update, /target_state_version=\$\(git show "\$target:src\/state-version\.js"/);
  assert.match(update, /TARGET_STATE_VERSION="\$target_state_version" "\$here\/gate\.sh"/);
  assert.doesNotMatch(update, /export TARGET_STATE_VERSION/,
    'the gate input must not leak into the test environment');
  assert.match(update, /env -u TARGET_STATE_VERSION -u AVALON_FORCE[\s\\]+node --test/,
    'deployment controls inherited from the host must not affect tests');
  assert.doesNotMatch(update, /node --test[^\n]*>\/dev\/null/,
    'a failed deployment must leave its test diagnostics in the journal');
  assert.doesNotMatch(gate, /\bgit\b/, 'the gate stays usable for an image deployment');
  assert.match(update, /systemctl --user restart avalon/);

  const unit = await read('../deploy/avalon.service');
  assert.match(unit, /StateDirectory=avalon/);
});
