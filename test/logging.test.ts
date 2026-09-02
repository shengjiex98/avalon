import test from 'node:test';
import assert from 'node:assert/strict';

import {
  captureLogs, logTone, RecentLogs,
} from '../src/server/logging.ts';
import type { OperationalLogRecord } from '../src/server/logging.ts';

test('recent logs reserve independent capacity for activity and requests', () => {
  let now = Date.parse('2026-09-01T12:00:00Z');
  const logs = new RecentLogs({
    activityCapacity: 2,
    requestCapacity: 2,
    now: () => now++,
  });
  logs.append('info', 'room.created');
  logs.append('info', 'game.started');
  for (let index = 0; index < 4; index += 1) {
    logs.append('info', 'api.request', { status: 200, requestId: `request-${index}` });
  }

  assert.deepEqual(logs.recent('activity').map(({ event }) => event), [
    'game.started', 'room.created',
  ]);
  assert.deepEqual(logs.recent('requests').map(({ fields }) => fields.requestId), [
    'request-3', 'request-2',
  ]);
  assert.deepEqual(logs.recent('all').map(({ sequence }) => sequence), [6, 5, 2, 1]);
});

test('problem view selects failures, rejected requests, and discarded snapshots', () => {
  const logs = new RecentLogs();
  logs.append('info', 'server.started');
  logs.append('info', 'api.request', { status: 200 });
  logs.append('info', 'api.request', { status: 404 });
  logs.append('info', 'snapshot.load', { outcome: 'discarded' });
  logs.append('error', 'snapshot.save', { outcome: 'failed' });

  assert.deepEqual(logs.recent('problems').map(({ event }) => event), [
    'snapshot.save', 'snapshot.load', 'api.request',
  ]);
  assert.equal(logs.recent('all', 2).length, 2);
});

test('log tone gives color-independent severity semantics', () => {
  const record = (
    level: 'info' | 'error',
    event: string,
    fields: OperationalLogRecord['fields'] = {},
  ): OperationalLogRecord => ({ sequence: 1, time: '', level, event, fields });

  assert.equal(logTone(record('error', 'unexpected.failure')), 'error');
  assert.equal(logTone(record('info', 'api.request', { status: 503 })), 'error');
  assert.equal(logTone(record('info', 'api.request', { status: 404 })), 'warn');
  assert.equal(logTone(record('info', 'snapshot.load', { outcome: 'discarded' })), 'warn');
  assert.equal(logTone(record('info', 'api.request', { status: 204 })), 'ok');
  assert.equal(logTone(record('info', 'game.started')), 'info');
});

test('capture stores immutable field snapshots and forwards the original log', () => {
  const logs = new RecentLogs();
  const forwarded: unknown[][] = [];
  const logger = captureLogs(logs, (...args) => forwarded.push(args));
  const fields = { outcome: 'restored' };

  logger('info', 'snapshot.load', fields);
  fields.outcome = 'changed';

  assert.deepEqual(logs.recent()[0]?.fields, { outcome: 'restored' });
  assert.deepEqual(forwarded, [['info', 'snapshot.load', fields]]);
});
