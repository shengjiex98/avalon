import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access, chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const deployDir = fileURLToPath(new URL('../deploy/', import.meta.url));
const updater = join(deployDir, 'updater.sh');
const oldCommit = '1'.repeat(40);
const targetCommit = '2'.repeat(40);

function run(command, args, env = {}, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const manifest = (commit, stateVersion = 1, apiProtocol = 1, nodeMajor = 24) => ({
  commit,
  stateVersion,
  apiProtocol,
  nodeMajor,
  deployerSchema: 1,
});

async function writeRelease(root, commit, options = {}) {
  const release = join(root, commit);
  await mkdir(join(release, 'src'), { recursive: true });
  await mkdir(join(release, 'public'), { recursive: true });
  await mkdir(join(release, 'deploy'), { recursive: true });
  await writeFile(join(release, 'release.json'), JSON.stringify(
    options.manifest ?? manifest(commit, options.stateVersion, options.apiProtocol, options.nodeMajor),
  ));
  await writeFile(join(release, 'package.json'), '{}');
  await writeFile(join(release, 'src/server.js'), '// inert candidate server');
  await writeFile(join(release, 'public/index.html'), '<!doctype html>');
  // If the updater ever executes candidate control-plane code, this marker is
  // created and the fixture catches the trust-boundary regression.
  await writeFile(join(release, 'deploy/controller.sh'), `#!/bin/sh\nprintf pwned >"${options.marker ?? join(root, 'candidate-ran')}"\n`);
  await chmod(join(release, 'deploy/controller.sh'), 0o755);
  if (options.omit) await rm(join(release, options.omit));
  if (options.escapeSymlink) await symlink('../../outside', join(release, 'public', 'escape'));
  return release;
}

async function packRelease(artifacts, commit, options = {}) {
  const source = join(artifacts, 'source');
  await mkdir(source, { recursive: true });
  const release = await writeRelease(source, `avalon-${commit}`, {
    ...options,
    manifest: options.manifest ?? manifest(commit, options.stateVersion, options.apiProtocol, options.nodeMajor),
  });
  if (options.extraRoot) {
    await writeFile(join(source, 'unexpected-root'), 'not part of the derived release');
  }
  const archive = join(artifacts, `avalon-${commit}.tar.gz`);
  const names = [basename(release), ...(options.extraRoot ? ['unexpected-root'] : [])];
  const packed = await run('tar', ['-czf', archive, '-C', source, ...names]);
  assert.equal(packed.code, 0, packed.stderr);
  return { archive, digest: createHash('sha256').update(await readFile(archive)).digest('hex') };
}

async function writeTools(dir) {
  const bin = join(dir, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'node24'), `#!/bin/sh
if [ "\${1:-}" = -v ]; then echo v24.99.0; exit 0; fi
exec "${process.execPath}" "$@"
`);
  await chmod(join(bin, 'node24'), 0o755);
  await writeFile(join(bin, 'flock'), `#!/bin/sh
[ "\${LOCK_HELD:-0}" = 1 ] && exit 1
exit 0
`);
  await chmod(join(bin, 'flock'), 0o755);
  await writeFile(join(bin, 'curl'), `#!/bin/sh
set -eu
out=
write=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    -w) write=$2; shift 2 ;;
    -H|--retry|--connect-timeout|--max-time) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
printf '%s\n' "$url" >>"$CURL_LOG"
case "$url" in
  */latest.json\?t=*) cp "$ARTIFACTS/latest.json" "$out" ;;
  */avalon-*.tar.gz) cp "$ARTIFACTS/\${url##*/}" "$out" ;;
  */api/health/update)
    printf '{"ok":true,"updateSafe":%s}\n' "$( [ "$UPDATE_CODE" = 200 ] && echo true || echo false )" >"$out"
    [ -z "$write" ] || printf '%s' "$UPDATE_CODE"
    ;;
  */api/health)
    [ -f "$RUNNING_FILE" ] || exit 7
    running=$(cat "$RUNNING_FILE")
    if [ "$running" = malformed ]; then printf 'not json' >"$out"
    else printf '{"commit":"%s","stateVersion":%s,"protocol":%s,"activeGames":%s}\n' \
      "$running" "$RUNNING_STATE" "$RUNNING_PROTOCOL" "$ACTIVE_GAMES" >"$out"
    fi
    [ -z "$write" ] || printf 200
    ;;
  *) exit 22 ;;
esac
`);
  await chmod(join(bin, 'curl'), 0o755);
  await writeFile(join(bin, 'systemctl'), `#!/bin/sh
set -eu
[ "$1" = --user ] && shift
printf '%s\n' "$*" >>"$SYSTEMCTL_LOG"
case "$1" in
  stop) rm -f "$RUNNING_FILE" ;;
  start)
    commit=$("$REAL_NODE" -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1])).commit)' "$RELEASE_ROOT/current/release.json")
    if [ "$commit" = "\${FAIL_COMMIT:-}" ]; then
      printf corrupted >"$STATE_FILE"
      printf unhealthy >"$RUNNING_FILE"
    else printf '%s\n' "$commit" >"$RUNNING_FILE"
    fi
    ;;
  *) exit 64 ;;
esac
`);
  await chmod(join(bin, 'systemctl'), 0o755);
  return bin;
}

async function fixture(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'avalon-updater-'));
  const artifacts = join(dir, 'artifacts');
  const releaseRoot = join(dir, 'lib');
  const releases = join(releaseRoot, 'releases');
  const stateFile = join(dir, 'state', 'rooms.json');
  const runningFile = join(dir, 'running');
  const systemctlLog = join(dir, 'systemctl.log');
  const curlLog = join(dir, 'curl.log');
  await mkdir(artifacts);
  await mkdir(releases, { recursive: true });
  await mkdir(join(dir, 'state'));
  const bin = await writeTools(dir);

  let packed;
  if (options.archive !== false) {
    packed = await packRelease(artifacts, targetCommit, {
      marker: join(dir, 'candidate-ran'),
      ...(options.target ?? {}),
    });
  }
  const digest = options.digest ?? packed?.digest ?? 'a'.repeat(64);
  await writeFile(join(artifacts, 'latest.json'), options.pointerText ?? JSON.stringify({
    schema: 1,
    commit: targetCommit,
    sha256: digest,
  }));

  if (options.old !== false) {
    await writeRelease(releases, oldCommit);
    await symlink(`releases/${oldCommit}`, join(releaseRoot, 'current'));
    await writeFile(runningFile, options.running ?? oldCommit);
  }
  if (options.snapshot !== false) await writeFile(stateFile, 'good snapshot');

  const env = {
    HOME: dir,
    PATH: `${bin}:${process.env.PATH}`,
    AVALON_NODE: join(bin, 'node24'),
    AVALON_SYSTEMCTL: join(bin, 'systemctl'),
    AVALON_RELEASE_ROOT: releaseRoot,
    AVALON_ARTIFACT_BASE: 'https://artifacts.invalid',
    AVALON_STATE_FILE: stateFile,
    AVALON_HEALTH_TIMEOUT_SECONDS: '0.01',
    AVALON_KEEP_RELEASES: '2',
    PORT: '8420',
    ARTIFACTS: artifacts,
    RELEASE_ROOT: releaseRoot,
    STATE_FILE: stateFile,
    RUNNING_FILE: runningFile,
    SYSTEMCTL_LOG: systemctlLog,
    CURL_LOG: curlLog,
    UPDATE_CODE: String(options.updateCode ?? 409),
    RUNNING_STATE: String(options.runningState ?? 1),
    RUNNING_PROTOCOL: String(options.runningProtocol ?? 1),
    ACTIVE_GAMES: String(options.activeGames ?? 1),
    REAL_NODE: process.execPath,
  };
  return {
    dir, artifacts, releaseRoot, releases, stateFile, runningFile, systemctlLog, curlLog,
    marker: join(dir, 'candidate-ran'), env,
  };
}

async function reconcile(fix, args = [], env = {}) {
  return run('sh', [updater, 'reconcile', ...args], { ...fix.env, ...env });
}

test('a matching pointer prepares, seals, switches, and health-verifies the release', async () => {
  const fix = await fixture();
  const result = await reconcile(fix);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readlink(join(fix.releaseRoot, 'current')), `releases/${targetCommit}`);
  assert.equal(await readFile(fix.runningFile, 'utf8').then((v) => v.trim()), targetCommit);
  assert.equal(await readFile(fix.stateFile, 'utf8'), 'good snapshot');
  await assert.rejects(access(fix.marker));
  assert.match(await readFile(fix.curlLog, 'utf8'), /latest\.json\?t=\d+/);
});

test('download, pointer, digest, and manifest failures cannot change current', async () => {
  for (const options of [
    { archive: false },
    { pointerText: 'not json' },
    { digest: 'f'.repeat(64) },
    { target: { manifest: manifest('3'.repeat(40)) } },
    { target: { nodeMajor: 23 } },
    { target: { omit: 'public/index.html' } },
  ]) {
    const fix = await fixture(options);
    const result = await reconcile(fix);
    assert.notEqual(result.code, 0, JSON.stringify(options));
    assert.equal(await readlink(join(fix.releaseRoot, 'current')), `releases/${oldCommit}`);
  }
});

test('unexpected archive roots and escaping symlinks are rejected before activation', async () => {
  for (const target of [{ extraRoot: true }, { escapeSymlink: true }]) {
    const fix = await fixture({ target });
    const result = await reconcile(fix);
    assert.notEqual(result.code, 0, result.stderr);
    assert.equal(await readlink(join(fix.releaseRoot, 'current')), `releases/${oldCommit}`);
    assert.doesNotMatch(await readFile(fix.systemctlLog, 'utf8').catch(() => ''), /stop avalon/);
  }
});

test('an existing valid release is reused without downloading its archive', async () => {
  const fix = await fixture({ archive: false });
  await writeRelease(fix.releases, targetCommit);
  const result = await reconcile(fix);
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(await readFile(fix.curlLog, 'utf8'), /tar\.gz/);
});

test('an invalid existing release is rejected rather than replaced from the network', async () => {
  const fix = await fixture();
  await mkdir(join(fix.releases, targetCommit));
  const result = await reconcile(fix);
  assert.notEqual(result.code, 0);
  assert.equal(await readlink(join(fix.releaseRoot, 'current')), `releases/${oldCommit}`);
});

test('an exact selected target already serving is a download-free no-op', async () => {
  const fix = await fixture({ archive: false, old: false });
  await writeRelease(fix.releases, targetCommit);
  await symlink(`releases/${targetCommit}`, join(fix.releaseRoot, 'current'));
  await writeFile(fix.runningFile, targetCommit);
  const result = await reconcile(fix);
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await readFile(fix.systemctlLog, 'utf8').catch(() => '')).trim(), '');
});

test('compatible active games deploy while either incompatible version defers', async () => {
  const compatible = await fixture({ activeGames: 1 });
  assert.equal((await reconcile(compatible)).code, 0);

  for (const options of [
    { runningState: 2, runningProtocol: 1 },
    { runningState: 1, runningProtocol: 2 },
    { runningState: 'null', runningProtocol: 1 },
  ]) {
    const fix = await fixture(options);
    const result = await reconcile(fix);
    assert.equal(result.code, 75, result.stderr);
    assert.equal(await readlink(join(fix.releaseRoot, 'current')), `releases/${oldCommit}`);
    assert.doesNotMatch(await readFile(fix.systemctlLog, 'utf8').catch(() => ''), /stop avalon/);
  }
});

test('an incompatible idle server may deploy and a malformed health response fails closed', async () => {
  const idle = await fixture({ runningState: 2, runningProtocol: 2, activeGames: 0, updateCode: 200 });
  assert.equal((await reconcile(idle)).code, 0);

  const malformed = await fixture({ running: 'malformed' });
  const result = await reconcile(malformed);
  assert.notEqual(result.code, 0);
  assert.doesNotMatch(await readFile(malformed.systemctlLog, 'utf8').catch(() => ''), /stop avalon/);
});

test('a server proven unavailable can be recovered without a rollback release', async () => {
  const fix = await fixture({ old: false, snapshot: false });
  const result = await reconcile(fix);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readlink(join(fix.releaseRoot, 'current')), `releases/${targetCommit}`);
});

test('explicit --force bypasses only the compatibility gate', async () => {
  const fix = await fixture({ runningState: 2, runningProtocol: 2, activeGames: 1 });
  const result = await reconcile(fix, ['--force']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /operator forced/);
  assert.doesNotMatch(await readFile(fix.curlLog, 'utf8'), /health\/update/);
});

test('lock contention coalesces reconciliations before pointer download', async () => {
  const fix = await fixture();
  const result = await reconcile(fix, [], { LOCK_HELD: '1' });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /already in flight/);
  assert.equal((await readFile(fix.curlLog, 'utf8').catch(() => '')).trim(), '');
});

test('target health failure restores the old code and snapshot', async () => {
  const fix = await fixture();
  const result = await reconcile(fix, [], { FAIL_COMMIT: targetCommit });
  assert.notEqual(result.code, 0);
  assert.equal(await readlink(join(fix.releaseRoot, 'current')), `releases/${oldCommit}`);
  assert.equal(await readFile(fix.stateFile, 'utf8'), 'good snapshot');
  assert.equal(await readFile(fix.runningFile, 'utf8').then((v) => v.trim()), oldCommit);
  const log = await readFile(fix.systemctlLog, 'utf8');
  assert.match(log, /stop avalon\nstart avalon\nstop avalon\nstart avalon/);
});

test('snapshot backup happens after stop and the pointer switch is atomic by construction', async () => {
  const source = await readFile(updater, 'utf8');
  const stop = source.indexOf('"$systemctl_bin" --user stop avalon');
  const copy = source.indexOf('cp -p "$state_file" "$backup_dir/rooms.json"');
  const select = source.indexOf('select_release "$commit"');
  assert.ok(stop !== -1 && stop < copy && copy < select);
  assert.match(source, /fs\.renameSync\(process\.argv\[1\], process\.argv\[2\]\)/);
  assert.doesNotMatch(source, /"\$release\/deploy\//, 'candidate deployment scripts are never executed');
});

test('the installer atomically installs only static files and never starts a deployment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'avalon-updater-install-'));
  const root = join(dir, 'controller');
  const units = join(dir, 'units');
  const env = { AVALON_CONTROLLER_ROOT: root, AVALON_SYSTEMD_USER_DIR: units, HOME: dir };
  for (let i = 0; i < 2; i += 1) {
    const result = await run('sh', [join(deployDir, 'install-updater.sh')], env);
    assert.equal(result.code, 0, result.stderr);
  }
  assert.equal((await readFile(join(root, 'updater.sh'), 'utf8')), await readFile(updater, 'utf8'));
  assert.equal((await readFile(join(root, 'verify-pointer.mjs'), 'utf8')), await readFile(join(deployDir, 'verify-pointer.mjs'), 'utf8'));
  assert.equal((await readFile(join(root, 'listen.mjs'), 'utf8')), await readFile(join(deployDir, 'listen.mjs'), 'utf8'));
  for (const unit of ['avalon.service', 'avalon-listen.service', 'avalon-update.service', 'avalon-update.timer']) {
    assert.equal(await readFile(join(units, unit), 'utf8'), await readFile(join(deployDir, 'static', unit), 'utf8'));
  }
  await assert.rejects(access(join(units, 'avalon-update@.service')));
});
