import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { createAdminApp, parseAdminUsers } from '../src/server/admin.ts';
import { Rooms } from '../src/server/rooms.ts';

async function withAdmin(
  fn: (base: string) => Promise<void>,
  { now = Date.now }: { now?: () => number } = {},
): Promise<void> {
  const rooms = new Rooms({ now });
  const code = rooms.create('avalon', { code: 'ABCD' });
  rooms.dispatch(code, 'private-player-id', {
    type: 'join', id: 'private-player-id', name: 'Private Player',
  });
  const unsubscribe = rooms.subscribe(code, 'private-player-id', () => {});
  const server = createServer(createAdminApp({
    rooms,
    allowedUsers: parseAdminUsers(' Admin@Example.com '),
    metrics: { startedAt: now() - 65_000, snapshotHealthy: true, sseConnections: 3 },
    deployedCommit: 'a'.repeat(40),
    now,
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('admin test server did not bind');
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    unsubscribe();
    server.close();
    await once(server, 'close');
  }
}

const adminHeaders = { 'tailscale-user-login': 'admin@example.com' };

test('admin access requires an explicitly allowed Tailscale identity', async () => {
  await withAdmin(async (base) => {
    const missing = await fetch(base);
    assert.equal(missing.status, 403);
    assert.equal(missing.headers.get('cache-control'), 'no-store');

    const stranger = await fetch(base, { headers: { 'tailscale-user-login': 'other@example.com' } });
    assert.equal(stranger.status, 403);

    const allowed = await fetch(base, { headers: adminHeaders });
    assert.equal(allowed.status, 200);
    assert.match(allowed.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    const html = await allowed.text();
    assert.match(html, /Avalon Admin/);
    assert.match(html, /<div class="label">Commit<\/div><div class="value"><code>a{7}<\/code><\/div>/);
    assert.doesNotMatch(html, /<code>a{8,}<\/code>/);
  });
});

test('admin status exposes operational metadata but no player identity or engine state', async () => {
  const now = () => Date.parse('2026-09-01T12:00:00Z');
  await withAdmin(async (base) => {
    const response = await fetch(`${base}/api/status`, { headers: adminHeaders });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.uptimeSeconds, 65);
    assert.equal(status.snapshot, 'healthy');
    assert.equal(status.sseConnections, 3);
    assert.equal(status.activeGames, 0);
    assert.deepEqual(status.rooms, [{
      code: 'ABCD',
      game: 'avalon',
      phase: 'lobby',
      players: 1,
      connections: 1,
      touchedAt: '2026-09-01T12:00:00.000Z',
    }]);
    const body = JSON.stringify(status);
    assert.doesNotMatch(body, /Private Player|private-player-id|hostId|gameState|roles/);
  }, { now });
});

test('admin console is read-only', async () => {
  await withAdmin(async (base) => {
    const response = await fetch(`${base}/api/status`, { method: 'POST', headers: adminHeaders });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
  });
});
