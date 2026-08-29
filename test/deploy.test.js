// Guards the two deliberate entry points -- a self-contained Node deployment
// and the official Pages client pointed at a compatible Node server -- and the
// pipeline that keeps the two on the same commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { API_PROTOCOL } from '../src/api-protocol.js';
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

// Pages ships on its own release train, so the client cannot import the
// server's constant. It carries a copy, and the two must be the same number.
test('the Pages client declares the same API protocol as the server', async () => {
  const source = await read('../public/app.js');
  const declared = /^const API_PROTOCOL = (\d+);$/m.exec(source);
  assert.ok(declared, 'public/app.js must declare API_PROTOCOL as a plain number');
  assert.equal(Number(declared[1]), API_PROTOCOL);
});

test('the browser defaults to Node but can remember one HTTPS backend', async () => {
  const source = await read('../public/app.js');
  const config = await read('../public/config.js');
  const storage = await read('../public/storage.js');
  const transport = await read('../public/transport.js');
  assert.match(source, /PAGES_ORIGIN\s*=\s*'https:\/\/shengjiex98\.github\.io'/);
  assert.match(source, /location\.origin !== PAGES_ORIGIN/);
  assert.match(source, /normaliseServer\(API_BASE\)/);
  assert.match(storage, /avalon\.server/);
  assert.match(source, /url\.protocol === 'https:'/);
  assert.match(transport, /fetch\(app\.server \+ path,/);
  assert.match(transport, /new EventSource\(`\$\{app\.server\}\/api\/rooms\//);
  assert.match(source, /url\.search = app\.server \? `\?server=/);
  assert.match(config, /export const API_BASE = ''/);
});

test('game renderers are constructed without mutable module bindings', async () => {
  for (const file of ['../public/games/avalon.js', '../public/games/onuw.js']) {
    const source = await read(file);
    assert.match(source, /export function createRenderer\(ctx\)/);
    assert.doesNotMatch(source, /export function bind|\blet (?:T|send|app)\b/);
  }
});

test('the Pages renderers consume server-owned setup metadata', async () => {
  const app = await read('../public/app.js');
  const avalon = await read('../public/games/avalon.js');
  const onuw = await read('../public/games/onuw.js');

  assert.match(app, /v\.setup\.minPlayers/);
  assert.match(avalon, /v\.setup\.options/);
  assert.match(avalon, /v\.setup\.houseRules/);
  assert.match(onuw, /v\.setup\.options/);
  assert.match(onuw, /v\.setup\.houseRules/);
  assert.match(onuw, /v\.setup\.paces/);
  for (const source of [avalon, onuw]) {
    assert.doesNotMatch(source, /export const minPlayers|const (?:OPTIONS|HOUSE_RULES)\s*=/);
  }
});

test('development type checking is locked, no-emit, and separate from the release gate', async () => {
  const pkg = JSON.parse(await read('../package.json'));
  const lock = JSON.parse(await read('../package-lock.json'));
  const config = JSON.parse(await read('../tsconfig.json'));
  const contracts = await read('../types/contracts.d.ts');
  const ci = await read('../.github/workflows/ci.yml');
  const deploy = await read('../.github/workflows/deploy.yml');

  assert.equal(pkg.scripts.typecheck, 'tsc -p tsconfig.json');
  assert.ok(pkg.devDependencies.typescript);
  assert.ok(pkg.devDependencies['@types/node']);
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(config.compilerOptions.allowJs, true);
  assert.equal(config.compilerOptions.noEmit, true);
  assert.equal(config.compilerOptions.strict, true);
  assert.match(contracts, /ValidatedAction|PersistedRoom|PublicView|GamePhase/);

  assert.match(ci, /npm ci[\s\S]*npm test[\s\S]*npm run typecheck/);
  assert.doesNotMatch(deploy, /npm ci|npm run typecheck/,
    'a release runs plain JavaScript and never installs development tools');
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

test('publication prunes every archive the pointer cannot reach', async () => {
  const workflow = await read('../.github/workflows/deploy.yml');
  const publish = workflow.slice(workflow.indexOf('publish-artifact:'), workflow.indexOf('deploy-server:'));
  const prune = publish.slice(publish.indexOf('Prune unreachable release assets'));

  // Pruning runs only for a run that published, and never before the pointer
  // and its payload are durable.
  assert.ok(publish.indexOf('dist/latest.json --clobber') < publish.indexOf('Prune unreachable release assets'));
  assert.match(prune, /if: steps\.publish\.outputs\.published == 'true'/);

  // The kept archive comes from the published pointer, never from $GITHUB_SHA,
  // so a superseding run's archive is never the one deleted.
  assert.match(prune, /gh release download "\$release_tag" -p latest\.json -O -/);
  assert.doesNotMatch(prune, /GITHUB_SHA/);
  assert.match(prune, /any\(\.assets\[\]; \.name == \$keep\)/);
  assert.match(prune, /select\(\.name != "latest\.json" and \.name != \$keep\)/);

  // Housekeeping never fails a rollout that already published.
  assert.match(prune, /skip\(\) \{ echo "::warning::\$1; skipped pruning"; exit 0; \}/);
  assert.doesNotMatch(prune, /^\s*exit 1/m);
});

test('the deploy job proves the server took the commit before publishing the client', async () => {
  const workflow = await read('../.github/workflows/deploy.yml');

  // The public application is the only success proof. CI only writes to ntfy.
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

test('the installed updater owns compatibility, activation, and rollback ordering', async () => {
  const updater = await read('../deploy/updater.sh');
  const gated = updater.indexOf('running_protocol" = "$target_protocol');
  const stopped = updater.indexOf('"$systemctl_bin" --user stop avalon');
  const backedUp = updater.indexOf('cp -p "$state_file" "$backup_dir/rooms.json"');
  const selected = updater.indexOf('select_release "$commit"');
  const started = updater.indexOf('"$systemctl_bin" --user start avalon', selected);
  assert.ok(gated !== -1 && stopped !== -1 && backedUp !== -1 && selected !== -1 && started !== -1);
  assert.ok(gated < stopped && stopped < backedUp && backedUp < selected && selected < started);
  assert.match(updater, /409\) log .*; exit 75/);
  assert.match(updater, /select_release "\$rollback"[\s\S]*restore_snapshot/);
});

test('the server and the updater snapshot the same file', async () => {
  const unit = await read('../deploy/avalon.service');
  const updater = await read('../deploy/updater.sh');
  const installer = await read('../deploy/install-updater.sh');
  // StateDirectory= resolved under $XDG_CONFIG_HOME for user units before
  // systemd 256, so the updater backed up a file the server never wrote.
  assert.doesNotMatch(unit, /^StateDirectory/m);
  assert.match(unit, /Environment=XDG_STATE_HOME=%h\/\.local\/state$/m);
  assert.match(unit, /ReadWritePaths=%h\/\.local\/state\/avalon$/m);
  assert.match(updater, /state_file=\$\{AVALON_STATE_FILE:-\$\{XDG_STATE_HOME:-\$HOME\/\.local\/state\}\/avalon\/rooms\.json\}/);
  assert.match(installer, /mkdir -p "\$state_dir"\n *chmod 700 "\$state_dir"/);
});
