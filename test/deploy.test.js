// Guards the two deliberate entry points -- a self-contained Node deployment
// and the official Pages client pointed at a compatible Node server -- and the
// pipeline that keeps the two on the same commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { API_PROTOCOL } from '../src/contracts/api-protocol.ts';

const read = (rel) => readFile(new URL(rel, import.meta.url), 'utf8');

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

test('one emitted client becomes independently configured server and Pages artifacts', async () => {
  const output = await mkdtemp(join(tmpdir(), 'avalon-browser-artifacts-'));
  const commit = process.env.AVALON_BUILD_COMMIT ?? 'c'.repeat(40);
  const apiBase = 'https://games.example.test';
  const staged = await run(process.execPath, [
    fileURLToPath(new URL('../scripts/stage-browser-artifacts.mjs', import.meta.url)),
    commit, output, `${apiBase}/`,
  ]);
  assert.equal(staged.code, 0, staged.stderr);

  const verifier = fileURLToPath(new URL('../scripts/verify-browser-artifact.mjs', import.meta.url));
  const selfHosted = await run(process.execPath, [verifier, join(output, 'self-hosted-public'), 'self-hosted', commit]);
  assert.equal(selfHosted.code, 0, selfHosted.stderr);
  const pages = await run(process.execPath, [verifier, join(output, 'pages'), 'pages', commit, apiBase]);
  assert.equal(pages.code, 0, pages.stderr);

  const selfHostedDir = join(output, 'self-hosted-public');
  const pagesDir = join(output, 'pages');
  const filesIn = async (directory) => (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
    .sort();
  const selfHostedFiles = await filesIn(selfHostedDir);
  const pagesFiles = await filesIn(pagesDir);
  assert.deepEqual(pagesFiles.filter((name) => name !== '.nojekyll'), selfHostedFiles);
  for (const name of selfHostedFiles.filter((file) => file !== 'config.js')) {
    assert.deepEqual(await readFile(join(pagesDir, name)), await readFile(join(selfHostedDir, name)),
      `${name} must come unchanged from the one tested build`);
  }
  assert.notEqual(await readFile(join(pagesDir, 'config.js'), 'utf8'),
    await readFile(join(selfHostedDir, 'config.js'), 'utf8'));
});

test('the connection banner lives outside the top bar', async () => {
  const html = await read('../index.html');
  const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  assert.ok(!header.includes('id="conn"'), 'the banner must not sit in the header');
  assert.match(html, /<div id="conn" class="conn-banner"/);
});

test('generated browser configuration carries the authored API protocol', async () => {
  const source = await read('../src/client/app.ts');
  const generated = await read('../build/public/config.js');
  assert.match(source, /globalThis\.AVALON_CONFIG/);
  assert.match(generated, new RegExp(`apiProtocol(?:"|):\\s*${API_PROTOCOL}`));
  assert.doesNotMatch(source, /^const API_PROTOCOL = \d+;$/m);
});

test('the browser defaults to Node but can remember one HTTPS backend', async () => {
  const source = await read('../src/client/app.ts');
  const config = await read('../public/config.js');
  const storage = await read('../src/client/storage.ts');
  const transport = await read('../src/client/transport.ts');
  assert.match(source, /PAGES_ORIGIN\s*=\s*'https:\/\/shengjiex98\.github\.io'/);
  assert.match(source, /location\.origin !== PAGES_ORIGIN/);
  assert.match(source, /normaliseServer\(API_BASE\)/);
  assert.match(storage, /avalon\.server/);
  assert.match(source, /url\.protocol === 'https:'/);
  assert.match(transport, /fetch\(\(app\.server \?\? ''\) \+ path,/);
  assert.match(transport, /new EventSource\(`\$\{app\.server \?\? ''\}\/api\/rooms\//);
  assert.match(source, /url\.search = app\.server \? `\?server=/);
  assert.match(config, /apiBase: ''/);
  assert.match(config, new RegExp(`apiProtocol: ${API_PROTOCOL}`));
});

test('game renderers are constructed without mutable module bindings', async () => {
  for (const file of ['../src/client/games/avalon.ts', '../src/client/games/onuw.ts']) {
    const source = await read(file);
    assert.match(source, /export function createRenderer\(ctx:/);
    assert.doesNotMatch(source, /export function bind|\blet (?:T|send|app)\b/);
  }
});

test('the Pages renderers consume server-owned setup metadata', async () => {
  const app = await read('../src/client/app.ts');
  const avalon = await read('../src/client/games/avalon.ts');
  const onuw = await read('../src/client/games/onuw.ts');

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

test('development checking and both runtime builds are explicit package contracts', async () => {
  const pkg = JSON.parse(await read('../package.json'));
  const lock = JSON.parse(await read('../package-lock.json'));
  const config = JSON.parse(await read('../tsconfig.json'));
  const vite = await read('../vite.config.ts');
  const actions = await read('../src/contracts/actions.ts');
  const persistence = await read('../src/contracts/persistence.ts');
  const runtime = await read('../src/server/runtime.ts');
  const views = await read('../src/contracts/views.ts');
  const ci = await read('../.github/workflows/ci.yml');
  const deploy = await read('../.github/workflows/deploy.yml');

  assert.equal(pkg.scripts.typecheck, 'tsc -p tsconfig.json');
  assert.ok(pkg.devDependencies.typescript);
  assert.ok(pkg.devDependencies['@types/node']);
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(config.compilerOptions.allowJs, undefined);
  assert.equal(config.compilerOptions.noEmit, true);
  assert.equal(config.compilerOptions.strict, true);
  assert.match(actions, /ValidatedAction/);
  assert.match(persistence, /z\.infer.*State/);
  assert.match(runtime, /RuntimeRoom|GameContext|RoomRegistry/);
  assert.match(views, /PublicView|GamePhase/);
  await assert.rejects(read('../src/contracts/types.ts'), /ENOENT/);
  assert.ok(config.include.includes('src/**/*.ts'), 'native server TypeScript is checked');
  assert.equal(config.include.includes('src/**/*.js'), false, 'the source tree is TypeScript-only');
  assert.ok(config.include.includes('test/**/*.test.ts'), 'native test TypeScript is checked');

  // The browser client is what talks to the API, so leaving it out of the
  // program is what let a request body drift from the contract unnoticed.
  assert.ok(config.include.includes('src/**/*.ts'), 'the authored client is type checked too');
  assert.equal(pkg.scripts.build, 'npm run build:browser && npm run build:server');
  assert.equal(pkg.scripts['build:browser'], 'vite build --mode browser');
  assert.equal(pkg.scripts['build:server'], 'vite build --mode server');
  assert.match(pkg.devDependencies.vite, /^\d+\.\d+\.\d+$/);
  assert.equal(lock.packages[''].devDependencies.vite, pkg.devDependencies.vite);
  assert.match(vite, /base:\s*'\.\/'/);
  assert.match(vite, /manifest:\s*true/);
  assert.match(vite, /outDir:\s*'build\/public'/);
  assert.match(vite, /outDir:\s*'build\/server'/);
  assert.match(vite, /entryFileNames:\s*'main\.mjs'/);
  assert.match(vite, /target:\s*'node24'/);
  assert.match(vite, /noExternal:\s*true/);
  assert.match(vite, /publicDir:\s*false/);
  assert.match(vite, /minify:\s*false/);
  assert.match(vite, /sourcemap:\s*false/);
  assert.match(vite, /__AVALON_BUILD_COMMIT__/);
  assert.deepEqual((await readdir(new URL('../public/', import.meta.url))).sort(), ['art', 'audio', 'config.js'],
    'public contains only copy-as-is assets and runtime configuration');

  assert.match(ci, /npm ci[\s\S]*npm test[\s\S]*npm run typecheck/);
  assert.equal((deploy.match(/npm ci/g) ?? []).length, 1, 'deployment installs the lockfile once');
  assert.equal((deploy.match(/npm run build\b/g) ?? []).length, 1, 'deployment builds both outputs once');
  assert.doesNotMatch(deploy, /npm run build:browser|npm run build:server/,
    'deployment does not rebuild either output independently');
  assert.match(deploy, /AVALON_BUILD_COMMIT:\s*\$\{\{ github\.sha \}\}/,
    'deployment supplies the exact workflow commit to Vite');
  assert.match(deploy, /npm run build[\s\S]*npm run test:built[\s\S]*npm run typecheck/);
});

test('the authored tree has explicit runtime boundaries', async () => {
  const entries = await readdir(new URL('../src/', import.meta.url), { withFileTypes: true });
  assert.deepEqual(entries.map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`).sort(), [
    'client/', 'contracts/', 'server/',
  ]);

  for (const entry of await readdir(new URL('../src/contracts/', import.meta.url))) {
    if (!entry.endsWith('.ts')) continue;
    const source = await read(`../src/contracts/${entry}`);
    assert.doesNotMatch(source, /from ['"]\.\.\/server\//,
      `${entry} must not depend on the server runtime`);
  }
});

test('the deploy workflow tests the exact archive with trusted checked-out code', async () => {
  const workflow = await read('../.github/workflows/deploy.yml');
  assert.match(workflow,
    /package-release\.sh "\$GITHUB_SHA" dist dist\/self-hosted-public/);
  assert.match(workflow, /tree="\$RUNNER_TEMP\/release-tree"/);
  assert.match(workflow, /tar -xzf "\$archive" --strip-components=1 -C "\$tree"/);
  assert.match(workflow, /node scripts\/verify-packaged-release\.mjs "\$tree" "\$GITHUB_SHA"/);
  assert.match(workflow, /node scripts\/test-packaged-release\.mjs "\$tree" "\$GITHUB_SHA"/);
  assert.match(workflow,
    /node scripts\/verify-browser-artifact\.mjs dist\/pages pages "\$GITHUB_SHA" "\$API_BASE"/);
  assert.doesNotMatch(workflow, /"\$tree\/deploy\/|NTFY_TOPIC=ci-canary/,
    'CI never executes candidate deployment code');

  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /path: dist\/avalon-\$\{\{ github\.sha \}\}\.tar\.gz/);
  assert.doesNotMatch(workflow, /\.tar\.gz\.sha256/);
  assert.match(workflow, /GH_REPO:\s*\$\{\{ github\.repository \}\}/);
  assert.match(workflow, /API_BASE:\s*\$\{\{ vars\.API_BASE \}\}/);
  assert.match(workflow, /stage-browser-artifacts\.mjs "\$GITHUB_SHA" dist "\$API_BASE"/);
  assert.match(workflow, /name: avalon-pages-\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /include-hidden-files: true/);
  assert.match(workflow, /actions\/deploy-pages/);
  assert.match(workflow, /path:\s*dist\/pages/);
  const pagesJob = workflow.slice(workflow.indexOf('deploy-pages:'));
  assert.match(pagesJob, /actions\/download-artifact@v4/);
  assert.doesNotMatch(pagesJob, /actions\/checkout|setup-node|npm ci|build:browser|stamp-frontend/,
    'the Pages job must publish the already-tested client without rebuilding it');
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

test('the installed service prefers the bundle and preserves one legacy rollback', async () => {
  const unit = await read('../deploy/avalon.service');
  const start = await read('../deploy/start.mjs');
  assert.match(unit, /ExecStart=%h\/\.local\/bin\/node %h\/\.local\/libexec\/avalon-deploy\/start\.mjs/);
  assert.ok(start.indexOf("build/server/main.mjs") < start.indexOf("src/server/main.ts"));
  assert.match(start, /application\.start\(\)/);

  const application = `
    import { writeFileSync } from 'node:fs';
    export function start() { writeFileSync(process.env.AVALON_TEST_MARKER, process.env.AVALON_TEST_VALUE); }
  `;
  const launch = fileURLToPath(new URL('../deploy/start.mjs', import.meta.url));

  const bundled = await mkdtemp(join(tmpdir(), 'avalon-start-bundle-'));
  await mkdir(join(bundled, 'build/server'), { recursive: true });
  await mkdir(join(bundled, 'src/server'), { recursive: true });
  await writeFile(join(bundled, 'build/server/main.mjs'), application);
  await writeFile(join(bundled, 'src/server/main.ts'), application);
  const bundledMarker = join(bundled, 'started');
  const bundledResult = await run(process.execPath, [launch], {
    cwd: bundled,
    env: { ...process.env, AVALON_TEST_MARKER: bundledMarker, AVALON_TEST_VALUE: 'bundle' },
  });
  assert.equal(bundledResult.code, 0, bundledResult.stderr);
  assert.equal(await readFile(bundledMarker, 'utf8'), 'bundle');

  const legacy = await mkdtemp(join(tmpdir(), 'avalon-start-legacy-'));
  await mkdir(join(legacy, 'src/server'), { recursive: true });
  await writeFile(join(legacy, 'src/server/main.ts'), application);
  const legacyMarker = join(legacy, 'started');
  const legacyResult = await run(process.execPath, [launch], {
    cwd: legacy,
    env: { ...process.env, AVALON_TEST_MARKER: legacyMarker, AVALON_TEST_VALUE: 'legacy' },
  });
  assert.equal(legacyResult.code, 0, legacyResult.stderr);
  assert.equal(await readFile(legacyMarker, 'utf8'), 'legacy');
});
