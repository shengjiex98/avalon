import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, body);
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
  const before = rooms.rooms.size;
  rooms.restore(parsed.rooms ?? []);
  const restored = rooms.rooms.size - before;
  return { restored, reason: restored ? null : 'snapshot contained no usable rooms' };
}
