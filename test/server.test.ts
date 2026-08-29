import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { API_PROTOCOL } from '../src/api-protocol.ts';
import { CLIENT_ORIGIN, createApp } from '../src/server.ts';
import { Rooms } from '../src/rooms.ts';
import { STATE_VERSION } from '../src/state-version.ts';
import * as onuw from '../src/games/onuw/game.ts';
import type { GameContext, OnuwContext, PublicView } from '../src/contracts/types.ts';

type AppOptions = NonNullable<Parameters<typeof createApp>[0]>;
type JsonRecord = Record<string, unknown>;
const isOnuwContext = (context: GameContext): context is OnuwContext =>
  context.room.game.id === 'onuw';

async function withServer(fn: (base: string) => Promise<void>, options: AppOptions = {}): Promise<void> {
  const server = createServer(createApp(options));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await fn(base);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

const post = (base: string, path: string, body?: unknown): Promise<Response> =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

const postText = (base: string, path: string, body: string, contentType = 'application/json'): Promise<Response> =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': contentType }, body });

/** Read SSE frames from a room as an async iterator of parsed views. */
async function* views(
  base: string,
  code: string,
  playerId: string,
  signal: AbortSignal,
): AsyncGenerator<PublicView> {
  const res = await fetch(`${base}/api/rooms/${code}/events?playerId=${playerId}`, { signal });
  let buffer = '';
  if (!res.body) throw new Error('event stream has no body');
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

async function nextView(stream: AsyncGenerator<PublicView>): Promise<PublicView> {
  const next = await stream.next();
  if (next.done) throw new Error('event stream ended before its first view');
  return next.value;
}

test('serves the client', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await res.text(), /<title>Avalon<\/title>/);
  });
});

test('serves an uncached local front-end version', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/version.json');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match((await res.json()).version, /^local-[a-z0-9]+$/);
  });
});

test('advertises one API protocol to the supported Pages client', async () => {
  await withServer(async (base) => {
    const health = await fetch(base + '/api/health', { headers: { origin: CLIENT_ORIGIN } });
    assert.equal(health.headers.get('access-control-allow-origin'), CLIENT_ORIGIN);
    const status = await health.json();
    assert.equal(status.protocol, API_PROTOCOL);
    assert.equal(status.stateVersion, STATE_VERSION);

    const preflight = await fetch(base + '/api/rooms', {
      method: 'OPTIONS',
      headers: { origin: CLIENT_ORIGIN, 'access-control-request-method': 'POST' },
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /POST/);

    const stranger = await fetch(base + '/api/health', { headers: { origin: 'https://example.com' } });
    assert.equal(stranger.headers.get('access-control-allow-origin'), null);
    assert.match(stranger.headers.get('vary') ?? '', /origin/);
  });
});

test('the update health check permits lobbies but blocks active games', async () => {
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const rooms = new Rooms({ now: () => clock });
  const code = rooms.create('avalon');

  await withServer(async (base) => {
    const lobby = await fetch(base + '/api/health/update');
    assert.equal(lobby.status, 200);
    const lobbyHealth = await lobby.json();
    assert.equal(lobbyHealth.rooms, 1);
    assert.equal(lobbyHealth.activeGames, 0);
    assert.equal(lobbyHealth.updateSafe, true);

    rooms.get(code).game.state.phase = 'team';

    const live = await fetch(base + '/api/health');
    assert.equal(live.status, 200, 'an active game must not make liveness fail');
    assert.equal((await live.json()).updateSafe, false);

    const blocked = await fetch(base + '/api/health/update');
    assert.equal(blocked.status, 409);
    const blockedHealth = await blocked.json();
    assert.equal(blockedHealth.activeGames, 1);
    assert.equal(blockedHealth.updateSafe, false);

    rooms.get(code).game.state.phase = 'over';
    assert.equal((await fetch(base + '/api/health/update')).status, 409, 'results remain protected while players read them');

    clock += 2 * 60 * 1000;
    assert.equal((await fetch(base + '/api/health/update')).status, 409, 'a result this fresh is still protected');

    clock += 1 * 60 * 1000;   // three minutes since the room was last touched
    assert.equal((await fetch(base + '/api/health/update')).status, 200, 'an untouched result stops blocking');

    rooms.get(code).game.state.phase = 'lobby';
    assert.equal((await fetch(base + '/api/health/update')).status, 200);
  }, { rooms });
});

test('health reports the commit this process is serving', async () => {
  await withServer(async (base) => {
    const { commit } = await (await fetch(base + '/api/health')).json();
    // The deployment pipeline compares this with the commit it published, so
    // "some string" is not good enough: it is a full SHA or an honest null.
    assert.ok(commit === null || /^[0-9a-f]{40}$/.test(commit), `unusable commit: ${commit}`);
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

test('a new seat gets its avatar in the background and the file is cached', async () => {
  const rooms = new Rooms();
  const image = Buffer.from('RIFF0000WEBPavatar');
  const avatars = {
    canGenerate: true,
    resolve: async ({ name, upload }: { name: string; upload?: string | false }) => {
      assert.equal(name, 'Ann');
      assert.equal(upload, undefined);
      return '/api/avatars/g-test.webp';
    },
    read: async (file: string) => file === 'g-test.webp' ? { bytes: image, mime: 'image/webp' } : null,
  };

  await withServer(async (base) => {
    const { code } = await (await post(base, '/api/rooms')).json();
    const { playerId } = await (await post(base, `/api/rooms/${code}/join`, { name: 'Ann' })).json();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rooms.peek(code)!.players[0]!.avatar, '/api/avatars/g-test.webp');

    const res = await fetch(`${base}/api/avatars/g-test.webp`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/webp');
    assert.match(res.headers.get('cache-control') ?? '', /immutable/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), image);

    const abort = new AbortController();
    const view = await nextView(views(base, code, playerId, abort.signal));
    abort.abort();
    assert.equal(view.players[0]!.avatar, '/api/avatars/g-test.webp');
  }, { rooms, avatars });
});

test('rejoining retries a missing avatar without creating a new seat', async () => {
  const rooms = new Rooms();
  let calls = 0;
  const avatars = {
    canGenerate: true,
    resolve: async () => (++calls === 1 ? null : '/api/avatars/g-retry.webp'),
    read: async () => null,
  };

  await withServer(async (base) => {
    const { code } = await (await post(base, '/api/rooms')).json();
    const joined = await (await post(base, `/api/rooms/${code}/join`, { name: 'Ann' })).json();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(rooms.peek(code)!.players[0]!.avatar, undefined);

    const rejoined = await (await post(base, `/api/rooms/${code}/join`, {
      name: 'Ann', playerId: joined.playerId,
    })).json();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rejoined.playerId, joined.playerId);
    assert.equal(rooms.peek(code)!.players.length, 1);
    assert.equal(calls, 2);
    assert.equal(rooms.peek(code)!.players[0]!.avatar, '/api/avatars/g-retry.webp');
  }, { rooms, avatars });
});

test('refuses to walk out of the public directory', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/../src/server.ts', { redirect: 'manual' });
    assert.notEqual(res.status, 200);
  });
});

test('a room round-trips create, join and reconnect', async () => {
  await withServer(async (base) => {
    const { code } = await (await post(base, '/api/rooms')).json();
    assert.match(code, /^[A-Z2-9]{4}$/);
    assert.deepEqual(await (await fetch(`${base}/api/rooms/${code}`)).json(), { exists: true, seated: false });
    assert.deepEqual(await (await fetch(`${base}/api/rooms/ZZZZ`)).json(), { exists: false, seated: false });

    const first = await (await post(base, `/api/rooms/${code}/join`, { name: 'Ann' })).json();
    assert.ok(first.playerId);

    // What a dropped browser asks before it reopens its stream: the room is
    // here and so is my seat, so reconnecting is worth trying.
    const seated = `${base}/api/rooms/${code}?playerId=${first.playerId}`;
    assert.deepEqual(await (await fetch(seated)).json(), { exists: true, seated: true });
    assert.deepEqual(
      await (await fetch(`${base}/api/rooms/${code}?playerId=someone-else`)).json(),
      { exists: true, seated: false },
    );

    // Rejoining with the stored id keeps one seat, not two.
    const again = await (await post(base, `/api/rooms/${code}/join`, { name: 'Ann', playerId: first.playerId })).json();
    assert.equal(again.playerId, first.playerId);

    const dup = await post(base, `/api/rooms/${code}/join`, { name: 'ann' });
    assert.equal(dup.status, 409);
    assert.equal((await dup.json()).error, 'nameTaken');
  });
});

test('a stale event stream gets a clean error without crashing the server', async () => {
  await withServer(async (base) => {
    const stale = await fetch(`${base}/api/rooms/ZZZZ/events?playerId=gone`);
    assert.equal(stale.status, 404);
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
    assert.equal(early.status, 409);
    assert.deepEqual(await early.json(), { error: 'needMorePlayers', params: { min: 5 } });

    const bogus = await post(base, `/api/rooms/${code}/action`, { type: 'nope', playerId });
    assert.equal(bogus.status, 400);
    assert.equal((await bogus.json()).error, 'unknownAction');

    const stranger = await post(base, `/api/rooms/${code}/action`, { type: 'start', playerId: 'not-a-player' });
    assert.equal(stranger.status, 403);
    assert.equal((await stranger.json()).error, 'notInGame');

    const missing = await post(base, '/api/rooms/ZZZZ/join', { name: 'Ann' });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, 'noSuchRoom');
  });
});

test('malformed and wrong-type JSON is rejected before room dispatch', async () => {
  const rooms = new Rooms();
  await withServer(async (base) => {
    for (const body of ['null', '[]', '"text"', '{']) {
      const response = await postText(base, '/api/rooms', body);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: 'badRequest', params: {} });
    }

    const { code } = await (await post(base, '/api/rooms')).json();
    const badJoin = await post(base, `/api/rooms/${code}/join`, { name: [] });
    assert.equal(badJoin.status, 400);
    assert.equal((await badJoin.json()).error, 'badRequest');

    const noSeatYet = await post(base, `/api/rooms/${code}/join`, { name: 'Bo', playerId: null });
    assert.equal(noSeatYet.status, 200, 'a browser with no stored seat may send a null id');

    const joined = await (await post(base, `/api/rooms/${code}/join`, { name: 'Ann' })).json();
    const before = rooms.peek(code)!.revision;
    for (const body of [
      null,
      [],
      { type: 'vote', playerId: joined.playerId, approve: 'yes' },
      { type: 'options', playerId: joined.playerId, options: { percival: 1 } },
    ]) {
      const response = await postText(base, `/api/rooms/${code}/action`, JSON.stringify(body));
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, 'badRequest');
      assert.equal(rooms.peek(code)!.revision, before, 'invalid input never reached dispatch');
    }

    const stripped = await post(base, `/api/rooms/${code}/action`, {
      type: 'options', playerId: rooms.peek(code)!.hostId,
      options: { percival: false, ignoredOption: true },
      ignoredEnvelope: true,
    });
    assert.equal(stripped.status, 200, 'unknown HTTP keys are stripped');
    assert.equal('ignoredOption' in rooms.peek(code)!.game.state.options, false);
  }, { rooms });
});

test('API failures use accurate status classes and structured bodies', async () => {
  await withServer(async (base) => {
    const wrongMethod = await fetch(base + '/api/rooms');
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'POST');
    assert.deepEqual(await wrongMethod.json(), { error: 'methodNotAllowed', params: {} });

    const unsupported = await postText(base, '/api/rooms', '{}', 'text/plain');
    assert.equal(unsupported.status, 415);
    assert.deepEqual(await unsupported.json(), { error: 'unsupportedMediaType', params: {} });

    const oversized = await postText(base, '/api/rooms', JSON.stringify({ padding: 'x'.repeat(70 * 1024) }));
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { error: 'payloadTooLarge', params: {} });

    const absent = await fetch(base + '/api/not-a-route');
    assert.equal(absent.status, 404);
    assert.deepEqual(await absent.json(), { error: 'notFound', params: {} });
  });
});

test('unexpected API failures stay server errors', async () => {
  const rooms = new Rooms();
  rooms.activeGameCount = () => { throw new Error('unexpected'); };
  const original = console.error;
  console.error = () => {};
  try {
    await withServer(async (base) => {
      const response = await fetch(base + '/api/health');
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: 'serverError', params: {} });
    }, { rooms });
  } finally {
    console.error = original;
  }
});

test('an action pushes a fresh view to every subscriber', async () => {
  await withServer(async (base) => {
    const { code } = await (await post(base, '/api/rooms')).json();
    const ann = (await (await post(base, `/api/rooms/${code}/join`, { name: 'Ann' })).json()).playerId;

    const abort = new AbortController();
    const stream = views(base, code, ann, abort.signal);

    const first = await nextView(stream);
    assert.equal(first.players.length, 1);
    assert.equal(first.phase, 'lobby');

    await post(base, `/api/rooms/${code}/join`, { name: 'Bob' });
    const second = await nextView(stream);
    assert.deepEqual(second.players.map((p) => p.name), ['Ann', 'Bob']);

    await post(base, `/api/rooms/${code}/action`, { type: 'options', playerId: ann, options: { percival: true } });
    const third = await nextView(stream);
    assert.equal(third.gameId, 'avalon');
    assert.equal(third.phase, 'lobby');
    assert.equal(third.options.percival, true);

    abort.abort();
  });
});

test('a five player game plays through over the wire', async () => {
  await withServer(async (base) => {
    const { code } = await (await post(base, '/api/rooms')).json();
    const ids: string[] = [];
    for (const name of ['Ann', 'Bob', 'Cai', 'Dee', 'Eli']) {
      ids.push((await (await post(base, `/api/rooms/${code}/join`, { name })).json()).playerId);
    }
    const act = (playerId: string, type: string, extra: JsonRecord = {}): Promise<Response> =>
      post(base, `/api/rooms/${code}/action`, { type, playerId, ...extra });
    const viewOf = async (playerId: string): Promise<PublicView> => {
      const abort = new AbortController();
      const v = await nextView(views(base, code, playerId, abort.signal));
      abort.abort();
      return v;
    };

    assert.equal((await act(ids[0]!, 'start')).status, 200);
    for (const id of ids) await act(id, 'confirm');

    let view = await viewOf(ids[0]!);
    assert.equal(view.gameId, 'avalon');
    assert.equal(view.phase, 'team');
    assert.equal(view.teamSize, 2);
    assert.equal(view.evilCount, 2);
    assert.ok(view.you?.role, 'each player learns their own role');

    const leader = view.players.find((p) => p.isLeader);
    const team = view.players.slice(0, 2).map((p) => p.id);
    await act(leader!.id, 'propose', { team });
    for (const id of ids) await act(id, 'vote', { approve: true });

    view = await viewOf(ids[0]!);
    assert.equal(view.gameId, 'avalon');
    assert.equal(view.phase, 'quest');
    assert.deepEqual(view.team, team);

    for (const id of team) await act(id, 'card', { success: true });
    view = await viewOf(ids[0]!);
    assert.equal(view.gameId, 'avalon');
    assert.equal(view.phase, 'team');
    assert.equal(view.quests.length, 1);
    assert.equal(view.quests[0]!.success, true);
    assert.equal(view.round, 1);
  });
});

test('a room can be created for either game', async () => {
  await withServer(async (base) => {
    const { code } = await (await post(base, '/api/rooms', { game: 'onuw' })).json();
    const playerId = (await (await post(base, `/api/rooms/${code}/join`, { name: 'Ann' })).json()).playerId;

    const abort = new AbortController();
    const view = await nextView(views(base, code, playerId, abort.signal));
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

    const act = (playerId: string, body: JsonRecord): Promise<Response> =>
      post(base, `/api/rooms/${code}/action`, { playerId, ...body });
    const viewOf = async (playerId: string): Promise<PublicView> => {
      const abort = new AbortController();
      const v = await nextView(views(base, code, playerId, abort.signal));
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
  const skipNight = (code: string): boolean => rooms.apply(code, (context: GameContext) => {
    if (!isOnuwContext(context)) throw new Error('expected ONUW context');
    return onuw.tick(context, Date.now() + 10 * 60_000);
  });

  await withServer(async (base) => {
    const { code } = await (await post(base, '/api/rooms', { game: 'onuw' })).json();
    const ids: string[] = [];
    for (const name of ['Ann', 'Bob', 'Cai']) {
      ids.push((await (await post(base, `/api/rooms/${code}/join`, { name })).json()).playerId);
    }
    const act = (playerId: string, body: JsonRecord): Promise<Response> =>
      post(base, `/api/rooms/${code}/action`, { playerId, ...body });
    const viewOf = async (playerId: string): Promise<PublicView> => {
      const abort = new AbortController();
      const v = await nextView(views(base, code, playerId, abort.signal));
      abort.abort();
      return v;
    };

    assert.equal((await act(ids[0]!, { type: 'start' })).status, 200);
    let view = await viewOf(ids[0]!);
    assert.equal(view.gameId, 'onuw');
    assert.equal(view.phase, 'reveal');
    assert.ok(view.you?.role, 'each player is dealt a card');
    assert.equal('centre' in view, false, 'the centre is face down');
    assert.equal('night' in view, false, 'the clock waits while roles are being read');

    for (const id of ids.slice(0, -1)) assert.equal((await act(id, { type: 'confirm' })).status, 200);
    view = await viewOf(ids[0]!);
    assert.equal(view.gameId, 'onuw');
    assert.equal(view.phase, 'reveal', 'the game waits for the final player');
    assert.deepEqual(view.waitingFor, [ids.at(-1)]);

    assert.equal((await act(ids.at(-1)!, { type: 'confirm' })).status, 200);
    view = await viewOf(ids[0]!);
    assert.equal(view.gameId, 'onuw');
    assert.equal(view.phase, 'night');
    assert.equal(view.night?.key, 'nightfall', 'the night opens with everyone closing their eyes');
    assert.ok((view.night?.msLeft ?? 0) > 0, 'and a clock the whole room shares');

    // Nobody can be identified by what the night is waiting on.
    for (const id of ids) {
      const mine = await viewOf(id);
      assert.equal(mine.gameId, 'onuw');
      assert.equal(mine.phase, 'night');
      assert.equal('waitingFor' in mine, false);
      assert.ok(mine.players.every((p) => !('acted' in p)));
    }

    skipNight(code);
    view = await viewOf(ids[0]!);
    assert.equal(view.gameId, 'onuw');
    assert.equal(view.phase, 'day');
    assert.equal('night' in view, false);

    await act(ids[0]!, { type: 'startVote' });
    await act(ids[0]!, { type: 'vote', target: ids[1] });
    await act(ids[1]!, { type: 'vote', target: ids[2] });
    await act(ids[2]!, { type: 'vote', target: ids[1] });

    view = await viewOf(ids[0]!);
    assert.equal(view.gameId, 'onuw');
    assert.equal(view.phase, 'over');
    assert.deepEqual(view.dead, [ids[1]]);
    assert.equal(view.centre.length, 3, 'everything is revealed');
    assert.ok(view.players.every((p) => p.startRole && p.finalRole));
  }, { rooms });
});
