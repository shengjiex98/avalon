import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { API_PROTOCOL, readDeployedCommit } from '../src/server.js';
import { STATE_VERSION } from '../src/state-version.js';

const script = fileURLToPath(new URL('../scripts/write-release-manifest.mjs', import.meta.url));
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function runManifest(commit, output) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, commit, output]);
    child.on('close', (code) => resolve(code));
  });
}

test('a release manifest carries the deployment compatibility contract', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'avalon-release-'));
  const output = join(dir, 'release.json');
  const commit = 'a'.repeat(40);

  assert.equal(await runManifest(commit, output), 0);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), {
    commit,
    stateVersion: STATE_VERSION,
    apiProtocol: API_PROTOCOL,
    nodeMajor: 24,
    deployerSchema: 1,
  });
  assert.equal(readDeployedCommit(dir), commit);
});

test('an invalid release identity is rejected rather than reported', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'avalon-release-'));
  const output = join(dir, 'release.json');

  assert.equal(await runManifest('main', output), 64);

  await writeFile(output, JSON.stringify({ commit: 'not-a-commit' }));
  assert.equal(readDeployedCommit(dir), null);
});

// Self-deployment rests on these: the bootstrap runs the controller, the gate,
// and the units out of the artifact. An export-ignore or a forgotten `git add`
// would otherwise strand every deployment after it.
const CONTROL_PLANE = [
  'deploy/bootstrap.sh',
  'deploy/controller.sh',
  'deploy/gate.sh',
  'deploy/lib.sh',
  'deploy/listen.mjs',
  'deploy/verify-release.mjs',
  'deploy/wait-for-health.mjs',
  'deploy/avalon.service',
  'deploy/avalon-listen.service',
  'deploy/avalon-update.service',
  'deploy/avalon-update@.service',
  'deploy/avalon-update.timer',
];

test('the packaged release carries the control plane that deploys it', async () => {
  // This suite runs in two places, and the honest check differs between them.
  // In a checkout, packaging is what can silently drop a file, so package and
  // look inside the tarball. On the host the suite already runs from the
  // extracted artifact -- there is no checkout to package, and the tree under
  // test *is* the release, so inspect it directly.
  const toplevel = await run('git', ['-C', root, 'rev-parse', '--show-toplevel']);
  const inCheckout = toplevel.code === 0 && toplevel.stdout.trim() === root;

  if (!inCheckout) {
    for (const file of CONTROL_PLANE) {
      assert.ok(existsSync(join(root, file)), `this release must ship ${file}`);
    }
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'avalon-package-'));
  const packaged = await run('sh', [join(root, 'scripts/package-release.sh'), 'HEAD', dir], { cwd: root });
  assert.equal(packaged.code, 0, packaged.stderr);
  const archive = packaged.stdout.trim().split('\n').at(-1);

  const listed = await run('tar', ['-tzf', archive]);
  assert.equal(listed.code, 0, listed.stderr);
  const files = new Set(listed.stdout.split('\n').map((name) => name.replace(/^avalon-[0-9a-f]{40}\//, '')));

  for (const file of CONTROL_PLANE) {
    assert.ok(files.has(file), `the artifact must ship ${file}`);
  }
});
