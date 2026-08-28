# Codebase cleanup tracker

This is the ordered handoff and progress tracker for the compatibility-free
cleanup. The implementation rows come first; behavior and protocol changes
start only after those rows are complete.

Fixed decisions:

- Keep the GitHub Pages client and its server-before-client release order.
- Keep four-character room codes and prevent collisions across live and
  restored rooms.
- Prefer the smallest implementation that satisfies the stated contract.
- Keep `npm test` as the dependency-free verification gate.

“Expected LOC effect” includes tests and docs and is directional, not a target.

## Implementation improvements

| Order | Tracking | Planned change | Involvement | Expected LOC effect | Why | Theirs / mine / combined |
|---:|:---:|---|---|:---:|---|---|
| 1 | - [x] | Remove confirmed-dead code, exports, imports, test seams, and translations | Mechanical | Reduces | Reduces obsolete surface area without changing supported behavior. | **Combined** — their review supplied the detailed inventory; mine also found obsolete randomness and unfinished-state concerns. |
| 2 | - [x] | Move server-side `API_PROTOCOL` into a lightweight standalone module | Mechanical | Maintains | Packaging and tests can read it without initializing the HTTP server. | **Combined** — they proposed the extraction, and it supports my broader contract cleanup. |
| 3 | - [x] | Finish standardizing the documented and enforced runtime on Node 24 | Mechanical | Maintains | Aligns the README with the package, CI, release manifest, verifier, and updater. | **Theirs** — they found the old Node 20 hosting claim; current deployment code already enforces Node 24. |
| 4 | - [x] | Keep the documentation index limited to maintained documents | Mechanical | Reduces | Prevents obsolete specifications from appearing current. | **Theirs** — their documentation housekeeping is partly complete on `main`; this tracker is the remaining index addition. |
| 5 | - [x] | Make release packaging fail reliably and publish only a completed archive | Small, high priority | Maintains | A failed pipeline must not leave a successful-looking partial release. | **Theirs** — they reproduced the masked pipeline failure; atomic output completes that fix. |
| 6 | - [x] | Detect unsupported deterministic-packaging tools clearly | Small | Adds | Distinguishes an unsupported local tar from an application regression. | **Theirs** — they identified the GNU/BSD tar portability issue. |
| 7 | - [ ] | Bound the in-memory avatar cache and use metadata for existence checks | Small | Adds | Prevents unbounded buffer retention and unnecessary whole-file reads. | **Combined** — their review found the exact cache and I/O issues; mine placed them within avatar resource management. |
| 8 | - [ ] | Make game lookup fail fast and handle timer edge cases correctly | Small | Maintains | Unknown games must not become Avalon, and deadline zero must remain a valid deadline. | **Mine** — these issues came from my registry and room-clock review. |
| 9 | - [ ] | Preserve four-character room codes while making allocation and restoration collision-safe | Small–medium | Adds | No two hosts may receive the same live code, even under forced collisions or malformed restoration data. | **Mine, revised** — this retains the selected code format while making uniqueness explicit. |
| 10 | - [ ] | Deduplicate shared house-rule, lobby-reset, and restart machinery | Medium | Reduces | Shared behavior should not drift between Avalon and ONUW. | **Combined** — they proposed focused helpers; mine found the same duplication at the room/game boundary. |
| 11 | - [ ] | Add development-only type checking for commands, state, views, snapshots, and phases | Medium, decision-gated | Adds | Machine-checked contracts could catch boundary drift without changing shipped JavaScript. | **Mine** — this follows my contract proposal, but adding a tool is a separate dependency decision under `AGENTS.md`. |
| 12 | - [ ] | Validate persisted snapshots fully and secure state/avatar storage permissions | Medium | Adds | Invalid rooms must not restore, and hidden state must remain private to the service account. | **Mine** — restore currently validates only part of the persisted contract. |
| 13 | - [ ] | Separate shared room/session state from game-engine state behind one explicit game interface | Involved | Maintains | Room concerns become independent from the two rule engines. | **Mine** — this combines the room envelope and game-interface work. |
| 14 | - [ ] | Modularize the Pages client and remove mutable game-module binding globals | Involved | Maintains | Transport, session, rendering, audio, and clocks gain explicit ownership without changing UI behavior. | **Mine** — this consolidates the client-refactoring work. |
| 15 | - [ ] | Complete deterministic replay for accepted commands and timer transitions | More involved | Adds | The existing seed and journal should reproduce a room rather than act as partial persistent state. | **Mine** — the other review left the incomplete replay path unchanged. |
| 16 | - [ ] | Strengthen the dependency-free suite with invariants and deterministic fuzzing | More involved | Adds | Secret projection, clocks, transitions, and replay need broader coverage than scripted examples. | **Mine, revised** — this retains the high-value test work while following the repository’s no-browser, single-gate rule. |

## Feature, protocol, or externally observable behavioral changes

| Order | Tracking | Planned change | Involvement | Expected LOC effect | Why | Theirs / mine / combined |
|---:|:---:|---|---|:---:|---|---|
| 17 | - [ ] | Strictly validate API requests and return accurate HTTP statuses | Small–medium | Adds | Non-object JSON must not cause 500s, and absence, conflict, size, and rate errors should be distinct. | **Mine** — I reproduced the malformed-request failures and the broad error mapping. |
| 18 | - [ ] | Make server views authoritative and phase-specific | Medium | Maintains | The Pages client should consume server-owned metadata and receive only fields valid for the current phase. | **Combined** — they proposed server metadata; mine adds discriminated public views. |
| 19 | - [ ] | Add configurable room, request, join, action, and avatar-work limits | Medium | Adds | Public endpoints need finite memory, work, and provider-quota exposure. | **Mine** — this is the abuse-resistance portion of my public-server review. |
| 20 | - [ ] | Add a complete avatar lifecycle policy | Medium | Adds | Persistent quotas, retention, and stale-job protection bound disk use and asynchronous races. | **Combined** — their review identified memory growth; mine extends it to persistent resources and ordering. |
| 21 | - [ ] | Add real seat authentication while retaining Pages and multi-seat test mode | Involved, critical | Adds | A public seat ID must not authorize private views or actions. | **Mine, Pages-compatible** — this combines the authentication and cross-origin transport consequences. |

## Implementation handoff

### Rules for the coding agent

- Work in table order. Finish and verify implementation items 1–16 before
  beginning behavior items 17–21.
- Prefer direct functions and explicit data over frameworks, generalized
  abstractions, hooks, or configuration for hypothetical uses.
- Do not add dependencies. Item 11 requires a separate proposal and explicit
  approval before changing `package.json`; leave it unchecked if approval is
  not provided. Do not introduce a browser suite under item 16.
- Comments may record a durable invariant or external constraint. Do not use
  comments to defend an implementation, narrate a refactor, compare versions,
  or justify a change.
- Follow the documentation rule in `AGENTS.md`: update the canonical document,
  state the core idea, and point to code or tests for operational detail.
- Keep the Pages deployment and four-character room-code decisions above.
- Run `npm test` after each coherent source change. It remains the complete
  gate; add new tests to it rather than creating a parallel required suite.
- Keep `API_PROTOCOL` and `STATE_VERSION` unchanged for internal refactors.
  Bump only the number whose contract actually breaks, and rely on
  `deploy/updater.sh` for rollout safety.

### Batch 1 — mechanical cleanup

Items: 1–4.

Implementation:

1. Use repository-wide references to confirm each removal. Current candidates
   include `defaultShuffle`, `openStepForTests`, unused imports/exports, and
   unreachable translations; retain anything used by computed i18n keys or
   later batches.
2. Add `src/api-protocol.js`; import it from `src/server.js`, the release
   manifest writer, and server-side tests. Keep the standalone constant in
   `public/app.js` and its equality test because Pages ships independently.
3. Replace the remaining Node 20 claim in `README.md`; use `package.json` and
   the release verifier as the authoritative version contract.
4. Keep `docs/README.md` limited to files that exist and are maintained.

Acceptance: `npm test` passes; manifest generation does not load the server;
server/client protocol and translation parity tests still pass; no deleted
symbol remains referenced.

### Batch 2 — packaging

Items: 5–6.

Implementation:

1. In `scripts/package-release.sh`, replace both unchecked pipelines with
   separately checked archive, extraction, tar, and gzip operations.
2. Build under a temporary name in the requested output directory and rename
   only after verification; cleanup must remove partial output on every error.
3. Check the deterministic tar capabilities used by the script and return a
   concise unsupported-tool error before packaging.
4. Extend `test/release.test.js` with controlled tar/gzip failures and two
   packages of the same commit. Keep the archive-content expectations aligned
   with the static updater files named there.

Acceptance: forced failures return nonzero and leave no final archive; two
successful packages are byte-identical; `npm test` passes.

### Batch 3 — bounded resources and strict identity helpers

Items: 7–9. Complete item 9’s restoration half in Batch 5.

Implementation:

1. In `src/avatars.js`, use metadata operations for existence and replace the
   memory map with a small constructor-configurable LRU. Preserve disk fallback
   and the directory-free test mode.
2. Change both game registries to reject unknown IDs. Convert that failure to
   the existing public game error at the request boundary.
3. In room scheduling, distinguish absent deadlines from numeric zero.
4. Centralize room-code allocation. Preserve the current alphabet and length,
   use `node:crypto`, check the live map before returning, and terminate with a
   capacity error if the finite space is exhausted. Inject candidate selection
   so tests can force repeated collisions.

Acceptance: cache eviction/refresh, metadata existence, unknown games,
deadline zero, collision retry, and exhaustion are covered by `npm test`; an
existing room can never be overwritten.

### Batch 4 — shared game mechanics

Item: 10. Item 11 is handled only if its dependency proposal is approved.

Implementation:

1. Extract the shared operations actually used by both games: house-rule
   defaults/normalization/patching and durable lobby reset/restart behavior.
2. Keep game-specific keys and defaults in each game’s module. Do not create a
   generic option framework.
3. If item 11 is approved, submit its tool choice, lockfile, no-emit setup,
   scripts, CI change, and initial boundary types as one isolated PR. Shipped
   server and Pages code must remain plain modules with no runtime install.

Acceptance: both games retain their defaults and reset behavior; `npm test`
passes. Any approved type-check command also passes, but does not replace the
repository gate.

### Batch 5 — room boundary and persistence

Items: 12–13 and the restoration portion of 9 and 10.

Implementation:

1. Make a room own identity, roster/host, log, activity/revision, deterministic
   random state, journal, subscribers, timers, and persistence notification.
   Store the selected game as `{ id, state }`.
2. Give each registry entry explicit create, roster-change, command, view,
   deadline/tick, and restore-validation operations. Include only operations
   used by Avalon or ONUW.
3. Make the room registry the single successful-mutation boundary for revision,
   persistence, broadcast, and timer scheduling. Game switching replaces only
   the game member.
4. Validate the full snapshot and both game-state variants before installing
   any room. Reject duplicate codes and invalid cross-references as one bad
   snapshot rather than partially restoring it.
5. Set private state-directory, umask, and persisted-file modes in the owning
   systemd/unit and persistence code.
6. Bump `STATE_VERSION` once because the stored room shape changes. Update only
   the canonical persistence/deployment docs and version tests.

Acceptance: round trips preserve lobbies, active games, results, random state,
activity, and ONUW deadlines; malformed or duplicate snapshots start empty;
game states contain no room-owned fields; `npm test` passes.

### Batch 6 — Pages client modules

Item: 14.

Implementation:

1. Keep `public/app.js` as the composition entrypoint and any compatibility
   surface directly used by tests.
2. Separate storage, API/stream transport, room session, test-mode seats,
   shared rendering, and ONUW audio/clock ownership along existing behavioral
   seams.
3. Replace mutable game-module `bind()` state with explicit construction or
   render context. Teardown streams, timers, and audio when their owner exits.
4. Preserve storage keys, payloads, Pages backend selection, native event
   streaming, reconnect rules, URLs, and rendered behavior in this batch.

Acceptance: current UI/reconnect tests pass; renderers have no mutable binding
globals; leaving or switching stops owned audio/timers; `npm test` passes.

### Batch 7 — replay and invariant coverage

Items: 15–16.

Implementation:

1. Define a room journal that starts with creation metadata and records every
   accepted player command plus autonomous timer transitions. Never record a
   rejected command; preserve the existing all-or-nothing cap semantics.
2. Add a test helper that rebuilds a room from the journal with injected time
   and compares normalized state excluding runtime-only resources.
3. Add golden replays for both games, switching, reset, and play-again.
4. Add independently expressed invariants for serialization, legal phases,
   roster maps, deadlines, deterministic random state, and per-viewer secrets.
5. Add a small deterministic, dependency-free command fuzzer whose failures
   print a seed or journal that can be replayed.

Acceptance: golden states reproduce exactly; fixed-seed fuzzing is repeatable;
an intentional secret leak is caught before being reverted; `npm test` stays
fast and passes without network or browser access.

### Batch 8 — API and views

Items: 17–18.

Implementation:

1. Treat parsed JSON as unknown and validate every request body before room or
   engine dispatch.
2. Centralize mapping to structured client errors and accurate status classes
   for malformed, missing, conflicting, oversized, and unexpected requests.
3. Add server-owned option/rule/player-limit metadata to views, migrate Pages
   to it, then remove client duplicates.
4. Make views discriminated by game and phase. Stage additions before removals;
   bump `API_PROTOCOL` when a deployed client contract first breaks.

Acceptance: null/array/wrong-type bodies cannot cause 500; route status cases
and every view variant have tests; Pages contains no duplicated server-owned
metadata; `npm test` passes.

### Batch 9 — public-service limits and avatar lifecycle

Items: 19–20.

Implementation:

1. Add a dependency-free limiter with injected time and bounded key storage
   for room creation, joins, actions, and concurrent avatar work. Trust
   forwarded addresses only behind explicit proxy configuration.
2. Add finite, documented settings for the limits and return structured 429 or
   capacity responses.
3. Persist avatar-generation quota history atomically beside other private
   state; prune expired entries on restore.
4. Sweep unreferenced avatars by age and total storage. Never delete an avatar
   referenced by a live room.
5. Tie async avatar completion to the request generation so stale work cannot
   replace a newer upload, name, or generation.

Acceptance: refill/exhaustion/key eviction/proxy behavior, restart-persistent
quota, cleanup ordering, referenced-file retention, and stale completions are
deterministically covered by `npm test`.

### Batch 10 — authenticated seats

Item: 21 and the final breaking portion of 18.

Implementation:

1. Issue a high-entropy secret when a seat is created; persist only its digest
   and keep the public seat ID as identity, never authority.
2. Derive the viewer/actor from the verified secret for private views, actions,
   rejoin, and leave. Remove actor IDs from authenticated action bodies.
3. Adapt the extracted Pages transport to authenticated streaming fetch and
   restricted configured-origin CORS. Never put credentials in URLs, views,
   events, errors, or logs.
4. Store versioned credentials per controlled test-mode seat. Do not add a
   public-ID-to-secret upgrade path.
5. Remove unauthenticated private endpoints and obsolete broad view fields in
   the same coordinated release. Bump `STATE_VERSION` for persisted credentials
   and `API_PROTOCOL` for the network contract.
6. Update `docs/api.md` and `docs/security.md` with only the new durable
   contract; keep transport details authoritative in server/client code.

Acceptance: knowing another public seat ID cannot expose its private view or
authorize any action; cross-origin Pages reconnect and multi-seat test mode use
real credentials; old private paths fail; credential-leak tests and `npm test`
pass.

### Completion

After each batch, check only rows whose implementation, tests, and canonical
docs are complete, and add its PR link next to the row if useful. At the end,
run `npm test`, `git diff --check`, the translation audit, and an unused-code
audit. Do not close the tracker while a temporary compatibility adapter,
unbounded cache, unauthenticated private route, or skipped required test
remains.
