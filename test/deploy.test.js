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
  assert.match(source, /API_PROTOCOL\s*=\s*2/);
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

test('the deploy workflow tests the exact archive with trusted checked-out code', async () => {
  const workflow = await read('../.github/workflows/deploy.yml');
  assert.match(workflow, /package-release\.sh "\$GITHUB_SHA" dist/);
  assert.match(workflow, /tree="\$RUNNER_TEMP\/release-tree"/);
  assert.match(workflow, /tar -xzf "\$archive" --strip-components=1 -C "\$tree"/);
  assert.match(workflow, /node scripts\/verify-packaged-release\.mjs "\$tree" "\$GITHUB_SHA"/);
  assert.match(workflow, /cd "\$tree"[\s\S]*node --test "test\/\*\*\/\*\.test\.js"/);
  assert.doesNotMatch(workflow, /"\$tree\/deploy\/controller\.sh"|NTFY_TOPIC=ci-canary/,
    'CI never executes candidate deployment code');

  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /path: dist\/avalon-\$\{\{ github\.sha \}\}\.tar\.gz/);
  assert.doesNotMatch(workflow, /\.tar\.gz\.sha256/);
  assert.match(workflow, /GH_REPO:\s*\$\{\{ github\.repository \}\}/);
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

test('publication moves latest.json only after the immutable archive is durable', async () => {
  const workflow = await read('../.github/workflows/deploy.yml');
  const publish = workflow.slice(workflow.indexOf('publish-artifact:'), workflow.indexOf('deploy-server:'));
  const mainCheck = publish.indexOf('gh api "repos/$GH_REPO/commits/main"');
  const digest = publish.indexOf('sha256sum "dist/$archive"');
  const archive = publish.indexOf('gh release upload "$release_tag" "dist/$archive" --clobber');
  const pointer = publish.indexOf('gh release upload "$release_tag" dist/latest.json --clobber');
  assert.ok(mainCheck !== -1 && mainCheck < digest && digest < archive && archive < pointer);
  assert.match(publish, /schema: 1, commit, sha256/);
  assert.match(publish, /--latest=false/);
});

test('the deploy job proves the server took the commit before publishing the client', async () => {
  const workflow = await read('../.github/workflows/deploy.yml');

  // The public application is the only success proof. ntfy is wake-only.
  assert.match(workflow, /\.commit \/\/ empty/);
  assert.match(workflow, /\[ "\$commit" = "\$GITHUB_SHA" \]/);
  assert.match(workflow, /curl -fsS --max-time 10 -d deploy /);
  assert.doesNotMatch(workflow, /since=|failed \$GITHUB_SHA|busy \$GITHUB_SHA|poll=1/,
    'CI neither reads nor trusts result messages');

  // Scoped to this job: deploy-pages still needs id-token for actions/deploy-pages.
  const job = workflow.slice(workflow.indexOf('deploy-server:'), workflow.indexOf('deploy-pages:'));
  assert.doesNotMatch(job, /tailscale|id-token|secrets\.TS_/, 'CI needs no tailnet identity');
});

test('the deployment listener cannot be talked into running anything', async () => {
  const listener = await read('../deploy/listen.mjs');

  // The topic is public by design, so the message is data, never a command.
  assert.match(listener, /\^deploy\$/);
  assert.doesNotMatch(listener, /deploy \[0-9a-f\]|deploy \<sha\>/,
    'a message never supplies a commit');
  assert.match(listener, /spawn\('systemctl', \['--user', 'start', 'avalon-update\.service'\]/);
  assert.doesNotMatch(listener, /avalon-update@|startUpdate\(trigger\[1\]\)/,
    'the untrusted message cannot select a unit instance');
  assert.match(listener, /import \{ spawn \} from 'node:child_process'/);
  assert.doesNotMatch(listener, /shell:\s*true|execSync|import \{[^}]*\bexec\b/,
    'no shell may see a message');

  const updater = await read('../deploy/updater.sh');
  assert.match(updater, /artifact_base\/latest\.json\?t=/);
  assert.match(updater, /archive="avalon-\$commit\.tar\.gz"/);
  assert.doesNotMatch(updater, /AVALON_MAIN_URL|TARGET_STATE_VERSION/);
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
  const controller = await read('../deploy/controller.sh');
  const gate = await read('../deploy/gate.sh');

  // A candidate is prepared and tested without touching the running release,
  // and the gate answers before anything the players can see moves. A host
  // that is not on the release's Node major is not worth moving for either.
  const node = controller.indexOf('case "$("$node_bin" -v)"');
  const asked = controller.indexOf('"$controller_dir/gate.sh"');
  const stopped = controller.indexOf('"$systemctl_bin" --user stop avalon');
  const selected = controller.indexOf('select_release "$target"');
  assert.ok(node !== -1 && asked !== -1 && stopped !== -1 && selected !== -1);
  assert.ok(node < asked && asked < stopped && stopped < selected,
    'check the runtime, then the gate, then replace the process');

  // The gate cannot answer without knowing what is being deployed, and it must
  // learn it as a version rather than a commit: nothing in it knows about git.
  assert.match(controller, /target_state_version=\$\(manifest_state_version "\$target_release"\)/);
  assert.match(controller, /TARGET_STATE_VERSION="\$target_state_version" "\$controller_dir\/gate\.sh"/);
  assert.doesNotMatch(controller, /export TARGET_STATE_VERSION/,
    'the gate input must not leak into the test environment');
  assert.doesNotMatch(controller, /node --test[^\n]*>\/dev\/null/,
    'a failed deployment must leave its test diagnostics in the journal');
  assert.doesNotMatch(gate, /\bgit\b/, 'the gate stays usable for an image deployment');

  const unit = await read('../deploy/avalon.service');
  assert.match(unit, /StateDirectory=avalon/);
});
