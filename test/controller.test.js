import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, cp, mkdtemp, mkdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
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

async function writeFakeRelease(dir, manifest) {
  for (const path of ['package.json', 'src/server.js', 'public/index.html']) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), path);
  }
  await writeFile(join(dir, 'release.json'), JSON.stringify(manifest));
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
  const unitDir = join(dir, 'systemd');
  await cp(deployDir, source, { recursive: true });
  await chmod(join(source, 'install-controller.sh'), 0o755);

  const first = await run('sh', [join(source, 'install-controller.sh')], {
    AVALON_CONTROLLER_ROOT: root,
    AVALON_SYSTEMD_USER_DIR: unitDir,
  });
  assert.equal(first.code, 0, first.stderr);
  assert.equal(await readlink(join(root, 'current')), 'versions/4');
  assert.equal(await readFile(join(root, 'versions/4/controller-version'), 'utf8'), '4\n');
  assert.match(await readFile(join(root, 'versions/4/gate.sh'), 'utf8'), /TARGET_STATE_VERSION/);
  assert.match(await readFile(join(root, 'versions/4/wait-for-health.mjs'), 'utf8'), /api\/health/);
  for (const unit of ['avalon.service', 'avalon-update.service', 'avalon-update.timer']) {
    assert.equal(await readlink(join(unitDir, unit)), join(root, 'current', unit));
  }

  const second = await run('sh', [join(source, 'install-controller.sh')], {
    AVALON_CONTROLLER_ROOT: root,
    AVALON_SYSTEMD_USER_DIR: unitDir,
  });
  assert.equal(second.code, 0, second.stderr);

  await writeFile(join(source, 'controller.sh'), '# changed\n');
  const collision = await run('sh', [join(source, 'install-controller.sh')], {
    AVALON_CONTROLLER_ROOT: root,
    AVALON_SYSTEMD_USER_DIR: unitDir,
  });
  assert.equal(collision.code, 65);
  assert.match(collision.stderr, /different contents/);
});

test('the controller stages a commit without moving the source checkout', async () => {
  const source = await readFile(join(deployDir, 'controller.sh'), 'utf8');
  assert.match(source, /prepare\(\) \(/);
  assert.match(source, /git -C "\$source_repo" archive "\$target"/);
  assert.match(source, /mktemp -d "\$releases\/\.staging-\$target/);
  assert.match(source, /"\$node_bin" --test "test\/\*\*\/\*\.test\.js"/);
  assert.match(source, /chmod -R a-w "\$stage"/);
  assert.doesNotMatch(source, /git (?:reset|checkout|switch|pull)/);
});

test('health verification requires the selected release commit', async () => {
  const expected = 'd'.repeat(40);
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, commit: expected }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const script = join(deployDir, 'wait-for-health.mjs');
    const result = await run(process.execPath, [script, String(server.address().port), expected, '2']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).commit, expected);

    const wrong = await run(process.execPath, [script, String(server.address().port), 'e'.repeat(40), '0.1']);
    assert.equal(wrong.code, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('activation stops, snapshots, switches, verifies, and can roll back in that order', async () => {
  const controller = await readFile(join(deployDir, 'controller.sh'), 'utf8');
  const stopped = controller.indexOf('"$systemctl_bin" --user stop avalon');
  const backedUp = controller.indexOf('backup_snapshot "$target"');
  const selected = controller.indexOf('select_release "$target"');
  const started = controller.indexOf('"$systemctl_bin" --user start avalon');
  const verified = controller.indexOf('wait_for_commit "$target"');
  assert.ok(stopped < backedUp && backedUp < selected && selected < started && started < verified);
  assert.match(controller, /select_release "\$rollback"[\s\S]*restore_snapshot "\$target"/);

  const service = await readFile(join(deployDir, 'avalon.service'), 'utf8');
  assert.match(service, /WorkingDirectory=%h\/\.local\/lib\/avalon\/current/);
  assert.match(service, /ExecStart=.*--preserve-symlinks-main .*current\/src\/server\.js/);

  const updater = await readFile(join(deployDir, 'avalon-update.service'), 'utf8');
  assert.match(updater, /libexec\/avalon-deploy\/current\/controller\.sh deploy-main/);
  assert.doesNotMatch(updater, /%h\/avalon\/deploy\/update\.sh/);
});

test('a failed target restores the previous release, snapshot, and healthy process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'avalon-rollback-'));
  const releaseRoot = join(dir, 'app');
  const releases = join(releaseRoot, 'releases');
  const stateFile = join(dir, 'state', 'rooms.json');
  const pidFile = join(dir, 'server.pid');
  const fakeSystemctl = join(dir, 'systemctl');
  const fakeServer = join(dir, 'server.mjs');
  // These releases already exist, so the drill must not depend on a source
  // checkout or Git metadata. That is also how it runs from a staged artifact.
  const target = 'b'.repeat(40);
  const rollback = 'a'.repeat(40);
  const manifest = (commit) => ({
    commit,
    stateVersion: 1,
    apiProtocol: 1,
    nodeMajor: 24,
    deployerSchema: 1,
  });

  await mkdir(releases, { recursive: true });
  await writeFakeRelease(join(releases, target), manifest(target));
  await writeFakeRelease(join(releases, rollback), manifest(rollback));
  await symlink(`releases/${rollback}`, join(releaseRoot, 'current'));
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, 'original snapshot');

  await writeFile(fakeServer, `
    import { createServer } from 'node:http';
    const [, , port, commit] = process.argv;
    createServer((req, res) => {
      const body = JSON.stringify({ ok: true, stateVersion: 1, commit });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    }).listen(Number(port), '127.0.0.1');
  `);
  await writeFile(fakeSystemctl, `#!/bin/sh
    set -eu
    [ "\$1" = --user ] && shift
    stop_server() {
      if [ -f "\$FAKE_PID_FILE" ]; then
        kill "\$(cat "\$FAKE_PID_FILE")" 2>/dev/null || true
        i=0
        while kill -0 "\$(cat "\$FAKE_PID_FILE")" 2>/dev/null && [ "\$i" -lt 20 ]; do
          sleep 0.05
          i=\$((i + 1))
        done
        rm -f "\$FAKE_PID_FILE"
      fi
    }
    case "\$1" in
      daemon-reload) exit 0 ;;
      stop) stop_server ;;
      start)
        commit=\$("\$AVALON_NODE" -e '
          const fs = require("node:fs");
          console.log(JSON.parse(fs.readFileSync(process.argv[1])).commit);
        ' "\$AVALON_RELEASE_ROOT/current/release.json")
        if [ "\$commit" = "\$FAIL_COMMIT" ]; then
          printf corrupt >"\$AVALON_STATE_FILE"
          exit 0
        fi
        "\$AVALON_NODE" "\$FAKE_SERVER" "\$PORT" "\$commit" >/dev/null 2>&1 &
        printf '%s\n' "\$!" >"\$FAKE_PID_FILE" ;;
      *) exit 64 ;;
    esac
  `);
  await chmod(fakeSystemctl, 0o755);

  const portProbe = createServer();
  await new Promise((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));

  const env = {
    HOME: dir,
    PORT: String(port),
    AVALON_NODE: process.execPath,
    AVALON_SYSTEMCTL: fakeSystemctl,
    AVALON_SOURCE_REPO: join(dir, 'no-source-checkout'),
    AVALON_RELEASE_ROOT: releaseRoot,
    AVALON_STATE_FILE: stateFile,
    AVALON_HEALTH_TIMEOUT_SECONDS: '2',
    FAKE_PID_FILE: pidFile,
    FAKE_SERVER: fakeServer,
    FAIL_COMMIT: target,
  };

  assert.equal((await run(fakeSystemctl, ['--user', 'start', 'avalon'], env)).code, 0);
  try {
    const result = await run('sh', [join(deployDir, 'controller.sh'), 'deploy', target, rollback], env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /rolling back/);
    assert.equal(await readlink(join(releaseRoot, 'current')), `releases/${rollback}`);
    assert.equal(await readFile(stateFile, 'utf8'), 'original snapshot');
    assert.match(result.stdout, new RegExp(rollback));
  } finally {
    await run(fakeSystemctl, ['--user', 'stop', 'avalon'], env);
  }
});
