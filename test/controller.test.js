import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, cp, lstat, mkdtemp, mkdir, readdir, readFile, readlink, stat, symlink, writeFile } from 'node:fs/promises';
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

const UNITS = [
  'avalon.service',
  'avalon-listen.service',
  'avalon-update.service',
  'avalon-update@.service',
  'avalon-update.timer',
];

async function writeFakeRelease(dir, manifest, { controlPlane = false } = {}) {
  for (const path of ['package.json', 'src/server.js', 'public/index.html']) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), path);
  }
  await writeFile(join(dir, 'release.json'), JSON.stringify(manifest));

  // Units and the bootstrap ship inside the release, so a fake release that
  // stands in for a deployment has to carry them too.
  if (controlPlane) {
    await mkdir(join(dir, 'deploy'), { recursive: true });
    for (const unit of UNITS) {
      await writeFile(join(dir, 'deploy', unit), `# ${unit} from ${manifest.commit}\n`);
    }
    await writeFile(join(dir, 'deploy', 'bootstrap.sh'), `# bootstrap from ${manifest.commit}\n`);
  }
}

async function writeFakeArtifact(dir, target) {
  const name = `avalon-${target}`;
  const release = join(dir, name);
  await writeFakeRelease(release, {
    commit: target,
    stateVersion: 1,
    apiProtocol: 1,
    nodeMajor: 24,
    deployerSchema: 1,
  });
  await writeFile(join(release, 'package.json'), JSON.stringify({ type: 'module' }));
  await mkdir(join(release, 'test'), { recursive: true });
  await writeFile(join(release, 'test', 'smoke.test.js'), `
    import test from 'node:test';
    import assert from 'node:assert/strict';
    test('artifact smoke test', () => assert.equal(1, 1));
  `);

  const archive = join(dir, `${name}.tar.gz`);
  const packed = await run('tar', ['-czf', archive, '-C', dir, name]);
  assert.equal(packed.code, 0, packed.stderr);
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(`${archive}.sha256`, `${digest}  ${name}.tar.gz\n`);
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

test('installing the static layer leaves one script and five real units', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'avalon-bootstrap-install-'));
  const source = join(dir, 'source');
  const root = join(dir, 'installed');
  const unitDir = join(dir, 'systemd');
  await cp(deployDir, source, { recursive: true });
  await chmod(join(source, 'install-bootstrap.sh'), 0o755);

  // The layout it replaces pointed the units at a versioned bundle by symlink.
  await mkdir(unitDir, { recursive: true });
  await symlink(join(dir, 'gone', 'avalon.service'), join(unitDir, 'avalon.service'));

  const env = { AVALON_CONTROLLER_ROOT: root, AVALON_SYSTEMD_USER_DIR: unitDir };
  const first = await run('sh', [join(source, 'install-bootstrap.sh')], env);
  assert.equal(first.code, 0, first.stderr);

  const installed = join(root, 'bootstrap.sh');
  assert.equal(await readFile(installed, 'utf8'), await readFile(join(deployDir, 'bootstrap.sh'), 'utf8'));
  assert.equal((await stat(installed)).mode & 0o777, 0o755);
  assert.equal(await readdir(root).then((names) => names.join()), 'bootstrap.sh',
    'nothing else belongs in the static layer');

  for (const unit of [
    'avalon.service',
    'avalon-listen.service',
    'avalon-update.service',
    'avalon-update@.service',
    'avalon-update.timer',
  ]) {
    const file = join(unitDir, unit);
    assert.equal((await lstat(file)).isSymbolicLink(), false, `${unit} is a real file, not a link`);
    assert.equal(await readFile(file, 'utf8'), await readFile(join(deployDir, unit), 'utf8'));
  }

  // Run again on a host that is already installed: same result, no complaint.
  const second = await run('sh', [join(source, 'install-bootstrap.sh')], env);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(await readFile(installed, 'utf8'), await readFile(join(deployDir, 'bootstrap.sh'), 'utf8'));
});

test('the steady-state units call only the installed updater and listener', async () => {
  const updater = await readFile(join(deployDir, 'avalon-update.service'), 'utf8');
  assert.match(updater, /ExecStart=%h\/\.local\/libexec\/avalon-deploy\/updater\.sh reconcile$/m);
  assert.match(updater, /SuccessExitStatus=75/);

  // Retained for one emergency release only; no installed steady-state unit
  // or listener references the commit-specific template.
  const triggered = await readFile(join(deployDir, 'avalon-update@.service'), 'utf8');
  assert.match(triggered, /ExecStart=%h\/\.local\/libexec\/avalon-deploy\/bootstrap\.sh deploy-trigger %i$/m);

  const listener = await readFile(join(deployDir, 'avalon-listen.service'), 'utf8');
  assert.doesNotMatch(listener, /WorkingDirectory=.*current/m);
  assert.match(listener, /ExecStart=.*%h\/\.local\/libexec\/avalon-deploy\/listen\.mjs$/m);

  const controller = await readFile(join(deployDir, 'controller.sh'), 'utf8');
  assert.doesNotMatch(controller, /deploy-main|deploy-trigger|resolve-main/,
    'the controller deploys the commit it is given; the bootstrap chooses it');
});

test('a release under test cannot publish to the deployment topic', async () => {
  const controller = await readFile(join(deployDir, 'controller.sh'), 'utf8');

  // The suite drills deployment and rollback, publish() included, and the
  // update units carry the host's real NTFY_TOPIC. Without this the host
  // announces fixture commits on the topic CI is watching.
  assert.match(controller, /env -u TARGET_STATE_VERSION -u AVALON_FORCE -u NODE_TEST_CONTEXT[\s\\]+-u NTFY_TOPIC -u NTFY_SERVER/);

  // And the drills say so themselves, for anyone running the suite by hand
  // with a topic exported.
  const drills = await readFile(new URL(import.meta.url), 'utf8');
  assert.match(drills, /NTFY_TOPIC: ''/);
});

test('the controller downloads a verified artifact without moving the source checkout', async () => {
  const source = await readFile(join(deployDir, 'controller.sh'), 'utf8');
  assert.match(source, /prepare\(\) \(/);
  assert.match(source, /"\$artifact_base\/\$archive"/);
  assert.match(source, /sha256sum "\$download\/\$archive"/);
  assert.match(source, /tar -xzf "\$download\/\$archive" --strip-components=1/);
  assert.match(source, /mktemp -d "\$releases\/\.staging-\$target/);
  assert.match(source, /"\$node_bin" --test "test\/\*\*\/\*\.test\.js"/);
  assert.match(source, /chmod -R a-w "\$stage"/);
  assert.doesNotMatch(source, /\bgit\b|source_repo/);
});

test('artifact preparation verifies, tests, and stages the downloaded bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'avalon-artifact-'));
  const artifactDir = join(dir, 'artifacts');
  const releaseRoot = join(dir, 'releases-root');
  const target = 'c'.repeat(40);
  await mkdir(artifactDir);
  await writeFakeArtifact(artifactDir, target);

  const result = await run('sh', [join(deployDir, 'controller.sh'), 'prepare', target], {
    HOME: dir,
    AVALON_NODE: process.execPath,
    AVALON_RELEASE_ROOT: releaseRoot,
    AVALON_ARTIFACT_BASE: `file://${artifactDir}`,
  });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const prepared = result.stdout.trim().split('\n').at(-1);
  assert.equal(prepared, join(releaseRoot, 'releases', target));
  assert.equal(JSON.parse(await readFile(join(prepared, 'release.json'))).commit, target);
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

  // The units the switch installs come from the release being selected, and a
  // failed health check puts the previous release's units back before it
  // restarts on them.
  const installedTarget = controller.indexOf('install_units "$target_release"');
  const reloaded = controller.indexOf('"$systemctl_bin" --user daemon-reload');
  assert.ok(installedTarget !== -1 && installedTarget < reloaded && reloaded < stopped);
  assert.match(controller, /install_units "\$releases\/\$rollback"[\s\S]*select_release "\$rollback"/);
});

/**
 * A stand-in for the host: a systemctl that starts and stops a fake server
 * reporting the selected release's commit, and records what it was asked to
 * do. FAIL_COMMIT names a release that starts unhealthily and corrupts the
 * snapshot on its way, which is how the rollback drill provokes a failure.
 */
async function writeFakeHost(dir) {
  const fakeServer = join(dir, 'server.mjs');
  const fakeSystemctl = join(dir, 'systemctl');

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
    printf '%s\n' "\$*" >>"\$FAKE_LOG"
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
      daemon-reload|try-restart) exit 0 ;;
      stop) stop_server ;;
      start)
        commit=\$("\$AVALON_NODE" -e '
          const fs = require("node:fs");
          console.log(JSON.parse(fs.readFileSync(process.argv[1])).commit);
        ' "\$AVALON_RELEASE_ROOT/current/release.json")
        if [ "\$commit" = "\${FAIL_COMMIT:-}" ]; then
          printf corrupt >"\$AVALON_STATE_FILE"
          exit 0
        fi
        "\$AVALON_NODE" "\$FAKE_SERVER" "\$PORT" "\$commit" >/dev/null 2>&1 &
        printf '%s\n' "\$!" >"\$FAKE_PID_FILE" ;;
      *) exit 64 ;;
    esac
  `);
  await chmod(fakeSystemctl, 0o755);
  return { fakeServer, fakeSystemctl };
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const manifest = (commit) => ({
  commit,
  stateVersion: 1,
  apiProtocol: 1,
  nodeMajor: 24,
  deployerSchema: 1,
});

/**
 * Two prepared releases and a host to switch between them. The releases exist
 * already, so the drill depends on no source checkout and no Git metadata --
 * which is also how it runs from a staged artifact.
 */
async function deploymentDrill(prefix, { failCommit } = {}) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const releaseRoot = join(dir, 'app');
  const releases = join(releaseRoot, 'releases');
  const stateFile = join(dir, 'state', 'rooms.json');
  const unitDir = join(dir, 'systemd');
  const target = 'b'.repeat(40);
  const rollback = 'a'.repeat(40);

  await mkdir(releases, { recursive: true });
  await writeFakeRelease(join(releases, target), manifest(target), { controlPlane: true });
  await writeFakeRelease(join(releases, rollback), manifest(rollback), { controlPlane: true });
  await symlink(`releases/${rollback}`, join(releaseRoot, 'current'));
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, 'original snapshot');
  await mkdir(unitDir, { recursive: true });
  for (const unit of UNITS) await writeFile(join(unitDir, unit), '# installed before this deployment\n');

  const { fakeServer, fakeSystemctl } = await writeFakeHost(dir);
  const env = {
    HOME: dir,
    // A drill announces fixture commits. Empty rather than absent: the host
    // exports a real topic, and publish() must find nothing to publish to.
    NTFY_TOPIC: '',
    PORT: String(await freePort()),
    AVALON_NODE: process.execPath,
    AVALON_SYSTEMCTL: fakeSystemctl,
    AVALON_SOURCE_REPO: join(dir, 'no-source-checkout'),
    AVALON_RELEASE_ROOT: releaseRoot,
    AVALON_STATE_FILE: stateFile,
    AVALON_SYSTEMD_USER_DIR: unitDir,
    AVALON_CONTROLLER_ROOT: join(dir, 'libexec'),
    AVALON_HEALTH_TIMEOUT_SECONDS: '2',
    FAKE_PID_FILE: join(dir, 'server.pid'),
    FAKE_LOG: join(dir, 'systemctl.log'),
    FAKE_SERVER: fakeServer,
    ...(failCommit ? { FAIL_COMMIT: failCommit } : {}),
  };

  return {
    dir, releaseRoot, releases, stateFile, unitDir, target, rollback, fakeSystemctl, env,
    deploy: () => run('sh', [join(deployDir, 'controller.sh'), 'deploy', target, rollback], env),
    log: () => readFile(env.FAKE_LOG, 'utf8'),
  };
}

test('the switch installs the units of the release it selects', async () => {
  const drill = await deploymentDrill('avalon-switch-');
  const { env, fakeSystemctl, target, unitDir } = drill;

  // The bootstrap is the one file a release may not replace under itself.
  const installedBootstrap = join(env.AVALON_CONTROLLER_ROOT, 'bootstrap.sh');
  await mkdir(env.AVALON_CONTROLLER_ROOT, { recursive: true });
  await writeFile(installedBootstrap, '# an older bootstrap\n');

  assert.equal((await run(fakeSystemctl, ['--user', 'start', 'avalon'], env)).code, 0);
  try {
    const result = await drill.deploy();
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(await readlink(join(drill.releaseRoot, 'current')), `releases/${target}`);

    for (const unit of UNITS) {
      assert.equal(await readFile(join(unitDir, unit), 'utf8'), `# ${unit} from ${target}\n`,
        `${unit} comes from the release that was selected`);
      assert.equal((await lstat(join(unitDir, unit))).isSymbolicLink(), false);
    }

    const log = await drill.log();
    assert.match(log, /^daemon-reload$/m, 'systemd reads the new units before the restart');
    assert.match(log, /^try-restart avalon-listen$/m,
      'the listener picks up the deployed release copy of listen.mjs');

    assert.match(result.stderr, /differs from the bootstrap in/, 'drift is reported');
    assert.equal(await readFile(installedBootstrap, 'utf8'), '# an older bootstrap\n',
      'and never repaired behind the running deployment');
  } finally {
    await run(fakeSystemctl, ['--user', 'stop', 'avalon'], env);
  }
});

test('a failed target restores the previous release, snapshot, units, and healthy process', async () => {
  const drill = await deploymentDrill('avalon-rollback-', { failCommit: 'b'.repeat(40) });
  const { env, fakeSystemctl, rollback, stateFile, unitDir } = drill;

  assert.equal((await run(fakeSystemctl, ['--user', 'start', 'avalon'], env)).code, 0);
  try {
    const result = await drill.deploy();
    assert.equal(result.code, 1);
    assert.match(result.stderr, /rolling back/);
    assert.equal(await readlink(join(drill.releaseRoot, 'current')), `releases/${rollback}`);
    assert.equal(await readFile(stateFile, 'utf8'), 'original snapshot');
    assert.match(result.stdout, new RegExp(rollback));

    for (const unit of UNITS) {
      assert.equal(await readFile(join(unitDir, unit), 'utf8'), `# ${unit} from ${rollback}\n`,
        `${unit} is restored from the release actually being served`);
    }
  } finally {
    await run(fakeSystemctl, ['--user', 'stop', 'avalon'], env);
  }
});
