import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { snapshotFileSchema } from '../contracts/persistence.ts';
import { STATE_VERSION } from '../contracts/state-version.ts';
import type { SnapshotFile } from '../contracts/persistence.ts';
import type { RoomRegistry } from './runtime.ts';

type LoadResult = { restored: number; reason: string | null };

/**
 * The XDG state path, or AVALON_STATE_FILE. Deliberately not systemd's
 * StateDirectory: for a user unit that resolves under $XDG_CONFIG_HOME before
 * systemd 256, which silently diverges from the snapshot deploy/updater.sh
 * backs up and restores.
 */
/** @returns {string} */
export function defaultStateFile(): string {
  const dir = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'avalon');
  return process.env.AVALON_STATE_FILE ?? join(dir, 'rooms.json');
}

/** Atomically replace the last complete room snapshot. */
/** @param {RoomRegistry} rooms @param {string} file */
export function save(rooms: RoomRegistry, file: string): void {
  const snapshot: SnapshotFile = {
    stateVersion: STATE_VERSION,
    savedAt: Date.now(),
    rooms: rooms.snapshot(),
  };
  const body = JSON.stringify(snapshot);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, body, { mode: 0o600 });
  chmodSync(`${file}.tmp`, 0o600);
  renameSync(`${file}.tmp`, file);
}

/** Restore a compatible snapshot, or leave the registry empty on any bad input. */
/** @param {RoomRegistry} rooms @param {string} file */
export function load(rooms: RoomRegistry, file: string): LoadResult {
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    const missing = err !== null && typeof err === 'object' && 'code' in err && err.code === 'ENOENT';
    const reason = missing ? 'no snapshot found' : 'snapshot is unreadable; starting empty';
    return { restored: 0, reason };
  }
  const parsed = snapshotFileSchema.safeParse(input);
  if (!parsed.success) {
    return { restored: 0, reason: 'snapshot is invalid; starting empty' };
  }
  if (parsed.data.stateVersion !== STATE_VERSION) {
    const reason = `snapshot is state version ${parsed.data.stateVersion}, expected ${STATE_VERSION}; discarding`;
    return { restored: 0, reason };
  }
  const entries = parsed.data.rooms;
  if (!rooms.restore(entries)) {
    return { restored: 0, reason: 'snapshot is invalid; starting empty' };
  }
  return {
    restored: entries.length,
    reason: entries.length ? null : 'snapshot contained no rooms',
  };
}
