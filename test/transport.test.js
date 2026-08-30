import test from 'node:test';
import assert from 'node:assert/strict';

import { ApiError, createTransport } from '../public/transport.ts';

const response = (body, ok = true) => ({ ok, json: async () => body });

test('transport validates endpoint results and reports protocol mismatch', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const app = { server: '', source: null };
  const transport = createTransport({ app });

  globalThis.fetch = async (url) => {
    if (url === '/api/rooms') return response({ code: 'ABCD', ignored: true });
    return response({ service: 'avalon', protocol: 4, avatarGeneration: true });
  };

  assert.deepEqual(await transport.createRoom({ game: 'avalon' }), { code: 'ABCD' });
  assert.deepEqual(await transport.probeProtocol(3), {
    kind: 'protocolMismatch', expected: 3, actual: 4, avatarGeneration: true,
  });

  globalThis.fetch = async () => response({ code: 7 });
  await assert.rejects(transport.createRoom({ game: 'avalon' }), (error) =>
    error instanceof ApiError && error.key === 'invalidResponse');
});

test('the stream admits checked views and distinguishes invalid data from reconnects', (t) => {
  const OriginalEventSource = globalThis.EventSource;
  class EventSourceStub {
    static last;
    constructor() { EventSourceStub.last = this; }
    close() { this.closed = true; }
  }
  globalThis.EventSource = EventSourceStub;
  t.after(() => { globalThis.EventSource = OriginalEventSource; });

  const messages = [];
  const failures = [];
  const transport = createTransport({
    app: { server: '', source: null },
    onMessage: (view) => messages.push(view),
    onError: (failure) => failures.push(failure),
  });
  const source = transport.open('ABCD', 'p0');
  const envelope = {
    code: 'ABCD', gameId: 'avalon', phase: 'lobby', version: 1, hostId: 'p0',
    me: null, you: null, players: [], log: [],
    setup: { minPlayers: 5, maxPlayers: 10, options: [], houseRules: [] },
    options: {}, houseRules: {}, deck: null,
  };

  source.onmessage({ data: JSON.stringify(envelope) });
  assert.equal(messages.length, 1);
  source.onmessage({ data: JSON.stringify({ ...envelope, phase: 'night' }) });
  assert.deepEqual(failures, [{ kind: 'invalidResponse' }]);

  const reopened = transport.open('ABCD', 'p0');
  reopened.onerror();
  assert.deepEqual(failures.at(-1), { kind: 'reconnect' });
});
