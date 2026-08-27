import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { API_PROTOCOL, readDeployedCommit } from '../src/server.js';
import { STATE_VERSION } from '../src/state-version.js';

const script = fileURLToPath(new URL('../scripts/write-release-manifest.mjs', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));

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

test('the packaged release carries the control plane that deploys it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'avalon-package-'));
  const packaged = await run('sh', [join(root, 'scripts/package-release.sh'), 'HEAD', dir], { cwd: root });
  assert.equal(packaged.code, 0, packaged.stderr);
  const archive = packaged.stdout.trim().split('\n').at(-1);

  const listed = await run('tar', ['-tzf', archive]);
  assert.equal(listed.code, 0, listed.stderr);
  const files = new Set(listed.stdout.split('\n').map((name) => name.replace(/^avalon-[0-9a-f]{40}\//, '')));

  // Self-deployment rests on this: the bootstrap runs the controller, gate, and
  // units out of the artifact. An export-ignore or a forgotten `git add` would
  // otherwise strand every deployment after it.
  for (const file of [
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
  ]) {
    assert.ok(files.has(file), `the artifact must ship ${file}`);
  }
});
