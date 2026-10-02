import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAdminApp, parseAdminUsers } from '../src/server/admin.ts';
import { RecentLogs } from '../src/server/logging.ts';
import { Rooms } from '../src/server/rooms.ts';
import { UiSettings } from '../src/server/ui-settings.ts';

async function withAdmin(
  fn: (base: string, settings: UiSettings) => Promise<void>,
  { now = Date.now, uiSettings, trustProxyOrigin = false }: {
    now?: () => number; uiSettings?: UiSettings; trustProxyOrigin?: boolean;
  } = {},
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
  const settings = uiSettings ?? new UiSettings({
    file: join(await mkdtemp(join(tmpdir(), 'avalon-admin-ui-')), 'ui-settings.json'),
    logger: () => {},
  });
  const server = createServer(createAdminApp({
    rooms,
    allowedUsers: parseAdminUsers(' Admin@Example.com '),
    metrics: { startedAt: now() - 65_000, snapshotHealthy: true, sseConnections: 3 },
    logs,
    uiSettings: settings,
    trustProxyOrigin,
    logger: () => {},
    deployedCommit: 'a'.repeat(40),
    now,
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('admin test server did not bind');
  try {
    await fn(`http://127.0.0.1:${address.port}`, settings);
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
    assert.equal(allowed.headers.get('referrer-policy'), 'same-origin');
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

test('admin status remains read-only', async () => {
  await withAdmin(async (base) => {
    const response = await fetch(`${base}/api/status`, { method: 'POST', headers: adminHeaders });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
  });
});

async function themeForm(base: string, theme = 'classic'): Promise<URLSearchParams> {
  const html = await (await fetch(base, { headers: adminHeaders })).text();
  const token = /name="csrf" value="([a-f0-9]{64})"/.exec(html)?.[1];
  assert.ok(token, 'the authenticated page issues a form token');
  return new URLSearchParams({ theme, csrf: token });
}

test('an authenticated theme form saves, redirects, and survives a restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'avalon-admin-theme-'));
  const file = join(directory, 'ui-settings.json');
  const uiSettings = new UiSettings({ file, logger: () => {} });
  await withAdmin(async (base) => {
    const form = await themeForm(base);
    const response = await fetch(`${base}/settings/theme`, {
      method: 'POST', headers: { ...adminHeaders, origin: base, 'sec-fetch-site': 'same-origin' },
      body: form, redirect: 'manual',
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/?theme=saved#appearance');
    assert.equal(uiSettings.current().theme, 'classic');
    assert.equal(new UiSettings({ file }).current().theme, 'classic');
    const status = await (await fetch(`${base}/api/status`, { headers: adminHeaders })).json();
    assert.equal(status.theme, 'classic');
    const html = await (await fetch(`${base}/?theme=saved`, { headers: adminHeaders })).text();
    assert.match(html, /Classic · Current/);
    assert.match(html, /role="status">Theme saved/);
  }, { uiSettings });
});

test('a trusted Unix-socket proxy preserves the browser origin when Host becomes localhost', async () => {
  await withAdmin(async (base, settings) => {
    const form = await themeForm(base);
    const send = (headers: Record<string, string>) => fetch(`${base}/settings/theme`, {
      method: 'POST', body: form, redirect: 'manual',
      headers: {
        ...adminHeaders, host: 'localhost', origin: 'https://admin.example.ts.net:9443',
        'sec-fetch-site': 'same-origin', 'x-forwarded-host': 'admin.example.ts.net:9443',
        'x-forwarded-proto': 'https', ...headers,
      },
    });
    for (const headers of [
      { origin: 'https://attacker.example' },
      { origin: 'http://admin.example.ts.net:9443' },
      { origin: 'https://admin.example.ts.net' },
      { origin: 'null' },
      { origin: 'https://admin.example.ts.net:9443/path' },
      { 'sec-fetch-site': 'same-site' },
      { 'sec-fetch-site': 'cross-site' },
      { 'x-forwarded-host': '' },
      { 'x-forwarded-host': 'admin.example.ts.net:9443, attacker.example' },
      { 'x-forwarded-host': 'admin.example.ts.net:9443/path' },
      { 'x-forwarded-host': 'user@admin.example.ts.net:9443' },
      { 'x-forwarded-proto': '' },
      { 'x-forwarded-proto': 'https, http' },
    ]) {
      assert.equal((await send(headers)).status, 403, JSON.stringify(headers));
    }
    assert.equal(settings.current().theme, 'crystal');
    const forged = new URLSearchParams(form);
    forged.set('csrf', 'forged');
    assert.equal((await fetch(`${base}/settings/theme`, {
      method: 'POST', body: forged, headers: {
        ...adminHeaders, host: 'localhost', origin: 'https://admin.example.ts.net:9443',
        'x-forwarded-host': 'admin.example.ts.net:9443', 'x-forwarded-proto': 'https',
      },
    })).status, 403);
    assert.equal((await send({})).status, 303);
    assert.equal(settings.current().theme, 'classic');
  }, { trustProxyOrigin: true });
});

test('untrusted forwarding headers cannot bypass direct admin origin checks', async () => {
  await withAdmin(async (base, settings) => {
    const response = await fetch(`${base}/settings/theme`, {
      method: 'POST', body: await themeForm(base), headers: {
        ...adminHeaders, origin: 'https://attacker.example',
        'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'https',
      },
    });
    assert.equal(response.status, 403);
    assert.equal(settings.current().theme, 'crystal');
  });
});

test('theme writes reject unauthenticated, cross-site, forged, and malformed forms', async () => {
  await withAdmin(async (base, settings) => {
    const form = await themeForm(base);
    const send = (body: URLSearchParams, headers: Record<string, string> = adminHeaders) =>
      fetch(`${base}/settings/theme`, { method: 'POST', headers, body, redirect: 'manual' });
    assert.equal((await send(form, {})).status, 403);
    assert.equal((await send(form, { ...adminHeaders, origin: 'https://attacker.example' })).status, 403);
    assert.equal((await send(form, { ...adminHeaders, origin: 'null' })).status, 403);
    assert.equal((await send(form, { ...adminHeaders, 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await send(new URLSearchParams({ theme: 'classic', csrf: 'forged' }))).status, 403);
    const unknown = new URLSearchParams(form);
    unknown.set('theme', 'arbitrary-css');
    assert.equal((await send(unknown)).status, 400);
    const duplicate = new URLSearchParams(form);
    duplicate.append('theme', 'crystal');
    assert.equal((await send(duplicate)).status, 400);
    const oversized = new URLSearchParams(form);
    oversized.set('extra', 'x'.repeat(2000));
    assert.equal((await send(oversized)).status, 413);
    assert.equal((await fetch(`${base}/settings/theme`, {
      method: 'POST', headers: { ...adminHeaders, 'content-type': 'application/json' }, body: '{}',
    })).status, 415);
    assert.equal(settings.current().theme, 'crystal');
  });
});

test('failed theme persistence never acknowledges or publishes the new theme', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'avalon-admin-failed-theme-'));
  const blocked = join(directory, 'not-a-directory');
  await writeFile(blocked, 'preserve');
  const uiSettings = new UiSettings({ file: join(blocked, 'ui-settings.json'), logger: () => {} });
  await withAdmin(async (base) => {
    const response = await fetch(`${base}/settings/theme`, {
      method: 'POST', headers: adminHeaders, body: await themeForm(base), redirect: 'manual',
    });
    assert.equal(response.status, 503);
    assert.match(await response.text(), /previous theme is still active/);
    assert.equal(uiSettings.current().theme, 'crystal');
  }, { uiSettings });
});
