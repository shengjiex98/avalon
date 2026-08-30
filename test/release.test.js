import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { API_PROTOCOL } from '../src/contracts/api-protocol.ts';
import { readDeployedCommit } from '../src/server/main.ts';
import { STATE_VERSION } from '../src/contracts/state-version.ts';
import { browserConfig } from '../scripts/browser-config.mjs';

const manifestWriter = fileURLToPath(new URL('../scripts/write-release-manifest.mjs', import.meta.url));
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packager = join(root, 'scripts/package-release.sh');

function run(command, args, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
  });
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
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [manifestWriter, commit, output]);
    child.on('close', (code) => resolveRun(code));
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
    deployerSchema: 3,
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

test('the trusted workflow verifier accepts only the bundled minimal release', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'avalon-packaged-release-'));
  const commit = process.env.AVALON_BUILD_COMMIT ?? 'd'.repeat(40);
  await mkdir(join(dir, 'build/server'), { recursive: true });
  await cp(join(root, 'build/server/main.mjs'), join(dir, 'build/server/main.mjs'));
  await cp(join(root, 'build/public'), join(dir, 'build/public'), { recursive: true });
  await writeFile(join(dir, 'build/public/config.js'), browserConfig('', 'test release'));
  await writeFile(join(dir, 'build/public/version.json'), `${JSON.stringify({ version: commit })}\n`);
  await writeFile(join(dir, 'release.json'), JSON.stringify({
    commit,
    stateVersion: STATE_VERSION,
    apiProtocol: API_PROTOCOL,
    nodeMajor: 24,
    deployerSchema: 3,
  }));

  const verifier = join(root, 'scripts/verify-packaged-release.mjs');
  const verify = () => run(process.execPath, [verifier, dir, commit]);
  const initial = await verify();
  assert.equal(initial.code, 0, initial.stderr);
  assert.equal((await run(process.execPath, [verifier, dir, 'e'.repeat(40)])).code, 65);

  await rm(join(dir, 'build/server/main.mjs'));
  assert.equal((await verify()).code, 65, 'a missing bundled entry must fail before publication');
  await cp(join(root, 'build/server/main.mjs'), join(dir, 'build/server/main.mjs'));

  const browserManifest = JSON.parse(await readFile(join(dir, 'build/public/.vite/manifest.json'), 'utf8'));
  const browserEntry = browserManifest['index.html'].file;
  await rm(join(dir, 'build/public', browserEntry));
  assert.equal((await verify()).code, 65, 'a missing browser entry must fail before publication');
  await cp(join(root, 'build/public', browserEntry), join(dir, 'build/public', browserEntry));

  await writeFile(join(dir, 'package.json'), '{}');
  assert.equal((await verify()).code, 65, 'anything outside release.json and build must be rejected');
  await rm(join(dir, 'package.json'));

  await writeFile(join(dir, 'build/server/main.mjs'), "import 'zod';\n");
  assert.equal((await verify()).code, 65, 'a runtime package import must be rejected');
});

async function inCheckout() {
  const top = await run('git', ['-C', root, 'rev-parse', '--show-toplevel']);
  return top.code === 0 && top.stdout.trim() === root;
}

async function stageBrowser(commit) {
  const output = await mkdtemp(join(tmpdir(), 'avalon-browser-stage-'));
  const staged = await run(process.execPath, [
    join(root, 'scripts/stage-browser-artifacts.mjs'), commit, output,
  ]);
  assert.equal(staged.code, 0, staged.stderr);
  return join(output, 'self-hosted-public');
}

test('the packaged release contains only the tested runnable artifact', async (t) => {
  if (!await inCheckout()) return t.skip('no checkout to package');

  const commit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  const browser = await stageBrowser(commit);

  const dir = await mkdtemp(join(tmpdir(), 'avalon-package-'));
  const packaged = await run('sh', [
    packager, 'HEAD', dir, browser,
  ], { cwd: root });
  assert.equal(packaged.code, 0, packaged.stderr);
  const archive = packaged.stdout.trim().split('\n').at(-1);
  assert.deepEqual(await readdir(dir), [basename(archive)],
    'the packager emits one archive and no partial or standalone checksum');

  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  const hashed = await run('sha256sum', [archive]);
  assert.equal(hashed.code, 0, hashed.stderr);
  assert.equal(hashed.stdout.trim().split(/\s+/)[0], digest);

  const listed = await run('tar', ['-tzf', archive]);
  assert.equal(listed.code, 0, listed.stderr);
  const files = new Set(listed.stdout.split('\n').map((name) => name.replace(/^avalon-[0-9a-f]{40}\//, '')));
  assert.ok(files.has('release.json'));
  assert.ok(files.has('build/server/main.mjs'));
  assert.ok(files.has('build/public/index.html'));
  for (const forbidden of ['src/', 'node_modules/', 'test/', 'deploy/', 'scripts/', 'package.json', 'package-lock.json']) {
    assert.equal([...files].some((name) => name === forbidden || name.startsWith(forbidden)), false,
      `the release must omit ${forbidden}`);
  }

  const extracted = await mkdtemp(join(tmpdir(), 'avalon-production-release-'));
  const unpacked = await run('tar', ['-xzf', archive, '--strip-components=1', '-C', extracted]);
  assert.equal(unpacked.code, 0, unpacked.stderr);
  assert.deepEqual((await readdir(extracted)).sort(), ['build', 'release.json']);

  const verified = await run(process.execPath, [join(root, 'scripts/verify-packaged-release.mjs'), extracted, commit]);
  assert.equal(verified.code, 0, verified.stderr);
  const behavior = await run(process.execPath, [join(root, 'scripts/test-packaged-release.mjs'), extracted, commit]);
  assert.equal(behavior.code, 0, behavior.stderr);
});

test('a failed compression publishes nothing at all', async (t) => {
  if (!await inCheckout()) return t.skip('no checkout to package');

  const commit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  const browser = await stageBrowser(commit);
  const bin = await shim('gzip', '#!/bin/sh\nexit 3\n');
  const dir = await mkdtemp(join(tmpdir(), 'avalon-package-'));
  const packaged = await run('sh', [packager, 'HEAD', dir, browser], withPath(bin));

  assert.notEqual(packaged.code, 0, 'a broken compressor must fail the packager');
  assert.deepEqual(await readdir(dir), [], 'no archive, and no partial output, may survive');
});

test('a failed archive readback publishes nothing at all', async (t) => {
  if (!await inCheckout()) return t.skip('no checkout to package');

  const commit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  const browser = await stageBrowser(commit);
  const real = (await run('sh', ['-c', 'command -v tar'])).stdout.trim();
  const bin = await shim('tar', `#!/bin/sh\ncase " $* " in *" -tzf "*) exit 3;; esac\nexec ${real} "$@"\n`);
  const dir = await mkdtemp(join(tmpdir(), 'avalon-package-'));
  const packaged = await run('sh', [packager, 'HEAD', dir, browser], withPath(bin));

  assert.equal(packaged.code, 3, 'the archive readback status must reach the caller');
  assert.deepEqual(await readdir(dir), [], 'no archive, and no partial output, may survive');
});

test('packaging uses ordinary tar without deterministic-archive options', async () => {
  const source = await readFile(packager, 'utf8');
  assert.doesNotMatch(source, /--sort|--mtime|--owner|--group|--numeric-owner|gzip -n/);
});
