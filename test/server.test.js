import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { createApp } from '../src/server.js';

async function withServer(fn) {
  const server = createServer(createApp());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

const post = (base, path, body) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

/** Read SSE frames from a room as an async iterator of parsed views. */
async function* views(base, code, playerId, signal) {
  const res = await fetch(`${base}/api/rooms/${code}/events?playerId=${playerId}`, { signal });
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += Buffer.from(chunk).toString('utf8');
    let split;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      if (frame.startsWith('data: ')) yield JSON.parse(frame.slice(6));
    }
  }
}

test('serves the client', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /<title>Avalon<\/title>/);
  });
});

test('refuses to walk out of the public directory', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/../src/server.js', { redirect: 'manual' });
    assert.notEqual(res.status, 200);
  });
});

test('a room round-trips create, join and reconnect', async () => {
  await withServer(async (base) => {
    const { code } = await (await post(base, '/api/rooms')).json();
    assert.match(code, /^[A-Z2-9]{4}$/);
    assert.deepEqual(await (await fetch(`${base}/api/rooms/${code}`)).json(), { exists: true });
    assert.deepEqual(await (await fetch(`${base}/api/rooms/ZZZZ`)).json(), { exists: false });

    const first = await (await post(base, `/api/rooms/${code}/join`, { name: 'Ann' })).json();
    assert.ok(first.playerId);

    // Rejoining with the stored id keeps one seat, not two.
    const again = await (await post(base, `/api/rooms/${code}/join`, { name: 'Ann', playerId: first.playerId })).json();
    assert.equal(again.playerId, first.playerId);

    const dup = await post(base, `/api/rooms/${code}/join`, { name: 'ann' });
    assert.equal(dup.status, 400);
    assert.equal((await dup.json()).error, 'nameTaken');
  });
});

test('game errors come back as translatable keys, not prose', async () => {
  await withServer(async (base) => {
    const { code } = await (await post(base, '/api/rooms')).json();
    const { playerId } = await (await post(base, `/api/rooms/${code}/join`, { name: 'Ann' })).json();

    const early = await post(base, `/api/rooms/${code}/action`, { type: 'start', playerId });
    assert.equal(early.status, 400);
    assert.deepEqual(await early.json(), { error: 'needMorePlayers', params: { min: 5 } });

    const bogus = await post(base, `/api/rooms/${code}/action`, { type: 'nope', playerId });
    assert.equal((await bogus.json()).error, 'unknownAction');

    const stranger = await post(base, `/api/rooms/${code}/action`, { type: 'start', playerId: 'not-a-player' });
    assert.equal((await stranger.json()).error, 'notInGame');

    const missing = await post(base, '/api/rooms/ZZZZ/join', { name: 'Ann' });
    assert.equal((await missing.json()).error, 'noSuchRoom');
  });
});

test('an action pushes a fresh view to every subscriber', async () => {
  await withServer(async (base) => {
    const { code } = await (await post(base, '/api/rooms')).json();
    const ann = (await (await post(base, `/api/rooms/${code}/join`, { name: 'Ann' })).json()).playerId;

    const abort = new AbortController();
    const stream = views(base, code, ann, abort.signal);

    const first = (await stream.next()).value;
    assert.equal(first.players.length, 1);
    assert.equal(first.phase, 'lobby');

    await post(base, `/api/rooms/${code}/join`, { name: 'Bob' });
    const second = (await stream.next()).value;
    assert.deepEqual(second.players.map((p) => p.name), ['Ann', 'Bob']);

    await post(base, `/api/rooms/${code}/action`, { type: 'options', playerId: ann, options: { percival: true } });
    const third = (await stream.next()).value;
    assert.equal(third.options.percival, true);

    abort.abort();
  });
});

test('a five player game plays through over the wire', async () => {
  await withServer(async (base) => {
    const { code } = await (await post(base, '/api/rooms')).json();
    const ids = [];
    for (const name of ['Ann', 'Bob', 'Cai', 'Dee', 'Eli']) {
      ids.push((await (await post(base, `/api/rooms/${code}/join`, { name })).json()).playerId);
    }
    const act = (playerId, type, extra) => post(base, `/api/rooms/${code}/action`, { type, playerId, ...extra });
    const viewOf = async (playerId) => {
      const abort = new AbortController();
      const v = (await views(base, code, playerId, abort.signal).next()).value;
      abort.abort();
      return v;
    };

    assert.equal((await act(ids[0], 'start')).status, 200);
    for (const id of ids) await act(id, 'confirm');

    let view = await viewOf(ids[0]);
    assert.equal(view.phase, 'team');
    assert.equal(view.teamSize, 2);
    assert.equal(view.evilCount, 2);
    assert.ok(view.you.role, 'each player learns their own role');

    const leader = view.players.find((p) => p.isLeader);
    const team = view.players.slice(0, 2).map((p) => p.id);
    await act(leader.id, 'propose', { team });
    for (const id of ids) await act(id, 'vote', { approve: true });

    view = await viewOf(ids[0]);
    assert.equal(view.phase, 'quest');
    assert.deepEqual(view.team, team);

    for (const id of team) await act(id, 'card', { success: true });
    view = await viewOf(ids[0]);
    assert.equal(view.quests.length, 1);
    assert.equal(view.quests[0].success, true);
    assert.equal(view.round, 1);
    assert.equal(view.phase, 'team');
  });
});
