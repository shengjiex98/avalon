import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, cp, mkdtemp, mkdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const deployDir = fileURLToPath(new URL('../deploy/', import.meta.url));

function run(command, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function fakeRelease(manifest) {
  const dir = await mkdtemp(join(tmpdir(), 'avalon-verify-'));
  for (const path of ['package.json', 'src/server.js', 'public/index.html']) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), path);
  }
  await writeFile(join(dir, 'release.json'), JSON.stringify(manifest));
  return dir;
}

test('the stable verifier accepts exactly its release contract', async () => {
  const commit = 'b'.repeat(40);
  const valid = {
    commit,
    stateVersion: 1,
    apiProtocol: 1,
    nodeMajor: 24,
    deployerSchema: 1,
  };
  const verifier = join(deployDir, 'verify-release.mjs');
  const release = await fakeRelease(valid);

  assert.equal((await run(process.execPath, [verifier, release, commit])).code, 0);

  const wrong = await fakeRelease({ ...valid, commit: 'c'.repeat(40) });
  const result = await run(process.execPath, [verifier, wrong, commit]);
  assert.equal(result.code, 65);
});

test('the controller installer atomically selects an immutable version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'avalon-controller-'));
  const source = join(dir, 'source');
  const root = join(dir, 'installed');
  await cp(deployDir, source, { recursive: true });
  await chmod(join(source, 'install-controller.sh'), 0o755);

  const first = await run('sh', [join(source, 'install-controller.sh')], {
    AVALON_CONTROLLER_ROOT: root,
  });
  assert.equal(first.code, 0, first.stderr);
  assert.equal(await readlink(join(root, 'current')), 'versions/1');
  assert.equal(await readFile(join(root, 'versions/1/controller-version'), 'utf8'), '1\n');

  const second = await run('sh', [join(source, 'install-controller.sh')], {
    AVALON_CONTROLLER_ROOT: root,
  });
  assert.equal(second.code, 0, second.stderr);

  await writeFile(join(source, 'controller.sh'), '# changed\n');
  const collision = await run('sh', [join(source, 'install-controller.sh')], {
    AVALON_CONTROLLER_ROOT: root,
  });
  assert.equal(collision.code, 65);
  assert.match(collision.stderr, /different contents/);
});

test('the controller stages a commit without moving the source checkout', async () => {
  const source = await readFile(join(deployDir, 'controller.sh'), 'utf8');
  assert.match(source, /git -C "\$source_repo" archive "\$target"/);
  assert.match(source, /mktemp -d "\$releases\/\.staging-\$target/);
  assert.match(source, /node --test "test\/\*\*\/\*\.test\.js"/);
  assert.match(source, /chmod -R a-w "\$stage"/);
  assert.doesNotMatch(source, /git (?:reset|checkout|switch|pull)/);
});
