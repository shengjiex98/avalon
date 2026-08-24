import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { createApp } from '../src/server.js';
import { Rooms } from '../src/rooms.js';
import * as onuw from '../src/games/onuw/game.js';

async function withServer(fn, options = {}) {
  const server = createServer(createApp(options));
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

test('serves pre-generated announcement audio with the right media type', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/audio/onuw/zh/wake-seer.mp3');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/mpeg');
    assert.ok(Number(res.headers.get('content-length')) > 1_000);
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

test('a stale event stream gets a clean error without crashing the server', async () => {
  await withServer(async (base) => {
    const stale = await fetch(`${base}/api/rooms/ZZZZ/events?playerId=gone`);
    assert.equal(stale.status, 400);
    assert.equal((await stale.json()).error, 'noSuchRoom');

    const health = await fetch(base + '/api/health');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, 'avalon');
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

test('a room can be created for either game', async () => {
  await withServer(async (base) => {
    const { code } = await (await post(base, '/api/rooms', { game: 'onuw' })).json();
    const playerId = (await (await post(base, `/api/rooms/${code}/join`, { name: 'Ann' })).json()).playerId;

    const abort = new AbortController();
    const view = (await views(base, code, playerId, abort.signal).next()).value;
    abort.abort();
    assert.equal(view.gameId, 'onuw');
    assert.equal(view.phase, 'lobby');

    const bogus = await post(base, '/api/rooms', { game: 'chess' });
    assert.equal((await bogus.json()).error, 'noSuchGame');
  });
});

test('the host switches the room between games, and nobody else can', async () => {
  await withServer(async (base) => {
    const { code } = await (await post(base, '/api/rooms')).json();
    const ann = (await (await post(base, `/api/rooms/${code}/join`, { name: 'Ann' })).json()).playerId;
    const bob = (await (await post(base, `/api/rooms/${code}/join`, { name: 'Bob' })).json()).playerId;

    const act = (playerId, body) => post(base, `/api/rooms/${code}/action`, { playerId, ...body });
    const viewOf = async (playerId) => {
      const abort = new AbortController();
      const v = (await views(base, code, playerId, abort.signal).next()).value;
      abort.abort();
      return v;
    };

    const refused = await act(bob, { type: 'setGame', game: 'onuw' });
    assert.equal((await refused.json()).error, 'hostOnly');

    assert.equal((await act(ann, { type: 'setGame', game: 'onuw' })).status, 200);
    const after = await viewOf(bob);
    assert.equal(after.gameId, 'onuw', 'everyone sees the switch');
    assert.deepEqual(after.players.map((p) => p.name), ['Ann', 'Bob'], 'the table is kept');
    assert.equal(after.hostId, ann);
  });
});

test('a three player werewolf game plays through over the wire', async () => {
  // The night runs on a real clock, so the test owns the room registry and
  // winds it forward rather than sitting through ninety seconds.
  const rooms = new Rooms();
  const skipNight = (code) => rooms.apply(code, (g) => onuw.tick(g, Date.now() + 10 * 60_000));

  await withServer(async (base) => {
    const { code } = await (await post(base, '/api/rooms', { game: 'onuw' })).json();
    const ids = [];
    for (const name of ['Ann', 'Bob', 'Cai']) {
      ids.push((await (await post(base, `/api/rooms/${code}/join`, { name })).json()).playerId);
    }
    const act = (playerId, body) => post(base, `/api/rooms/${code}/action`, { playerId, ...body });
    const viewOf = async (playerId) => {
      const abort = new AbortController();
      const v = (await views(base, code, playerId, abort.signal).next()).value;
      abort.abort();
      return v;
    };

    assert.equal((await act(ids[0], { type: 'start' })).status, 200);
    let view = await viewOf(ids[0]);
    assert.equal(view.phase, 'reveal');
    assert.ok(view.you.role, 'each player is dealt a card');
    assert.equal(view.centre, null, 'the centre is face down');
    assert.equal(view.night, null, 'the clock waits while roles are being read');

    for (const id of ids.slice(0, -1)) assert.equal((await act(id, { type: 'confirm' })).status, 200);
    view = await viewOf(ids[0]);
    assert.equal(view.phase, 'reveal', 'the game waits for the final player');
    assert.deepEqual(view.waitingFor, [ids.at(-1)]);

    assert.equal((await act(ids.at(-1), { type: 'confirm' })).status, 200);
    view = await viewOf(ids[0]);
    assert.equal(view.phase, 'night');
    assert.equal(view.night.key, 'nightfall', 'the night opens with everyone closing their eyes');
    assert.ok(view.night.msLeft > 0, 'and a clock the whole room shares');

    // Nobody can be identified by what the night is waiting on.
    for (const id of ids) {
      const mine = await viewOf(id);
      assert.deepEqual(mine.waitingFor, []);
      assert.ok(mine.players.every((p) => p.acted === undefined));
    }

    skipNight(code);
    view = await viewOf(ids[0]);
    assert.equal(view.phase, 'day');
    assert.equal(view.night, null);

    await act(ids[0], { type: 'startVote' });
    await act(ids[0], { type: 'vote', target: ids[1] });
    await act(ids[1], { type: 'vote', target: ids[2] });
    await act(ids[2], { type: 'vote', target: ids[1] });

    view = await viewOf(ids[0]);
    assert.equal(view.phase, 'over');
    assert.deepEqual(view.dead, [ids[1]]);
    assert.equal(view.centre.length, 3, 'everything is revealed');
    assert.ok(view.players.every((p) => p.startRole && p.finalRole));
  }, { rooms });
});
