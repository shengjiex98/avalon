# Plan: deterministic engines with replay & fuzzing, and type-checked contracts

Two independent improvements. Part A makes every game reproducible from a seed
and an action list, then uses that to fuzz the engines against invariants —
including the one that actually matters in hidden-role games: **a player's view
must never leak another player's secrets**. Part B makes the state, view, and
action shapes machine-checked contracts via JSDoc + `tsc --noEmit`, with no
build step and no runtime change.

Each part is broken into small, independently shippable steps. Ship them as
separate PRs in order; every step leaves `npm test` green and the game
behaviorally unchanged (Part A changes *which* random numbers are drawn, never
the distribution).

**Status (2026-08-26):** Part A steps A1–A2 are implemented. A3 onward and all
of Part B remain for later.

**Relationship to room persistence:** the plans are independent, but Part A
steps A1–A2 add fields to game state. Those fields are included in the initial
`STATE_VERSION = 2` snapshot shape, so each snapshot carries its own seed and
input record.

Work in a worktree, not the deployment checkout (see [AGENTS.md](../AGENTS.md)).

---

## Part A — deterministic engines, recorded actions, replay, fuzzing

### Why this is cheap here

Every mutation already flows through one funnel (`rooms.apply`, dispatched by
action name with a JSON body in [src/server.js](../src/server.js)), state is
plain JSON, and the engines already accept injected `shuffle` and `now`. Two
exceptions break determinism today and are bugs against the engines' own
stated contract ("randomness it was not handed"):

- [src/games/avalon/game.js:60](../src/games/avalon/game.js) — first leader
  picked with raw `Math.random()`.
- [src/games/onuw/game.js:299](../src/games/onuw/game.js) — a raw
  `Math.random()` centre pick inside night resolution.

### Step A1 — seeded randomness stored in game state

Goal: two rooms created with the same seed, receiving the same actions at the
same times, deal identically and evolve identically.

**In [src/lobby.js](../src/lobby.js):**

- Add a mulberry32 step whose 32-bit state lives *in game state*, so
  determinism survives serialization (snapshots included):

  ```js
  /** Mulberry32. State is a uint32 in g.rng, so a snapshot resumes the exact stream. */
  export function nextRand(g) {
    g.rng = (g.rng + 0x6d2b79f5) >>> 0;
    let t = g.rng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  export const randInt = (g, n) => Math.floor(nextRand(g) * n);
  ```

- Extend `baseState(code, gameId, { now, seed })`: store `seed` (default
  `crypto`-random uint32 — import `randomInt` from `node:crypto` in the
  caller, or accept it as an option) and initialize `rng: seed >>> 0`. Keep
  `seed` alongside `rng`: `rng` advances, `seed` is the replay input.
- Add `shuffleWith(g, list)`: Fisher–Yates identical to `defaultShuffle` but
  drawing from `nextRand(g)`.

**In the engines:**

- Change the `shuffle = defaultShuffle` defaults in both `startGame`s to
  `shuffle = (list) => shuffleWith(g, list)`. The injection parameter stays,
  so existing tests that pass a rigged shuffle are untouched.
- Replace the two `Math.random()` calls with `randInt(g, n)`.
- `setGame` in [src/rooms.js](../src/rooms.js) builds a fresh state; make it
  carry the old room's `seed`/`rng` forward alongside `players`/`hostId`/`log`
  (a room keeps one random stream for its lifetime).
- Thread `seed` through `Rooms.create` → `gameFor(id).create` → `createGame`
  → `baseState` as an option, defaulting to random, so tests and the replay
  helper can pin it.

**Tests (`test/determinism.test.js`):** create two rooms with the same seed,
join the same players, start; assert `roles`, seating, and `leaderIndex` are
deep-equal. Create with different seeds; assert they (very likely) differ.
Assert `JSON.parse(JSON.stringify(g))` still round-trips (the rng field is a
number, but this guards the habit).

**Acceptance:** all existing tests pass unchanged; the two `Math.random` calls
are gone from `src/games/` (`grep -rn 'Math.random' src/games` is empty).

### Step A2 — one dispatch funnel that records actions

Goal: every state-changing request goes through a single method that appends a
machine-readable record to game state. This also simplifies `server.js`.

**In [src/rooms.js](../src/rooms.js):** add

```js
/** The one entry point for player input. Records, then applies. */
dispatch(code, playerId, body) {
  return this.apply(code, (g) => {
    if (!g.players.some((p) => p.id === playerId) && body.type !== 'join') throw new GameError('notInGame');
    record(g, playerId, body);
    const action = COMMON_ACTIONS[body.type] ?? gameFor(g.gameId).actions[body.type];
    if (!action) throw new GameError('unknownAction', { type: body.type });
    return action(g, playerId, body);
  });
}
```

with `record(g, playerId, body)` in [src/lobby.js](../src/lobby.js) appending
`{ t: body.type, p: playerId, b: rest, at: this.now() }` to `g.actions`
(initialize `actions: []` in `baseState`; `rest` is `body` minus `type` and
`playerId`). Two subtleties:

- **Record only successful actions.** A rejected action does not mutate state,
  so it must not enter the replay record. Easiest correct order: run the
  action first, push the record after it returns without throwing, before
  `apply` bumps the version. (The sketch above records first for clarity —
  the implementation must not.)
- **Joins and `setGame` mutate state, so they are part of the record.** Move
  the join route's `addPlayer` call and `setGame` through `dispatch` too:
  make `join` and `setGame` entries in `COMMON_ACTIONS` (join synthesizes
  `{ type:'join', name, id }`; `setGame`'s state-swap stays in `Rooms` but is
  invoked from the funnel so it gets recorded — carry `g.actions` forward in
  the swap, like `log`). `server.js`'s `/action` and `/join` handlers shrink
  to argument marshalling plus `rooms.dispatch(...)`.

Cap `g.actions` at 2000 entries; on overflow, drop the whole array and set
`g.actionsDropped = true` (a partial record is worse than none — replay must
never silently start mid-stream). No real game approaches this; the cap is a
memory guard against abuse.

**Tests:** extend `test/rooms.test.js`/`test/server.test.js` minimally — a
played sequence appears in `g.actions` in order with timestamps; a rejected
action (wrong phase) leaves no record; views do not include `actions`
(check `baseView` — do **not** add it there).

**Acceptance:** existing HTTP tests pass; `server.js` no longer dispatches
into `GAMES[..].actions` itself.

### Step A3 — the replay helper

Goal: `(seed, actions) → final state`, including timed ONUW nights.

**New file: `test/helpers/replay.js`** (test-only; nothing ships):

```js
import { Rooms } from '../../src/rooms.js';

/** Rebuild a game from its recorded inputs. Time is simulated: the clock
 *  jumps to each action's `at`, ticking the engine past any deadlines that
 *  elapsed in between, which is what the room timer does in production. */
export function replay({ gameId, code, seed, actions }) {
  let clock = 0;
  const rooms = new Rooms({ now: () => clock });
  rooms.create(gameId, { code, seed });          // create must accept both overrides
  for (const { t, p, b, at } of actions) {
    advance(rooms, code, at);                    // clock = at, then tick until settled
    rooms.dispatch(code, p, { type: t, ...b });
  }
  return rooms.get(code).game;
}
```

`advance` sets the clock and, while `nextDeadline(g)` is non-null and ≤ the
clock, calls the game's `tick(g, deadline)` — mirroring what `scheduleTick`'s
timeout does, but synchronously. (Alternatively expose a small
`Rooms.settle(code)` doing exactly this and let `scheduleTick` share it; do
that only if the duplication bothers you.) `Rooms.create` needs `code` and
`seed` overrides for this — add them as options, keeping current callers
unchanged.

**Tests (`test/replay.test.js`):**

- **Avalon golden replay:** script a full game through `rooms.dispatch` with a
  pinned seed and injected clock, capture `{seed, actions}` from the final
  state, replay it, and `assert.deepStrictEqual` final state vs. original
  (compare after `JSON.parse(JSON.stringify(...))` on both).
- **ONUW timed replay:** script a game whose night steps elapse (advance the
  injected clock past `stepEndsAt` between actions), replay, deep-equal.

**Acceptance:** both golden tests pass; changing the seed makes them fail
(sanity-check once, don't commit that).

### Step A4 — invariants and the fuzzer

The payoff step. Random-but-plausible action sequences against random seeds,
with invariants checked after every applied action. Any failure prints
`{ gameId, seed, actions }` — a self-contained repro that feeds straight into
`replay()`.

**New file: `test/helpers/invariants.js`**, checked after every step for every
player:

1. **No engine crash:** `dispatch` may throw `GameError` only. Anything else
   fails the run.
2. **Serializable:** `JSON.parse(JSON.stringify(g))` deep-equals `g`.
3. **Legal phase:** `g.phase` is in the game's declared phase list (export
   `PHASES` from ONUW as Avalon already does).
4. **Ticks settle:** `advance` never loops more than, say, 10,000 deadlines
   (a guard counter — catches a `tick` that stops moving `stepEndsAt`).
5. **No secret leaks** — the headline. For each viewer,
   `JSON.stringify(viewFor(g, viewerId))` must not contain any secret the
   viewer is not entitled to.

For invariant 5, write the entitlement rules **by hand from the rules docs**
([games.md](games.md)) — *not* by importing `knowledgeFor` or the engines'
own dealing logic, which would test the code against itself. Shape:

```js
// entitlements.avalon(g, viewerId) -> Set of strings that MAY appear in this view.
// The check: for every (playerId, role) pair in g.roles with playerId !== viewerId,
// if role is not entitled, assert the serialized view does not pair that player with
// that role, and does not reveal it at all where the role name itself is the secret.
```

Practical mechanics: secrets are short known strings (role keys, night-action
targets, unrevealed quest cards, unrevealed votes). For each unentitled
secret, assert its identifying string is absent from the serialized view —
and where a string is too generic to search for alone (a boolean card),
assert the *field* is absent for other players instead. Start with the
rules that make these games work; refine if a legitimate reveal (e.g. the
post-game role reveal at `phase === 'over'`, evil seeing evil, Merlin seeing
evil, Percival's Merlin/Morgana pair, tallied votes) trips a false positive.
Encode each legitimate reveal explicitly in the entitlement function with a
comment naming the rule.

**New file: `test/fuzz.test.js`:**

- A generator that, given a PRNG (reuse mulberry32 with its own seed), builds
  a room, joins 5–10 players, then loops N times: pick a random player and a
  random action type from the game's registry (plus `join`/`leave`/`setGame`
  occasionally), fill the body from small pools (player ids for
  targets/teams, booleans for votes/cards, valid-ish option maps), sometimes
  advance the clock. **Expect most actions to be rejected** — that is the
  fuzzer probing the guards; catch `GameError` and continue.
- Run a fixed set of seeds (e.g. 0–19) plus a handful of `Date.now()`-derived
  ones per run, ~200 steps each, both games. Keep total runtime well under a
  few seconds — this runs in `npm test`, which `deploy/update.sh` executes on
  the host before every restart.
- On any invariant failure, `assert.fail` with the JSON repro in the message.

**Acceptance:** fuzz runs green and fast. Prove the leak check has teeth once:
temporarily make Avalon's `viewFor` return `g.roles` and watch invariant 5
fail with a usable repro (don't commit).

### Step A5 (optional) — repro extraction from production

Nothing new to build if the persistence plan has shipped: the snapshot file
already contains `seed`, `rng`, and `actions` for every live room. Document in
[deployment.md](deployment.md) how to copy the state file and feed one room's
entry to `replay()` locally. The file contains every player's secrets — treat
it accordingly and never expose it over HTTP. Do **not** add a debug endpoint.

---

## Part B — type-checked contracts (JSDoc + `tsc --noEmit`)

### Step B0 — the dependency decision, made explicitly

This adds `typescript` as a **devDependency**. Nothing ships: no build step,
no emitted files, the runtime stays dependency-free, and the host's
`deploy/update.sh` keeps running plain `node --test` with no `npm install`.
Per [AGENTS.md](../AGENTS.md) this is a design decision — record it there in
the same PR: *"Runtime dependencies: none, deliberately. Dev-only:
`typescript`, for `npm run typecheck`; it must never appear in
`dependencies` or be imported by shipped code."*

Add to `package.json`: the devDependency, and
`"typecheck": "tsc --noEmit"`. Create `jsconfig.json`:

```json
{
  "compilerOptions": {
    "checkJs": false, "strict": true, "noEmit": true,
    "target": "es2023", "module": "nodenext", "moduleResolution": "nodenext",
    "lib": ["es2023", "dom"]
  },
  "include": ["src", "public", "scripts"]
}
```

`checkJs: false` + per-file `// @ts-check` is the migration mechanism: only
opted-in files are checked, so each step below is a small PR that ends green.
(`dom` in `lib` because client files will opt in later; it does not affect
server files.)

Wire `npm run typecheck` into the CI test job in
`.github/workflows/deploy.yml` (after `npm test`; requires an `npm ci` step —
the lockfile this creates is the other artifact of B0). Do **not** add it to
`deploy/update.sh`: the host verifies behavior, CI verifies types.

**Acceptance:** `npm run typecheck` passes (trivially — nothing opted in),
CI runs it, `npm test` still needs no install.

### Step B1 — the shared shapes: lobby and rooms

In [src/lobby.js](../src/lobby.js), typedef the vocabulary everything else
imports:

```js
/** @typedef {{ id: string, name: string }} Player */
/** @typedef {{ key: string, params: Record<string, unknown>, at: number }} LogEntry */
/**
 * @typedef {Object} BaseState
 * @property {string} code
 * @property {string} gameId
 * @property {number} createdAt
 * @property {string} phase
 * @property {Player[]} players
 * ... (hostId, log, version — and seed/rng/actions if Part A landed)
 */
```

Enable `// @ts-check` in `lobby.js` and `rooms.js`; annotate function
signatures with `@param`/`@returns`. Expect a handful of honest findings
(`string | null` hostId flowing into places typed as string, etc.) — fix by
tightening code or widening types, whichever tells the truth.

**Acceptance:** typecheck green with both files opted in; no `@ts-ignore`
(use `@ts-expect-error` with a comment in the rare place dynamic code defeats
the checker, e.g. `setGame`'s delete/assign swap).

### Step B2 — per-game state, views, and the action union

The contract step — this is where drift gets caught.

- In each engine: `@typedef AvalonState` / `OnuwState` extending `BaseState`
  (intersection types via `BaseState & { ... }` work in JSDoc), and a typedef
  for its `viewFor` return shape (`AvalonView`, `OnuwView`).
- In [src/games/index.js](../src/games/index.js): typedef the registry entry
  (`create`, `addPlayer`, `viewFor`, `actions`, optional
  `nextDeadline`/`tick`) and a **discriminated union of action bodies**:

  ```js
  /** @typedef {{ type:'propose', team: string[] } | { type:'vote', approve: boolean } | ...} AvalonAction */
  ```

  Annotate the action tables so each handler's body parameter is its union
  member. Enable `// @ts-check` in `games/index.js` and both `game.js` files
  (do `rules.js` first; they are small and pure).

**Acceptance:** typecheck green. Prove value once: rename a field in
`AvalonView`'s typedef only and confirm `tsc` flags `viewFor` — the typedef
diff is now the mechanical tripwire behind the persistence plan's "state-shape
changes bump `STATE_VERSION`" rule. Note that in AGENTS.md: *a PR that touches
a `@typedef` in `src/games/` or `lobby.js` is a state/view contract change —
check whether `STATE_VERSION` or `API_PROTOCOL` must bump.*

### Step B3 — server and the client boundary

- Opt in `src/server.js` (and `src/persistence.js` if it exists). The health
  payload, `COMMON_ACTIONS`, and the JSON helpers get signatures.
- The real prize: opt in `public/games/avalon.js` and `public/games/onuw.js`
  and type their view parameter by **importing the server's typedef across
  the boundary** — types only, no runtime import, so the no-build rule holds:

  ```js
  /** @typedef {import('../../src/games/avalon/game.js').AvalonView} AvalonView */
  ```

  Now renaming a view field on the server breaks the client's typecheck in
  the same CI run — previously that shipped silently and broke mid-game.
- Opt in `public/app.js` last; it is the largest and most DOM-heavy file.
  Type `app` (the state object) and the transport; if `h(...)`'s dynamic
  props fight `strict`, type the helper generously in `public/ui.js` rather
  than sprinkling suppressions.

**Acceptance:** typecheck green across `src/` and `public/games/`; the
cross-boundary import demonstrably catches a renamed view field.

### Step B4 (optional) — flip the default

When every file carries `// @ts-check`, set `"checkJs": true` and delete the
per-file pragmas, so new files are checked by default. Only worth doing once
nothing is left out; a half-flipped default invites suppressions.

---

## Guardrails

- Part A must never change gameplay distribution: mulberry32 replaces
  `Math.random` draw-for-draw. Never reuse the room seed as the fuzzer's
  seed source of truth in tests you commit — pin fuzz seeds explicitly.
- `g.actions` and `g.seed`/`g.rng` are server-side state: they must not
  appear in any `viewFor` output (invariant 5 will also catch this — role
  deals are derivable from the seed, so **the seed itself is a secret**).
- Record-after-success in `dispatch` is load-bearing; a recorded-but-rejected
  action makes replays diverge. The golden replay tests exist to catch this.
- Type-only imports (`@typedef {import(...)}`) are erased by design; if a
  change makes a `public/` file import server code *at runtime*, that is a
  bug — the boundary in [architecture.md](architecture.md) still holds.
- Keep the fuzzer's runtime small and deterministic-by-default; a flaky or
  slow `npm test` degrades the deploy path on the host, which runs it before
  every restart.
