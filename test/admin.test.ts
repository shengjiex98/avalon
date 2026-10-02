import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { createAdminApp, parseAdminUsers } from '../src/server/admin.ts';
import { RecentLogs } from '../src/server/logging.ts';
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
  const logs = new RecentLogs({ now });
  logs.append('info', 'game.started', { game: 'avalon' });
  logs.append('info', 'api.request', {
    requestId: 'successful-request', method: 'GET', route: '/api/health', status: 200, durationMs: 1.2,
  });
  logs.append('info', 'api.request', {
    requestId: 'missing-request', method: 'GET', route: '/api/unknown', status: 404, durationMs: 2.3,
  });
  logs.append('info', 'snapshot.load', { outcome: 'discarded', rooms: 0 });
  logs.append('error', 'snapshot.save', { outcome: 'failed', error: 'Error' });
  const server = createServer(createAdminApp({
    rooms,
    allowedUsers: parseAdminUsers(' Admin@Example.com '),
    metrics: { startedAt: now() - 65_000, snapshotHealthy: true, sseConnections: 3 },
    logs,
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
    assert.match(html, /game\.started/);
    assert.doesNotMatch(html, /api\.request/);
    assert.match(html, /aria-current="page">Activity<\/a>/);
  });
});

test('admin logs can be filtered by purpose and use text alongside color', async () => {
  await withAdmin(async (base) => {
    const problems = await fetch(`${base}/?view=problems&limit=25`, { headers: adminHeaders });
    const problemsHtml = await problems.text();
    assert.match(problemsHtml, /class="log error"[\s\S]*?<span class="badge">ERROR<\/span>[\s\S]*?snapshot\.save/);
    assert.match(problemsHtml, /class="log warn"[\s\S]*?<span class="badge">WARN<\/span>[\s\S]*?snapshot\.load/);
    assert.match(problemsHtml, /api\.request/);
    assert.match(problemsHtml, /status<\/span> 404/);
    assert.doesNotMatch(problemsHtml, /successful-request/);
    assert.match(problemsHtml, /aria-current="page">Problems<\/a>/);
    assert.match(problemsHtml, /aria-current="page">25<\/a>/);

    const requests = await fetch(`${base}/?view=requests`, { headers: adminHeaders });
    const requestsHtml = await requests.text();
    assert.match(requestsHtml, /successful-request/);
    assert.match(requestsHtml, /missing-request/);
    assert.doesNotMatch(requestsHtml, /game\.started|snapshot\.save/);
  });
});

test('admin log API returns the selected bounded view', async () => {
  await withAdmin(async (base) => {
    const response = await fetch(`${base}/api/logs?view=problems&limit=25`, { headers: adminHeaders });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.view, 'problems');
    assert.equal(payload.limit, 25);
    assert.deepEqual(payload.records.map((record: { event: string }) => record.event), [
      'snapshot.save', 'snapshot.load', 'api.request',
    ]);
    const body = JSON.stringify(payload);
    assert.doesNotMatch(body, /Private Player|private-player-id|hostId|gameState|roles/);
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
