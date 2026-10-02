import assert from 'node:assert/strict';
import test from 'node:test';

import { listenForever } from '../deploy/listen.mjs';

test('deployment listener backs off repeated connection failures', async () => {
  const waits = [];

  await assert.rejects(
    listenForever({
      serverUrl: 'https://ntfy.invalid',
      topicName: 'secret-topic',
      fetchImpl: async () => { throw new TypeError('fetch failed'); },
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        if (waits.length === 3) throw new Error('stop test');
      },
    }),
    /stop test/,
  );

  assert.deepEqual(waits, [5_000, 10_000, 20_000]);
});

test('a successful connection resets the listener backoff', async () => {
  const waits = [];
  let calls = 0;

  await assert.rejects(
    listenForever({
      serverUrl: 'https://ntfy.invalid',
      topicName: 'secret-topic',
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) throw new TypeError('fetch failed');
        if (calls === 2) return { ok: true, body: [] };
        throw new TypeError('fetch failed again');
      },
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        if (waits.length === 3) throw new Error('stop test');
      },
    }),
    /stop test/,
  );

  assert.deepEqual(waits, [5_000, 5_000, 10_000]);
});
