import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { API_PROTOCOL } from '../src/api-protocol.js';
import { readDeployedCommit } from '../src/server.js';
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

const packager = join(root, 'scripts/package-release.sh');

/**
 * The archive is reproducible only under GNU tar. A BSD tar cannot build it at
 * all, so on such a machine these tests have nothing to assert about this
 * repository -- the packager refuses before it starts, and CI is the gate.
 */
async function packagingSupported() {
  const probe = await run('tar', [
    '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
    '-cf', '/dev/null', '-T', '/dev/null',
  ]);
  return probe.code === 0;
}

/** A directory holding one executable that shadows the real tool on PATH. */
async function shim(name, script) {
  const dir = await mkdtemp(join(tmpdir(), 'avalon-shim-'));
  await writeFile(join(dir, name), script);
  await chmod(join(dir, name), 0o755);
  return dir;
}

const withPath = (dir) => ({ cwd: root, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });

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

test('the trusted workflow verifier checks the packaged manifest and required files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'avalon-packaged-release-'));
  const commit = 'd'.repeat(40);
  for (const name of ['package.json', 'src/server.js', 'public/index.html']) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), name);
  }
  await writeFile(join(dir, 'release.json'), JSON.stringify({
    commit,
    stateVersion: STATE_VERSION,
    apiProtocol: API_PROTOCOL,
    nodeMajor: 24,
    deployerSchema: 1,
  }));

  const verifier = join(root, 'scripts/verify-packaged-release.mjs');
  assert.equal((await run(process.execPath, [verifier, dir, commit])).code, 0);
  assert.equal((await run(process.execPath, [verifier, dir, 'e'.repeat(40)])).code, 65);
});

// A release must carry the application and the files used to package, install,
// and validate the static deployment path. An export-ignore or forgotten
// `git add` would otherwise strand a manual updater upgrade.
const CONTROL_PLANE = [
  'deploy/install-updater.sh',
  'deploy/listen.mjs',
  'deploy/updater.sh',
  'deploy/verify-pointer.mjs',
  'deploy/avalon.service',
  'deploy/avalon-listen.service',
  'deploy/avalon-update.service',
  'deploy/avalon-update.timer',
  'scripts/verify-packaged-release.mjs',
];

async function inCheckout() {
  const toplevel = await run('git', ['-C', root, 'rev-parse', '--show-toplevel']);
  return toplevel.code === 0 && toplevel.stdout.trim() === root;
}

test('the packaged release carries the control plane that deploys it', async (t) => {
  // This suite runs in two places, and the honest check differs between them.
  // In a checkout, packaging is what can silently drop a file, so package and
  // look inside the tarball. On the host the suite already runs from the
  // extracted artifact -- there is no checkout to package, and the tree under
  // test *is* the release, so inspect it directly.
  if (!await inCheckout()) {
    for (const file of CONTROL_PLANE) {
      assert.ok(existsSync(join(root, file)), `this release must ship ${file}`);
    }
    return;
  }

  if (!await packagingSupported()) {
    return t.skip('this tar cannot build reproducible archives; CI packages the release');
  }

  const dir = await mkdtemp(join(tmpdir(), 'avalon-package-'));
  const packaged = await run('sh', [packager, 'HEAD', dir], { cwd: root });
  assert.equal(packaged.code, 0, packaged.stderr);
  const archive = packaged.stdout.trim().split('\n').at(-1);
  assert.deepEqual(await readdir(dir), [basename(archive)],
    'the packager emits one archive and no standalone checksum');
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  const reproduced = await run('sha256sum', [archive]);
  assert.equal(reproduced.code, 0, reproduced.stderr);
  assert.equal(reproduced.stdout.trim().split(/\s+/)[0], digest);

  const listed = await run('tar', ['-tzf', archive]);
  assert.equal(listed.code, 0, listed.stderr);
  const files = new Set(listed.stdout.split('\n').map((name) => name.replace(/^avalon-[0-9a-f]{40}\//, '')));

  for (const file of CONTROL_PLANE) {
    assert.ok(files.has(file), `the artifact must ship ${file}`);
  }
});

// A pipeline reports only its last stage, which is how a failed extraction
// once produced an empty archive that read as a successful release.
test('a failed compression publishes nothing at all', async (t) => {
  if (!await inCheckout()) return t.skip('no checkout to package');
  if (!await packagingSupported()) {
    return t.skip('this tar cannot build reproducible archives; CI packages the release');
  }

  const bin = await shim('gzip', '#!/bin/sh\nexit 3\n');
  const dir = await mkdtemp(join(tmpdir(), 'avalon-package-'));
  const packaged = await run('sh', [packager, 'HEAD', dir], withPath(bin));

  assert.notEqual(packaged.code, 0, 'a broken compressor must fail the packager');
  assert.deepEqual(await readdir(dir), [], 'no archive, and no partial output, may survive');
});

test('a failed extraction publishes nothing at all', async (t) => {
  if (!await inCheckout()) return t.skip('no checkout to package');
  if (!await packagingSupported()) {
    return t.skip('this tar cannot build reproducible archives; CI packages the release');
  }

  // Fails the extraction but not the capability probe, so the packager gets
  // past its tool check and then loses a step it used to ignore.
  const real = (await run('sh', ['-c', 'command -v tar'])).stdout.trim();
  const bin = await shim('tar', `#!/bin/sh\ncase " $* " in *" -xf "*) exit 3;; esac\nexec ${real} "$@"\n`);
  const dir = await mkdtemp(join(tmpdir(), 'avalon-package-'));
  const packaged = await run('sh', [packager, 'HEAD', dir], withPath(bin));

  assert.equal(packaged.code, 3, 'the extraction status must reach the caller, not be masked');
  assert.deepEqual(await readdir(dir), [], 'no archive, and no partial output, may survive');
});

// Item 6: a tar without --sort/--mtime cannot build this archive. Saying so
// before packaging is what separates an unusable toolchain from a regression.
test('a tar that cannot build reproducible archives is named as the problem', async (t) => {
  if (!await inCheckout()) return t.skip('no checkout to package');

  const bin = await shim('tar', '#!/bin/sh\nexit 1\n');
  const dir = await mkdtemp(join(tmpdir(), 'avalon-package-'));
  const packaged = await run('sh', [packager, 'HEAD', dir], withPath(bin));

  assert.equal(packaged.code, 69, 'an unusable tool is not a usage error and not a regression');
  assert.match(packaged.stderr, /GNU tar/);
  assert.deepEqual(await readdir(dir), []);
});

// The host compares what it downloaded against what CI published, so the same
// commit must compress to the same bytes on both machines.
test('packaging one commit twice produces the same bytes', async (t) => {
  if (!await inCheckout()) return t.skip('no checkout to package');
  if (!await packagingSupported()) {
    return t.skip('this tar cannot build reproducible archives; CI packages the release');
  }

  const digests = [];
  for (let i = 0; i < 2; i++) {
    const dir = await mkdtemp(join(tmpdir(), 'avalon-package-'));
    const packaged = await run('sh', [packager, 'HEAD', dir], { cwd: root });
    assert.equal(packaged.code, 0, packaged.stderr);
    const archive = packaged.stdout.trim().split('\n').at(-1);
    digests.push(createHash('sha256').update(await readFile(archive)).digest('hex'));
  }
  assert.equal(digests[0], digests[1]);
});
