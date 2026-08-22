// Guards for the split deployment: the front end on GitHub Pages, the game
// server somewhere else. Both halves have to keep holding up their end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';

import { createApp } from '../src/server.js';

const PAGES = 'https://someone.github.io';
const read = (rel) => readFile(new URL(rel, import.meta.url), 'utf8');

async function withServer(options, fn) {
  const server = createServer(createApp(options));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('the health probe tells a remote front end the server is real', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(base + '/api/health');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, 'avalon', 'the client checks this before offering a lobby');
  });
});

test('an allowed origin gets a CORS header, and others do not', async () => {
  await withServer({ allowedOrigins: [PAGES] }, async (base) => {
    const allowed = await fetch(base + '/api/health', { headers: { origin: PAGES } });
    assert.equal(allowed.headers.get('access-control-allow-origin'), PAGES);
    assert.match(allowed.headers.get('vary') ?? '', /origin/i);

    const stranger = await fetch(base + '/api/health', { headers: { origin: 'https://evil.example' } });
    assert.equal(stranger.headers.get('access-control-allow-origin'), null);
  });
});

test('a trailing slash on the configured origin does not break the match', async () => {
  await withServer({ allowedOrigins: [PAGES] }, async (base) => {
    const res = await fetch(base + '/api/health', { headers: { origin: PAGES + '/' } });
    assert.equal(res.headers.get('access-control-allow-origin'), PAGES);
  });
});

test('preflight is answered so cross-origin POSTs can go through', async () => {
  await withServer({ allowedOrigins: [PAGES] }, async (base) => {
    const res = await fetch(base + '/api/rooms', {
      method: 'OPTIONS',
      headers: { origin: PAGES, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), PAGES);
    assert.match(res.headers.get('access-control-allow-methods'), /POST/);
    assert.match(res.headers.get('access-control-allow-headers'), /content-type/);
  });
});

test('with no allowlist the API stays same-origin only', async () => {
  await withServer({ allowedOrigins: [] }, async (base) => {
    const res = await fetch(base + '/api/health', { headers: { origin: PAGES } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
});

test('a cross-origin room can be created and streamed', async () => {
  await withServer({ allowedOrigins: ['*'] }, async (base) => {
    const created = await fetch(base + '/api/rooms', { method: 'POST', headers: { origin: PAGES } });
    assert.equal(created.headers.get('access-control-allow-origin'), PAGES);
    const { code } = await created.json();

    const joined = await fetch(`${base}/api/rooms/${code}/join`, {
      method: 'POST',
      headers: { origin: PAGES, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ann' }),
    });
    const { playerId } = await joined.json();

    // EventSource cannot set headers, so the SSE response itself must carry CORS.
    const abort = new AbortController();
    const stream = await fetch(`${base}/api/rooms/${code}/events?playerId=${playerId}`, {
      headers: { origin: PAGES }, signal: abort.signal,
    });
    assert.equal(stream.headers.get('access-control-allow-origin'), PAGES);
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);
    abort.abort();
  });
});

test('the page loads its assets relatively, so a /<repo>/ subpath works', async () => {
  const html = await read('../public/index.html');
  const absolute = [...html.matchAll(/(?:src|href)="(\/[^/][^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(absolute, [], 'GitHub Pages serves a project site from a subpath');
  assert.match(html, /src="\.\/app\.js"/);
});

test('the connection banner lives outside the top bar', async () => {
  // Inside the header it wrapped the row and pushed the language button onto
  // a second line the moment the connection dropped.
  const html = await read('../public/index.html');
  const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  assert.ok(!header.includes('id="conn"'), 'the banner must not sit in the header');
  assert.match(html, /<div id="conn" class="conn-banner"/);
});

test('the client reaches the API through the configured base, never a bare path', async () => {
  const source = await read('../public/app.js');
  const bare = [...source.matchAll(/(?:fetch|EventSource)\(\s*[`'"]\/api/g)];
  assert.deepEqual(bare.map((m) => m[0]), [], 'a hardcoded /api path breaks the Pages build');
});

test('the shipped config defaults to same origin', async () => {
  const { API_BASE } = await import('../public/config.js');
  assert.equal(API_BASE, '', 'self-hosting must work with no configuration');
});

test('the deploy workflow publishes the front end and gates on the tests', async () => {
  const workflow = await read('../.github/workflows/pages.yml');
  assert.match(workflow, /npm test/, 'do not publish a build the tests reject');
  assert.match(workflow, /API_BASE/, 'the backend address has to be injected');
  assert.match(workflow, /actions\/deploy-pages/);
  assert.match(workflow, /path:\s*public/, 'only the front end is published');
});
