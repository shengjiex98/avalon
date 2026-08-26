# Plan: room state that survives restarts

**Goal.** A server restart — deployment, crash, or host reboot — no longer ends
games in progress. Once that is true, most deployments stop waiting for tables
to clear, because the update gate only needs to protect restarts that would
actually lose something.

**Why this shape.** The codebase is already built for it: game state is plain
JSON data (no functions, Sets, Maps, or class instances — see `baseState` in
[src/lobby.js](../src/lobby.js) and both engines), timers live outside game
state and are reconstructed from it (`scheduleTick` reads
`nextDeadline(g)` in [src/rooms.js](../src/rooms.js)), and the client already
reconnects through SSE retry plus idempotent join. Restoring a room and calling
`scheduleTick` resumes it; reconnecting clients receive a full per-player view
and continue.

**Non-goals.** No dependencies, no database, no separate frontend/backend
pipelines, no zero-downtime socket handoff, no containers. A JSON snapshot
file is proportionate to this project's scale (a handful of rooms, a few KB).

Work in a worktree, not the deployment checkout (see
[AGENTS.md](../AGENTS.md)). Run `npm test` after each step. Each step below is
independently shippable and a strict improvement if you stop there; ship them
as separate PRs in order.

---

## Step 1 — enforce serializability as a tested invariant

No behavior change. Turns "game state must stay plain JSON data" from a
convention into a failing test.

**New file: `test/persistence.test.js`**

- For each game, script a playthrough using the same helpers/patterns as
  `test/game.test.js` and `test/onuw.test.js` (deterministic shuffle, injected
  `now`). At several points — lobby with players, mid-game, `over` — assert:

  ```js
  assert.deepStrictEqual(JSON.parse(JSON.stringify(g)), g);
  ```

  This fails if anyone ever adds a Set, Map, Date, function, or `undefined`
  field to game state, which is the one thing that would silently break
  restore later.

**Acceptance:** `npm test` passes; deleting the `JSON.parse` round-trip from
the assertion is the only way to make a non-serializable state pass.

## Step 2 — snapshot on shutdown, restore on boot

The core of the plan. After this step, crashes and reboots stop ending games,
even though deployments are still gated.

### 2a. State version constant

**New file: `src/state-version.js`** — exactly this shape, because
`deploy/update.sh` will later extract the number with `sed` from `git show`
output, without executing anything:

```js
// Bump when the in-memory room/game state shape changes incompatibly.
// A snapshot stamped with a different version is discarded on boot,
// which degrades to today's behavior: those games end.
export const STATE_VERSION = 1;
```

Report it from `/api/health` in [src/server.js](../src/server.js) (add
`stateVersion: STATE_VERSION` to the health payload; additive, so
`API_PROTOCOL` stays 1). Document the new field in [api.md](api.md).

### 2b. Mutation hook on `Rooms`

Keep `Rooms` free of I/O. In [src/rooms.js](../src/rooms.js):

- Constructor becomes `constructor({ now = Date.now, onMutate } = {})`;
  store `this.onMutate = onMutate`.
- Call `this.onMutate?.()` at the end of: `create()`, `apply()` (after
  broadcast), the `tick` timeout callback when `moved` is true, and `sweep()`
  when it deleted at least one room. (`setGame` and `join` already go through
  `apply`.)

Add snapshot methods:

```js
/** Everything a restart must not lose. Subscribers and timers are runtime. */
snapshot() {
  return [...this.rooms.values()].map(({ game, touchedAt }) => ({ game, touchedAt }));
}

/** Rebuild rooms from a snapshot and resume their clocks. Boot-time only. */
restore(entries) {
  for (const { game, touchedAt } of entries) {
    if (!(game?.gameId in GAMES) || !game.code) continue;  // skip, don't throw
    this.rooms.set(game.code, { game, subscribers: new Set(), touchedAt, timer: null });
    this.scheduleTick(game.code);
  }
}
```

Restore must not go through `get()` (it bumps `touchedAt`, which would defeat
idle expiry). Preserving `touchedAt` matters: a room idle for six hours before
the restart should still be swept, and `activeGameCount`'s `OVER_GRACE_MS`
window should not be renewed by the restart itself.

### 2c. Persistence module

**New file: `src/persistence.js`**, roughly:

```js
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { STATE_VERSION } from './state-version.js';

/** systemd's StateDirectory when running as a service; XDG fallback for dev. */
export function defaultStateFile() {
  const dir = process.env.STATE_DIRECTORY
    ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'avalon');
  return process.env.AVALON_STATE_FILE ?? join(dir, 'rooms.json');
}

export function save(rooms, file) {
  const body = JSON.stringify({ stateVersion: STATE_VERSION, savedAt: Date.now(), rooms: rooms.snapshot() });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, body);
  renameSync(`${file}.tmp`, file);   // atomic: a crash mid-write leaves the old file intact
}

export function load(rooms, file) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
  catch { return; }                  // missing or corrupt: start empty, as today
  if (parsed.stateVersion !== STATE_VERSION) {
    console.log(`snapshot is state version ${parsed.stateVersion}, expected ${STATE_VERSION}; discarding`);
    return;
  }
  rooms.restore(parsed.rooms ?? []);
}
```

Sync `fs` calls are deliberate: `save` must also work inside a signal handler,
and the file is a few KB. Do not delete a mismatched snapshot; the next `save`
overwrites it.

### 2d. Wire it into `start()`

In [src/server.js](../src/server.js):

- Create `Rooms` with a **debounced** `onMutate`: arm a 1-second `setTimeout`
  (unref'd, one at a time) that calls `save(rooms, file)`. This is the crash
  path; losing up to one second of moves in a crash is acceptable.
- Call `load(rooms, file)` **before** `server.listen`, so the first requests
  after a restart already see the rooms.
- On `SIGTERM` and `SIGINT`: cancel the pending debounce, `save` synchronously,
  `server.close()`, `process.exit(0)`. This is the deployment path — systemd's
  `restart` sends SIGTERM — and must never lose a move.
- Log one line on boot: how many rooms were restored, or why none.

`createApp` and its tests are untouched; only `start()` gains the wiring, and
it accepts the file path as an option so tests can point it at a temp dir.

### 2e. systemd: let the process write its state directory

[deploy/avalon.service](../deploy/avalon.service) currently declares
`ProtectHome=read-only` — **the process cannot write anywhere today**. Add to
`[Service]`:

```ini
StateDirectory=avalon
```

For a user unit this creates `~/.local/state/avalon`, exports
`STATE_DIRECTORY`, and grants write access through the sandbox. Update the
"holds nothing on disk" comment in the unit. If the snapshot file fails to
appear on the host after deploying (older systemd + `ProtectHome` interplay),
add `ReadWritePaths=%h/.local/state/avalon` as the explicit fallback.

**Manual host step (one time, note it in the PR):** unit changes need
`systemctl --user daemon-reload` before the next restart picks them up.

### 2f. Tests (extend `test/persistence.test.js`, follow existing styles)

- Save/load round trip: build a `Rooms` with injected `now`, create a room,
  join players, start a game, `save` to a temp file (`mkdtemp`, as
  `test/deploy.test.js` does), `load` into a fresh `Rooms`, and assert
  `viewFor` output per player and `activeGameCount()` are identical.
- A night-phase ONUW room has `room.timer` set after restore (the clock
  resumed); a lobby room does not.
- Version mismatch and corrupt file each yield an empty registry without
  throwing.
- `touchedAt` survives the round trip.
- In `test/server.test.js`: health reports `stateVersion`.

**Acceptance:** kill and restart a locally running server mid-game
(Ctrl-C, `npm start`); the browser shows the connection banner briefly, then
the same game continues, timers included. All tests pass.

## Step 3 — relax the update gate for state-compatible deploys

After this step, a deploy whose target commit has the **same** `STATE_VERSION`
as the running server restarts immediately, mid-game or not, because Step 2
made that restart lossless. A version-bumping deploy still waits for the table
to clear, exactly as today.

In [deploy/update.sh](../deploy/update.sh):

- Read the running server's state version alongside `running_commit` (extend
  the existing `node -e` fetch to print `h.stateVersion ?? ""`).
- Read the target's without checking it out or executing it:

  ```sh
  target_sv=$(git show "$target:src/state-version.js" 2>/dev/null \
    | sed -n 's/.*STATE_VERSION = \([0-9][0-9]*\).*/\1/p')
  ```

- Bypass `gate.sh` **only** when both values are non-empty and equal.
  Anything else — server down, field missing (the first deploy of this
  feature), file absent from the target, unparsable — runs the gate exactly
  as today. Fail closed.
- The bypass skips only the gate. Everything else keeps its current order:
  version check, tests, rollback on failure, restart, publish. The
  gate-before-reset ordering for the non-bypass path must not move (a checkout
  alone changes what open browsers are served; `test/deploy.test.js` asserts
  this).

Extend `test/deploy.test.js` in its existing text-assertion style: the script
extracts both versions, compares them, and consults `gate.sh` on every path
where they are not known-equal.

**Acceptance:** a no-op-state-change commit deploys while `activeGames > 0`
and the game survives; a commit that bumps `STATE_VERSION` publishes `busy`
and retries hourly, as today. Note: the deploy that first ships Step 3 is
itself gated (the running server predates the comparison) — expected.

## Step 4 — documentation and working rules

- [architecture.md](architecture.md) "State and events": rooms snapshot to a
  state file and survive restarts when `STATE_VERSION` is unchanged.
- [deployment.md](deployment.md) "Important operating behavior": describe the
  snapshot file and its location, and that the gate now only defers
  state-incompatible deploys. Update the health-endpoint guidance.
- [AGENTS.md](../AGENTS.md) constraints, two changes:
  1. Replace "Restarting the server ends every game in progress" with the new
     reality, including when it still does (version bump, discarded snapshot).
  2. **New rule:** deploys now land during live games, so "backward compatible
     within a protocol version" must hold for in-flight games, not just
     lobbies. Renaming or re-typing a field in game state, a view, or an
     action is no longer a quiet refactor: state-shape changes bump
     `STATE_VERSION`; view/action changes an old client cannot render bump
     `API_PROTOCOL`.
- Add this plan's outcome to [docs/README.md](README.md) only if you turn it
  into permanent reference material; otherwise delete this file once done.

## Step 5 (optional, later) — restore grace for timed steps

A restart during an ONUW night burns downtime from the current step. If it
ever bothers anyone: add an optional per-game `onRestore(g, now)` hook to the
registry ([src/games/index.js](../src/games/index.js)), called by
`Rooms.restore`, and have ONUW extend a live deadline:
`g.stepEndsAt = Math.max(g.stepEndsAt, now + 5000)` when `phase === 'night'`.
Three lines plus a test. Skip until someone actually complains.

---

## Edge cases and guardrails

- **Do not** write the snapshot inside the checkout: `update.sh` resets the
  tree, and the deployment directory belongs to the updater.
- **Do not** serialize `subscribers` or `timer`; they are runtime handles.
  `snapshot()` picking only `{ game, touchedAt }` is the contract.
- A `stepEndsAt` in the past on restore is fine: `scheduleTick` fires
  immediately and `tick`'s existing loop fast-forwards. No special casing.
- `game.version` is preserved by the snapshot; clients diff on
  phase/round/gameId and every push is full state, so no client change is
  needed anywhere in this plan.
- Restart during an in-flight POST surfaces as a toast via the existing
  `err.network` path; the user retries. Acceptable; do not add retry logic.
- The debounce timer and any other new timer must be `unref`'d, matching the
  existing pattern, so tests and the process can exit.
- When `restore` hits a room it cannot place (unknown `gameId` after a game
  was removed), skip that room and keep the rest.
- Keep zero dependencies. If a future need outgrows the flat file, Node 24's
  built-in `node:sqlite` is the escalation path — still no dependency. Not
  part of this plan.
