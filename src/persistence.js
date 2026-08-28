import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { STATE_VERSION } from './state-version.js';

/** systemd's StateDirectory when running as a service; XDG fallback for dev. */
export function defaultStateFile() {
  const dir = process.env.STATE_DIRECTORY
    ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'avalon');
  return process.env.AVALON_STATE_FILE ?? join(dir, 'rooms.json');
}

/** Atomically replace the last complete room snapshot. */
export function save(rooms, file) {
  const body = JSON.stringify({
    stateVersion: STATE_VERSION,
    savedAt: Date.now(),
    rooms: rooms.snapshot(),
  });
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, body, { mode: 0o600 });
  chmodSync(`${file}.tmp`, 0o600);
  renameSync(`${file}.tmp`, file);
}

/** Restore a compatible snapshot, or leave the registry empty on any bad input. */
export function load(rooms, file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    const reason = err?.code === 'ENOENT' ? 'no snapshot found' : 'snapshot is unreadable; starting empty';
    return { restored: 0, reason };
  }
  if (parsed.stateVersion !== STATE_VERSION) {
    const reason = `snapshot is state version ${parsed.stateVersion}, expected ${STATE_VERSION}; discarding`;
    return { restored: 0, reason };
  }
  const entries = parsed.rooms ?? [];
  if (!rooms.restore(entries)) {
    return { restored: 0, reason: 'snapshot is invalid; starting empty' };
  }
  return {
    restored: entries.length,
    reason: entries.length ? null : 'snapshot contained no rooms',
  };
}
