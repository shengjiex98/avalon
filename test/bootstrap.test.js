import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bootstrap = fileURLToPath(new URL('../deploy/bootstrap.sh', import.meta.url));

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

/**
 * A release artifact whose only content is a controller stub. The bootstrap
 * never looks inside a release beyond `deploy/controller.sh` -- verification of
 * the manifest, the tests, and the switch all belong to the controller -- so a
 * stub is enough to observe exactly what the bootstrap hands over.
 */
async function writeStubArtifact(dir, sha, { record, exitCode = 0 }) {
  const name = `avalon-${sha}`;
  const deploy = join(dir, name, 'deploy');
  await mkdir(deploy, { recursive: true });
  await writeFile(join(deploy, 'controller.sh'), `#!/bin/sh
    {
      printf 'args: %s\\n' "$*"
      printf 'self: %s\\n' "$0"
      env
    } >"${record}"
    exit ${exitCode}
  `);
  await chmod(join(deploy, 'controller.sh'), 0o755);

  const archive = join(dir, `${name}.tar.gz`);
  const packed = await run('tar', ['-czf', archive, '-C', dir, name]);
  assert.equal(packed.code, 0, packed.stderr);
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(`${archive}.sha256`, `${digest}  ${name}.tar.gz\n`);
  return archive;
}

async function serveMain(sha) {
  const server = createServer((request, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(request.url.includes('shape=wrong') ? { sha: 'main' } : { sha }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/main`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function fixture(sha, stub = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'avalon-bootstrap-'));
  const artifacts = join(dir, 'artifacts');
  const record = join(dir, 'controller-ran');
  await mkdir(artifacts);
  const archive = await writeStubArtifact(artifacts, sha, { record, ...stub });
  const main = await serveMain(sha);
  return {
    dir,
    archive,
    record,
    main,
    env: {
      HOME: dir,
      AVALON_NODE: process.execPath,
      AVALON_RELEASE_ROOT: join(dir, 'lib'),
      AVALON_ARTIFACT_BASE: `file://${artifacts}`,
      AVALON_MAIN_URL: main.url,
    },
  };
}

function ran(record) {
  return access(record).then(() => true, () => false);
}

test('a tampered artifact never reaches the controller', async () => {
  const sha = 'a'.repeat(40);
  const { archive, record, main, env } = await fixture(sha);
  try {
    // The checksum still describes the release CI published; these bytes no
    // longer are it. Nothing in them may run.
    await writeFile(archive, 'not the release you asked for');
    const result = await run('sh', [bootstrap, 'deploy-main'], env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /checksum mismatch/);
    assert.equal(await ran(record), false, 'the stub controller must never have executed');
  } finally {
    await main.close();
  }
});

test('a trigger for anything but current main deploys nothing', async () => {
  const sha = 'b'.repeat(40);
  const stale = 'c'.repeat(40);
  const { record, main, env } = await fixture(sha);
  try {
    const result = await run('sh', [bootstrap, 'deploy-trigger', stale], env);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, new RegExp(`ignored deployment trigger for ${stale}`));
    assert.equal(await ran(record), false);

    const current = await run('sh', [bootstrap, 'deploy-trigger', sha], env);
    assert.equal(current.code, 0, current.stderr);
    assert.equal(await ran(record), true, 'the commit that is main does deploy');
  } finally {
    await main.close();
  }
});

test('a deployment already in flight is left alone', async () => {
  const sha = 'd'.repeat(40);
  const { record, main, env } = await fixture(sha);
  const lock = join(env.AVALON_RELEASE_ROOT, '.deploy.lock');
  await mkdir(env.AVALON_RELEASE_ROOT, { recursive: true });

  // The hourly timer and a CI trigger can arrive at the same moment; the
  // second one must decline rather than deploy alongside the first.
  const holder = spawn('flock', ['-n', lock, 'sh', '-c', 'echo held; sleep 30']);
  try {
    await new Promise((resolve, reject) => {
      holder.stdout.on('data', resolve);
      holder.on('error', reject);
      holder.on('exit', (code) => reject(new Error(`flock exited with ${code}`)));
    });

    const result = await run('sh', [bootstrap, 'deploy-main'], env);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /already in flight/);
    assert.equal(await ran(record), false);
  } finally {
    holder.kill();
    await main.close();
  }
});

test('the controller runs from the downloaded release, not from the host', async () => {
  const sha = 'e'.repeat(40);
  const { dir, record, main, env } = await fixture(sha);
  try {
    const result = await run('sh', [bootstrap, 'deploy-main'], env);
    assert.equal(result.code, 0, result.stderr);
    const invocation = await readFile(record, 'utf8');
    assert.match(invocation, new RegExp(`^args: deploy ${sha}$`, 'm'));

    const self = invocation.match(/^self: (.*)$/m)[1];
    assert.match(self, /\/deploy\/controller\.sh$/);
    assert.ok(!self.startsWith(dir), 'the controller comes from the extracted artifact');
    await assert.rejects(access(self), 'the extracted tree is removed afterwards');
  } finally {
    await main.close();
  }
});

test('deployment controls from the host never reach the controller', async () => {
  const sha = 'f'.repeat(40);
  const { record, main, env } = await fixture(sha);
  try {
    // Both of these answer questions the controller must ask for itself:
    // whether the restart is lossless, and whether the release passes its own
    // tests. Ambient values -- a stale user session, a hand-run experiment --
    // would silently decide both.
    const result = await run('sh', [bootstrap, 'deploy-main'], {
      ...env,
      TARGET_STATE_VERSION: '99',
      AVALON_FORCE: '1',
    });
    assert.equal(result.code, 0, result.stderr);

    const environment = await readFile(record, 'utf8');
    assert.doesNotMatch(environment, /^TARGET_STATE_VERSION=/m);
    assert.doesNotMatch(environment, /^AVALON_FORCE=/m);
    assert.match(environment, /^HOME=/m, 'the allowlist still carries what the controller needs');
    assert.match(environment, /^AVALON_RELEASE_ROOT=/m);
  } finally {
    await main.close();
  }
});

test('a busy server passes through as exit 75', async () => {
  const sha = '1'.repeat(40);
  const { main, env } = await fixture(sha, { exitCode: 75 });
  try {
    // 75 means "a game is in progress, try later" at every layer, and the
    // update units treat it as success. Turning it into 1 would report a
    // healthy refusal as a failed deployment.
    const result = await run('sh', [bootstrap, 'deploy-main'], env);
    assert.equal(result.code, 75);
  } finally {
    await main.close();
  }
});

test('a main lookup that is not a commit deploys nothing', async () => {
  const sha = '2'.repeat(40);
  const { record, main, env } = await fixture(sha);
  try {
    // GitHub answering with a branch name, an error page, or a rate-limit
    // notice is not a deployment target. Nothing is downloaded on the strength
    // of an answer that is not 40 hex characters.
    const result = await run('sh', [bootstrap, 'deploy-main'], {
      ...env,
      AVALON_MAIN_URL: `${main.url}?shape=wrong`,
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /cannot resolve/);
    assert.equal(await ran(record), false);
  } finally {
    await main.close();
  }
});

test('the bootstrap verifies before it executes, and never rewrites itself', async () => {
  const source = await readFile(bootstrap, 'utf8');
  const verified = source.indexOf('checksum mismatch for $archive');
  const extracted = source.indexOf('tar -xzf "$work/$archive"');
  const executed = source.indexOf('"$work/tree/deploy/controller.sh" deploy "$sha"');
  assert.ok(verified !== -1 && extracted !== -1 && executed !== -1);
  assert.ok(verified < extracted && extracted < executed,
    'verify the download, then extract it, then run it');
  assert.doesNotMatch(source, /install-bootstrap\.sh"/,
    'the static layer is installed by a human, never by itself');
});
