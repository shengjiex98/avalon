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

test('publication keeps a bounded window of archives and no other debris', async () => {
  const workflow = await read('../.github/workflows/deploy.yml');
  const publish = workflow.slice(workflow.indexOf('publish-artifact:'), workflow.indexOf('deploy-server:'));
  const prune = publish.slice(publish.indexOf('Prune superseded release assets'));

  // Pruning runs only for a run that actually published, and never before the
  // pointer and its payload are durable.
  assert.ok(publish.indexOf('dist/latest.json --clobber') < publish.indexOf('Prune superseded release assets'));
  assert.match(prune, /if: steps\.publish\.outputs\.published == 'true'/);

  // latest.json, the five newest archives, and this commit's own survive.
  assert.match(prune, /new Set\(\["latest\.json", `avalon-\$\{commit\}\.tar\.gz`\]\)/);
  assert.match(prune, /\.slice\(0, 5\)/);
  assert.match(prune, /Date\.parse\(b\.created_at\) - Date\.parse\(a\.created_at\)/);

  // Housekeeping never fails a deploy that already published.
  assert.match(prune, /skip 'cannot resolve the release'/);
  assert.match(prune, /skip 'cannot list release assets'/);
  assert.match(prune, /skip 'cannot select assets to prune'/);
  assert.match(prune, /skip\(\) \{ echo "::warning::\$1; skipped pruning"; exit 0; \}/);
  assert.doesNotMatch(prune, /^\s*exit 1/m, 'a pruning failure warns rather than blocking the rollout');
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
  const unit = await read('../deploy/avalon.service');
  assert.match(unit, /StateDirectory=avalon/);
});
