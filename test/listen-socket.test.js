// LISTEN_SOCKET: the server answers on a Unix socket instead of TCP, which is
// how a host proxy that cannot reach loopback reaches it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const entry = fileURLToPath(new URL('../build/server/main.mjs', import.meta.url));

function health(socketPath) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/api/health' }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForHealth(socketPath, child) {
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
    try {
      return await health(socketPath);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error('server never answered on its socket');
}

test('LISTEN_SOCKET serves the API on a Unix socket and replaces a stale one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'avalon-socket-'));
  const socketPath = join(dir, 'sockets', 'avalon.sock');
  const env = {
    ...process.env,
    LISTEN_SOCKET: socketPath,
    AVALON_STATE_FILE: join(dir, 'state', 'rooms.json'),
    ADMIN_USERS: '',
  };
  try {
    for (let round = 0; round < 2; round += 1) {
      const child = spawn(process.execPath, [entry], { env, stdio: 'ignore' });
      try {
        const result = await waitForHealth(socketPath, child);
        assert.equal(result.status, 200);
        assert.equal(JSON.parse(result.body).ok, true);
      } finally {
        // SIGKILL leaves the socket file behind, which the next round must
        // replace rather than fail on.
        child.kill('SIGKILL');
        await new Promise((resolve) => child.once('exit', resolve));
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
