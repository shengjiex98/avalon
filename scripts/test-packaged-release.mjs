import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [, , releaseDirectory, expectedCommit] = process.argv;
if (!releaseDirectory || !/^[0-9a-f]{40}$/.test(expectedCommit ?? '')) {
  console.error('Usage: test-packaged-release.mjs <release-directory> <40-character-commit>');
  process.exit(64);
}

const release = resolve(releaseDirectory);
const stateDirectory = await mkdtemp(join(tmpdir(), 'avalon-artifact-state-'));
const stateFile = join(stateDirectory, 'rooms.json');
const installDirectory = await mkdtemp(join(tmpdir(), 'avalon-artifact-install-'));
const current = join(installDirectory, 'current');
await symlink(release, current, 'dir');
let running;

try {
  running = await startRelease();
  const firstHealth = await json(running.base, '/api/health');
  assert(firstHealth.commit === expectedCommit, 'packaged health reports the wrong commit');
  assert(firstHealth.rooms === 0, 'fresh packaged server did not start empty');

  const index = await fetch(running.base + '/');
  assert(index.ok && (await index.text()).includes('<title>Avalon</title>'), 'packaged static entry did not load');
  const bootstrap = await fetch(running.base + '/bootstrap.js');
  assert(bootstrap.ok && (bootstrap.headers.get('content-type') ?? '').includes('text/javascript'),
    'packaged browser entry did not load as JavaScript');

  const created = await post(running.base, '/api/rooms', { game: 'avalon' });
  const joined = await post(running.base, `/api/rooms/${created.code}/join`, { name: 'Artifact Host' });
  const action = await post(running.base, `/api/rooms/${created.code}/action`, {
    type: 'options', playerId: joined.playerId, options: { percival: true },
  });
  assert(action.ok === true, 'packaged HTTP action failed');
  const view = await nextView(running.base, created.code, joined.playerId);
  assert(view.gameId === 'avalon' && view.phase === 'lobby' && view.options?.percival === true,
    'packaged event view did not reflect the HTTP action');
  const update = await fetch(running.base + '/api/health/update');
  assert(update.status === 200, 'packaged deployment gate rejected a lobby');

  await stopRelease(running);
  running = await startRelease();
  const restoredHealth = await json(running.base, '/api/health');
  assert(restoredHealth.rooms === 1, 'packaged server did not restore its snapshot');
  const probe = await json(running.base, `/api/rooms/${created.code}?playerId=${joined.playerId}`);
  assert(probe.exists === true && probe.seated === true, 'restored packaged room lost its seat');
  const restored = await nextView(running.base, created.code, joined.playerId);
  assert(restored.options?.percival === true, 'restored packaged view lost its action state');

  process.stdout.write('packaged release startup, HTTP, view, and snapshot checks passed\n');
} catch (error) {
  console.error(`packaged release behavior failed: ${error.message}`);
  if (running?.logs) console.error(running.logs());
  process.exitCode = 65;
} finally {
  if (running) await stopRelease(running);
}

async function startRelease() {
  const port = await availablePort();
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, [join(current, 'src/server/main.ts')], {
    cwd: current,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      AVALON_STATE_FILE: stateFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const instance = { child, base: `http://127.0.0.1:${port}`, logs: () => stdout + stderr };

  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`server exited during startup (${child.exitCode})`);
    try {
      const response = await fetch(instance.base + '/api/health');
      if (response.ok) return instance;
    } catch { /* startup is still in progress */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  child.kill('SIGKILL');
  throw new Error('server did not become healthy');
}

async function stopRelease(instance) {
  if (instance.child.exitCode !== null) return;
  instance.child.kill('SIGTERM');
  const closed = once(instance.child, 'close');
  let timer;
  const timeout = new Promise((resolveTimeout) => {
    timer = setTimeout(resolveTimeout, 5_000, 'timeout');
  });
  const result = await Promise.race([closed, timeout]);
  clearTimeout(timer);
  if (result === 'timeout') {
    instance.child.kill('SIGKILL');
    await once(instance.child, 'close');
  }
}

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  server.close();
  await once(server, 'close');
  return port;
}

async function post(base, path, body) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  assert(response.ok, `${path} returned ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function json(base, path) {
  const response = await fetch(base + path);
  assert(response.ok, `${path} returned ${response.status}`);
  return response.json();
}

async function nextView(base, code, playerId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${base}/api/rooms/${code}/events?playerId=${playerId}`, {
      signal: controller.signal,
    });
    assert(response.ok && response.body, `event view returned ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error('event stream ended before a view arrived');
      pending += decoder.decode(value, { stream: true });
      const match = /(?:^|\n)data: (.+)\n\n/.exec(pending);
      if (match) {
        await reader.cancel();
        return JSON.parse(match[1]);
      }
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
