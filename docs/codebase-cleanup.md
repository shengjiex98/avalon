# Codebase cleanup tracker

This document tracks the compatibility-free codebase cleanup review. Detailed
implementation plans will be appended here before work begins on the affected
areas.

Decisions already made:

- The GitHub Pages client remains a supported deployment target.
- Room codes remain four characters.
- Implementation-only improvements are completed before feature, protocol, or
  externally observable behavioral changes.

Mark an item complete only after its implementation, tests, and documentation
are finished. “Expected LOC effect” predicts the net repository line-count
effect after the associated tests and documentation are included; it is a
directional estimate, not a target.

## Implementation improvements

| Order | Tracking | Planned change | Involvement | Expected LOC effect | Why | Theirs / mine / combined |
|---:|:---:|---|---|:---:|---|---|
| 1 | - [ ] | Remove confirmed-dead code, exports, imports, test seams, and translations | Mechanical | Reduces | Reduces obsolete surface area without changing supported behavior. | **Combined** — their review provided the detailed inventory; mine also identified obsolete randomness and unfinished state concerns. |
| 2 | - [ ] | Move server-side `API_PROTOCOL` into a lightweight standalone module | Mechanical | Maintains | Packaging and tests can read it without initializing the HTTP server and its dependencies. | **Combined** — they proposed the extraction, and it supports my broader contract cleanup. |
| 3 | - [ ] | Standardize the documented and enforced Node version, likely on Node 24 | Mechanical | Maintains | Aligns the README, `package.json`, CI, release manifest, verifier, and controller. | **Theirs** — they found the mismatch between the Node 20 self-hosting claim and the Node 24 deployment requirement. |
| 4 | - [ ] | Clean up the documentation index and remove only plans confirmed stale in the current checkout | Mechanical | Maintains | Keeps active technical plans discoverable and prevents obsolete specifications from appearing current. | **Theirs** — the documentation housekeeping came from their review, although some referenced stale files are already absent here. |
| 5 | - [ ] | Make release packaging fail reliably and publish artifacts atomically | Small, high priority | Maintains | Ensures `tar` or `gzip` failure cannot produce a successful-looking partial archive or checksum. | **Theirs** — they identified and reproduced the masked pipeline failure; atomic publication is the natural completion of that fix. |
| 6 | - [ ] | Detect unsupported deterministic packaging tools and report platform limitations clearly in tests | Small | Adds | Distinguishes an unsupported local tar implementation from an application regression. | **Theirs** — they identified the GNU/BSD tar portability issue. |
| 7 | - [ ] | Bound the in-memory avatar cache and use metadata operations for existence checks | Small | Adds | Prevents unbounded image-buffer retention and avoids reading whole files merely to determine whether they exist. | **Combined** — their review found the exact cache and I/O issues; mine placed them within avatar resource management. |
| 8 | - [ ] | Make game lookup and timer handling fail fast and handle edge cases correctly | Small | Maintains | Unknown games should not silently become Avalon, and deadline zero should not mean “no timer.” | **Mine** — these issues came from my registry and room-clock review. |
| 9 | - [ ] | Preserve four-character room codes while making allocation and restoration collision-safe | Small–medium | Adds | Guarantees that no two live or restored rooms share a code, including when generated candidates collide. | **Mine, revised** — this retains the chosen format while strengthening allocation, retry, exhaustion, and duplicate-snapshot handling. |
| 10 | - [ ] | Deduplicate shared house-rule, lobby reset, and restart machinery | Medium | Reduces | Prevents Avalon and ONUW from developing different implementations of behavior intended to be identical. | **Combined** — they proposed focused helpers, while mine identified the same duplication through the room/game boundary. |
| 11 | - [ ] | Add development-only type checking for commands, state, views, snapshots, and phases | Medium | Adds | Makes existing contracts machine-checkable while preserving the dependency-free runtime and Pages output. | **Mine** — this follows my contract proposal and the repository’s existing types plan. |
| 12 | - [ ] | Validate persisted snapshots fully and secure state/avatar storage permissions | Medium | Adds | Prevents structurally invalid rooms from being restored and protects hidden state and credentials from other local users. | **Mine** — the current restore path validates only shallow identifiers and the service does not explicitly enforce private modes. |
| 13 | - [ ] | Separate shared room/session state from game-engine state behind one explicit game interface | Involved | Maintains | Players, hosting, identity, activity, RNG, logs, revision, and replay data become room concerns; engines retain only game rules and state. | **Mine** — this folds the room envelope and game-interface tasks back into one architectural change. |
| 14 | - [ ] | Modularize the Pages client and remove mutable game-module binding globals | Involved | Maintains | Separates transport, session, storage, rendering, test mode, ONUW audio, and clocks without changing supported UI behavior. | **Mine** — this consolidates the previously expanded client refactoring tasks. |
| 15 | - [ ] | Complete deterministic replay for accepted player commands and autonomous timer transitions | More involved | Adds | Turns the existing seed and action journal into a reliable reproduction tool rather than partial persistent state. | **Mine** — the other review left the incomplete replay path unchanged. |
| 16 | - [ ] | Strengthen testing with invariants, fuzzing, and a small real-browser Pages suite | More involved | Adds | Covers secret projection, clocks, reconnection, cross-origin behavior, and browser semantics beyond scripted examples and the DOM shim. | **Mine** — this combines the previously separate fuzzing and browser-test tasks. |

## Feature, protocol, or externally observable behavioral changes

| Order | Tracking | Planned change | Involvement | Expected LOC effect | Why | Theirs / mine / combined |
|---:|:---:|---|---|:---:|---|---|
| 17 | - [ ] | Strictly validate API requests and return accurate HTTP statuses | Small–medium | Adds | Valid non-object JSON currently causes 500s, while missing rooms, conflicts, and oversized payloads need distinct responses. | **Mine** — I reproduced the malformed-request failures and identified the current all-400 error mapping. |
| 18 | - [ ] | Make server views authoritative and phase-specific | Medium | Maintains | The Pages client should receive option keys, house-rule keys, player limits, and only the fields valid for the current game phase. | **Combined** — they proposed server-supplied metadata; mine adds discriminated, phase-specific public contracts. |
| 19 | - [ ] | Add configurable room, request, join, action, and avatar-work limits | Medium | Adds | Prevents an unauthenticated public endpoint from consuming unbounded memory or external-provider quota. | **Mine** — this is the abuse-resistance portion of my public-server review, separate from four-character code allocation. |
| 20 | - [ ] | Add a complete avatar lifecycle policy | Medium | Adds | Disk retention, persistent generation quotas, and stale-job protection prevent indefinite growth, restart-based quota resets, and outdated results. | **Combined** — their review identified memory growth; mine extends management to persistent files, quotas, and asynchronous ordering. |
| 21 | - [ ] | Add real seat authentication while retaining GitHub Pages and multi-seat test mode | Involved, critical | Adds | Public seat IDs must no longer authorize actions or private views; the Pages client will use secret seat tokens, authenticated streaming `fetch`, restricted CORS, credential-aware reconnection/test mode, and a coordinated protocol bump. | **Mine, Pages-compatible** — this folds all authentication consequences into one security change and explicitly preserves the Pages architecture. |

## Detailed implementation plan

This section is the handoff for the coding agent. The batches below are ordered
so that each one leaves the repository deployable and provides the foundation
needed by later work. A batch may use several commits, but its tracker items
must not be checked until all of its acceptance criteria pass.

### Fixed constraints

- Keep the GitHub Pages client, configurable HTTPS backend, CORS support, and
  server-before-Pages deployment order.
- Keep four-character room codes using the existing unambiguous alphabet.
- Keep runtime dependencies at zero. Development-only dependencies must be
  justified in `AGENTS.md`, must not be imported by shipped code, and must not
  be needed by the host-side `npm test` gate.
- Preserve the pure game-rule modules and per-player secret projection. Do not
  introduce a generic game framework beyond the explicit interface described
  below.
- Prefer the simplest implementation that completely satisfies the behavior,
  safety properties, and tests. Do not add abstraction layers, configuration,
  hooks, indirection, or generalized framework code for hypothetical future
  needs. When two designs are equally correct, choose the one with fewer
  concepts and less code.
- Prefer self-explanatory names and structure over source comments. Comments
  may document durable invariants, external contracts, security boundaries, or
  genuinely non-obvious constraints, but must not justify or defend an
  implementation, narrate a refactor, compare old and new code, or explain why
  a change was made. Change rationale belongs in this tracker and the commit or
  PR description, not in source comments.
- Any documentation added or changed must follow `AGENTS.md`, including its
  architecture, deployment, verification, compatibility, and live-deployment
  rules. Update the canonical existing document instead of creating a parallel
  explanation when one already owns the subject.
- Do not mix unrelated visual redesign or game-rule changes into this work.
- Preserve user changes already present in the worktree.
- Run `npm test` after every coherent source change, not only at the end of a
  batch. Run the additional checks introduced by later batches as well.

### Versioning and deployment strategy

Most batches are internal and must not change `API_PROTOCOL` or
`STATE_VERSION`.

1. Batch 5 deliberately replaces the persisted room shape. Bump
   `STATE_VERSION` once in that batch and update the release, persistence, gate,
   and documentation tests that assert it. Do not bump the API protocol because
   player views and actions remain unchanged in that batch.
2. Batch 8 initially adds view metadata and improves error responses without
   removing fields old clients use. It therefore remains on the current API
   protocol.
3. Batch 10 is the coordinated breaking cutover. It adds seat credentials,
   removes actor IDs from action payloads, changes event transport, and removes
   legacy broad-view fields. Bump both `STATE_VERSION` and `API_PROTOCOL` once
   there.
4. The incompatible state bump makes the deployment gate wait until active
   games have cleared before Batch 10 restarts the server. Lobby rooms may be
   discarded, which is accepted for this compatibility-free cleanup.
5. The deployment workflow continues to publish the server first. During the
   short interval before Pages takes the same commit, the old Pages client will
   show its existing explicit protocol-mismatch screen. Do not weaken that
   check.

If several batches are intentionally merged into one release, consolidate
adjacent state bumps rather than incrementing twice in one commit. After the
cutover, resume the repository's normal compatibility rules for future work.

### Batch 1 — mechanical cleanup and lightweight constants

Tracker items: 1–4.

#### Work

1. Re-run an unused-code audit before deleting anything. Remove only symbols
   that have no production, test, documentation, generated-module, or planned
   near-term consumer.
2. Expected safe removals include the unused `defaultShuffle`,
   `openStepForTests`, the unused `gameFor` import in `src/server.js`, and the
   unused `GameError` pass-through export from Avalon rules. Reconfirm each at
   implementation time.
3. Do **not** remove `PHASES`; Batch 7 uses it for invariant checks. Do not
   remove the server registry's player limits; Batch 8 makes them authoritative.
   Leave room-code helpers until Batch 3 replaces them.
4. Audit allegedly dead translations against both literal and computed keys.
   Delete only keys proven unreachable, in both languages together. Keep the
   i18n parity and coverage tests green.
5. Create `src/api-protocol.js` containing the server-side protocol constant.
   Import it from the server, release-manifest writer, and relevant tests.
   Retain the Pages client's own constant because `public/` is deployed as a
   standalone artifact; keep the test that proves the two values agree.
6. Standardize on Node 24: update `package.json.engines`, README self-hosting
   instructions, and any other claim that Node 20 is supported. Keep CI,
   release manifests, the verifier, and controller on Node 24.
7. Add the live determinism/types plan and this tracker to `docs/README.md`.
   Delete no planning document merely because another checkout once contained
   a stale file.

#### Acceptance

- `npm test` passes.
- The release manifest can be generated without importing `src/server.js`.
- Server and Pages protocol constants are still asserted equal.
- English and Chinese translation key sets remain identical.
- Tracker items 1–4 are checked only after documentation and tests reflect the
  cleanup.

### Batch 2 — reliable and portable release packaging

Tracker items: 5–6.

#### Work

1. Remove unchecked shell pipelines from `scripts/package-release.sh`.
   Materialize the `git archive` tar in the staging directory, extract it in a
   separately checked command, and build the final deterministic tar before
   compressing it in another separately checked command.
2. Create the archive and checksum under temporary names in the destination
   directory. Rename them to their final names only after tar creation,
   compression, checksum generation, and archive verification succeed. Extend
   the cleanup trap to remove every temporary output.
3. Add an early capability check for the deterministic tar options actually
   required (`--sort=name`, fixed `--mtime`, numeric owner/group). On an
   unsupported tar, exit nonzero with a concise message naming the missing
   capability; never print an archive path.
4. Teach `test/release.test.js` to distinguish an unsupported packaging tool
   from a broken package. The artifact-content contract must still run in CI
   and on supported local platforms.
5. Add regression coverage with a controlled failing tar/gzip command or PATH
   fixture. Assert that the script exits nonzero, prints no successful archive
   path, and leaves no final archive/checksum pair.
6. Package the same commit twice in separate directories and assert identical
   checksums, preserving deterministic release output.

#### Acceptance

- A forced tar failure and forced gzip failure both fail the script.
- No partial final artifact survives either failure.
- Two successful packages of the same commit are byte-identical.
- The packaged release still contains the complete deployment control plane.
- `npm test` passes on the supported Node 24/GNU tar path.

### Batch 3 — bounded avatar memory, strict lookup, and room allocation

Tracker items: 7–9. Item 9 remains open until duplicate snapshot codes are also
rejected in Batch 5.

#### Work

1. Replace avatar file-existence reads with `fs.access` or `fs.stat`.
2. Turn `Avatars.memory` into a small dependency-free LRU cache. Make the limit
   constructor-injectable for tests and give production a documented finite
   default. Reads and writes refresh recency; insertion evicts the oldest entry
   once the cap is exceeded. Preserve the in-memory mode used by tests when no
   directory exists.
3. Make the server and browser game registries reject unknown game IDs rather
   than silently returning Avalon. External invalid input must still be turned
   into the existing translatable game error at the proper boundary.
4. In room scheduling, treat only `null`/`undefined` as no deadline. A numeric
   deadline of zero is valid.
5. Preserve the four-character alphabet and introduce one room-code allocator.
   Use `node:crypto.randomInt` to select candidates or a random starting point;
   never use `Math.random` for room codes.
6. Make the allocator injectable so tests can force repeated collisions. It
   must check the live/restored room map before returning and must terminate
   with a defined translatable capacity error rather than loop forever if the
   code space is exhausted.
7. Keep explicit requested codes as an internal test/replay facility. They must
   reject a collision and must never be exposed as a public API option.

#### Acceptance

- Cache tests prove eviction order, recency refresh, and disk fallback.
- Existence checks do not read avatar contents.
- Unknown game IDs fail instead of selecting Avalon.
- A fake clock with deadline zero schedules and advances correctly.
- Forced room-code collisions never overwrite an existing room and eventually
  return a different four-character code.
- `npm test` passes.

### Batch 4 — shared helpers and type-checked existing contracts

Tracker items: 10–11. Complete the reset/restart portion of item 10 in Batch 5
rather than creating a temporary abstraction that the room envelope deletes.

#### Work

1. Extract only durable shared house-rule operations: construct defaults,
   construct all-disabled rules, normalize stored rules, and apply a partial
   host patch over a known key set. Keep each game's default values and keys in
   its rules module.
2. Migrate both games to the shared operations and retain every existing
   default and restore behavior. Do not introduce a configurable framework for
   game-specific options.
3. Add TypeScript as a development-only dependency with a lockfile and a
   no-emit configuration suitable for Node ESM and browser DOM code.
4. Add `npm run typecheck`. Use `// @ts-check` plus JSDoc incrementally so the
   runtime remains plain JavaScript and Pages still ships source modules
   without a build step.
5. Define shared type declarations for player, log entry, command record,
   error response, room snapshot, game state, and per-game views. A declaration
   file under `types/` may be referenced from both `src/` and `public/` without
   becoming a runtime import or Pages artifact.
6. Opt in the stable foundation first: lobby helpers, rules modules, game
   registry, rooms, and persistence. Type the client transport/view boundary
   before Batch 6 moves it.
7. Record in `AGENTS.md` that TypeScript is dev-only and may never become a
   runtime dependency or shipped import.
8. In CI and the deployment workflow's source test job, run `npm ci` and
   `npm run typecheck`. Do not run typechecking in the host controller's
   extracted-release test gate, which intentionally requires no install.

#### Acceptance

- `npm test` and `npm run typecheck` pass.
- `npm start` and the packaged release need no installed dependency.
- No emitted build files exist.
- House-rule tests prove identical defaults, patches, and restoration behavior
  for both games.

### Batch 5 — room envelope, explicit game interface, and strict snapshots

Tracker items: 10, 12–13, and the restoration portion of item 9.

This is the first intentional state-breaking batch.

#### Target persisted shape

```text
RoomState
├── code, createdAt, touchedAt, revision
├── players, hostId
├── log
├── random: { seed, state }
├── journal metadata and accepted commands
└── game: { id, state }
```

Subscribers and timers remain runtime-only fields held by the room registry.
Game state contains no room code, roster, host, room log, subscriber, timer,
credential, revision, or persistence metadata.

#### Game definition contract

Each registry entry exposes the same narrow operations:

- `create(room, context) -> gameState`
- `onRosterChanged(gameState, room, context)` when a lobby roster changes
- `handle(gameState, room, actorId, command, context) -> gameState`
- `view(gameState, room, viewerId, context) -> public view`
- optional `nextDeadline(gameState) -> number | null`
- optional `tick(gameState, room, context) -> boolean`
- `validateState(value, room) -> validated gameState` for restoration

The context owns time, deterministic random draws/shuffling, and room logging.
Handlers may mutate and return the same game state; reset/restart handlers may
return a fresh replacement. Avoid adding lifecycle hooks not needed by either
current game.

#### Work

1. Introduce the room envelope while keeping all HTTP actions and emitted view
   fields unchanged.
2. Move joining, leaving, host succession, avatar references, activity,
   revision, logs, RNG, and the command journal into the room layer.
3. Adapt the two engines to receive roster/host/context rather than reading
   those fields from engine state. Retain the pure rules modules unchanged.
4. Make game switching replace only `room.game`; never delete arbitrary object
   keys in place.
5. Implement reset/restart through the definition contract so the shared room
   survives and each game deliberately preserves only its lobby settings.
6. Make `Rooms.apply` the only mutation wrapper. It updates room revision,
   activity, persistence notification, broadcast, and scheduling exactly once
   after a successful mutation.
7. Build complete runtime validators for the room envelope and each game
   discriminant. Validate primitive types, finite timestamps, uint32 RNG state,
   unique player IDs/names, an existing host, phases, player-keyed maps,
   deadlines, journal records, and game-specific invariants needed for safe
   view/tick execution.
8. Validate an entire snapshot before installing any room. Duplicate room
   codes or any invalid entry make the snapshot unusable and start the registry
   empty with a diagnostic reason; never partially overwrite one room with
   another.
9. Apply private storage settings: `StateDirectoryMode=0700`, `UMask=0077`,
   and explicit private snapshot/quota file modes. Preserve immutable public
   caching for avatar HTTP responses while keeping files private on the host.
10. Bump `STATE_VERSION` once and update persistence, release-manifest,
    deployment-gate, documentation, and tests.

#### Acceptance

- Existing game, room, server, UI, persistence, determinism, and deployment
  tests pass with unchanged player-visible behavior.
- Neither game state contains room-level fields.
- Switching games and resetting no longer delete/reassign arbitrary combined
  state properties.
- Snapshot round-trip restores lobbies, active games, results, RNG, activity,
  and ONUW deadlines exactly.
- Every malformed snapshot fixture, including duplicate codes, starts empty
  without crashing or exposing a partial registry.
- A deployment with the new state version follows the existing incompatible
  update gate.
- `npm test` and `npm run typecheck` pass.

### Batch 6 — modular Pages client with unchanged behavior

Tracker item: 14.

#### Work

1. Keep `public/app.js` as the small composition entrypoint and compatibility
   facade for tests that import `app`, `render`, or `ready`.
2. Extract modules with one responsibility each: local storage, HTTP API,
   stream/reconnection transport, room/session lifecycle, shell/navigation,
   test-mode seat management, and shared rendering helpers.
3. Extract ONUW announcement/audio state and countdown painting from its phase
   renderer. Ensure teardown occurs when changing game, leaving a room,
   muting, replacing a stream, or loading a new night step.
4. Replace each game module's mutable `bind()` globals with a factory or pure
   render functions receiving an explicit context and current view/UI state.
5. Preserve current local-storage keys, native `EventSource`, API payloads,
   Pages backend selection, URL/hash behavior, reconnect timing, audio behavior,
   and DOM output. Authentication transport changes belong only to Batch 10.
6. Move tests alongside the new boundaries only when useful; do not rewrite the
   broad UI suite merely to match file layout.

#### Acceptance

- Existing UI and reconnect tests pass without changing expected behavior.
- Game renderers have no writable module-global binding context.
- Leaving/switching reliably stops ONUW timers and audio.
- Both the Node-served client and stamped Pages module graph load successfully.
- `npm test` and `npm run typecheck` pass.

### Batch 7 — complete replay, invariants, fuzzing, and browser coverage

Tracker items: 15–16.

#### Work

1. Define the journal as a room-level record beginning with code, initial game
   ID, seed, and creation time. Record every successful player command after it
   applies, including joins, leaves, game switches, resets, and play-again.
   Rejected commands must never enter the journal.
2. Record autonomous timer advancement as an explicit system entry with the
   clock value used by `tick`. Avatar completion is not a game command and need
   not participate in engine replay.
3. Preserve the all-or-nothing journal cap: if the maximum is exceeded, discard
   the journal and mark it unavailable rather than retaining a misleading
   suffix.
4. Add `test/helpers/replay.js` that rebuilds a room solely from journal
   metadata and entries on an injected clock. Compare normalized room/game
   state while excluding runtime subscribers, timers, and avatar bytes.
5. Add complete golden replays for Avalon, timed ONUW, game switching, reset,
   and play-again.
6. Add invariant helpers for JSON serializability, legal phase, roster/map
   consistency, deadline settlement, deterministic RNG, and per-viewer secret
   entitlement. Write entitlement rules independently of the production view
   function so a shared bug cannot make the test agree with itself.
7. Add a deterministic lightweight fuzzer using the stored PRNG rather than a
   runtime dependency. Failures must print a replayable seed/journal fixture.
8. Add a development-only real-browser test dependency and a separate CI job
   for a small Chromium suite. It must not be installed or run by the production
   host controller.
9. Serve client and API on different localhost origins in browser tests so the
   Pages configuration and CORS path are real. Cover initial load, room join,
   one full smoke path per game, deployment reconnect, and mobile viewport
   layout. Authentication isolation is added in Batch 10.

#### Acceptance

- Golden replay final states deep-equal their originals.
- Fixed-seed fuzzing is deterministic, fast, and prints a usable reproduction
  on failure.
- A temporary deliberate secret leak is caught by the independent entitlement
  invariant before being reverted.
- Browser tests exercise a distinct client/API origin and pass in CI.
- `npm test`, `npm run typecheck`, and the browser suite pass.

### Batch 8 — strict API boundary and authoritative additive views

Tracker items: 17 and the additive portion of 18.

#### Work

1. Treat parsed JSON as `unknown`. Add small explicit validators for every
   create, join, and action body; reject `null`, arrays, wrong primitive types,
   oversized collections, unknown command types, and invalid target IDs before
   engine dispatch.
2. Centralize error-to-HTTP mapping while preserving the translated
   `{ error, params }` body: 400 for malformed requests, 404 for absent
   resources, 409 for valid commands conflicting with current room/game state,
   413 for payload limits, 422 where a structurally valid command has invalid
   values, 429 for Batch 9 limits, and 500 only for unexpected faults.
3. Add authoritative game metadata to views: supported option keys,
   house-rule descriptors/keys, minimum and maximum players, and any public role
   metadata currently duplicated by the Pages modules.
4. Deploy metadata additively first. Update the Pages client to consume it,
   then remove its hard-coded lists only after all relevant UI tests use
   server-produced views.
5. Define discriminated phase-view types now, but retain legacy fields required
   by the current Pages client. Actual removal of broad null/undefined fields is
   deferred to the Batch 10 protocol bump.
6. Keep `API_PROTOCOL` unchanged in this batch because supported old payloads
   remain accepted and old view fields remain present.

#### Acceptance

- JSON `null` against create, join, and action returns a structured client
  error rather than 500.
- Every route has tests for malformed input, wrong method, missing resource,
  conflict, and payload limit.
- The Pages client contains no duplicated option, house-rule, or player-limit
  list that the server now supplies.
- Existing clients would still find their required fields in the additive
  server view.
- `npm test`, `npm run typecheck`, and browser tests pass.

### Batch 9 — configurable abuse limits and complete avatar lifecycle

Tracker items: 19–20.

#### Work

1. Add a dependency-free token-bucket/rolling-window limiter with injected
   time and bounded key storage. Centralize 429 responses and include
   `Retry-After`.
2. Add documented environment settings for maximum live rooms, room creation,
   join attempts per room/address, actions per seat, and concurrent avatar
   work. Choose defaults high enough for normal 3–10 player tables and test
   mode but finite enough to bound the public service.
3. Use `req.socket.remoteAddress` by default. Honor forwarded client addresses
   only behind an explicit trusted-proxy setting; never trust forwarding
   headers automatically. After Batch 10, key authenticated action limits by
   the verified seat rather than the submitted public ID.
4. Return a translatable capacity/rate error and document all limits. Ensure a
   full room-code space or maximum-room condition terminates cleanly.
5. Persist avatar generation timestamps atomically in a private quota file next
   to the snapshot. Restore and prune the rolling window on boot so a restart
   cannot reset the hourly/daily allowance.
6. Add a periodic avatar sweep with configurable retention/storage limits.
   Never delete an avatar referenced by a live room. Age out unreferenced
   uploads sooner than generated cache entries, and enforce a total disk cap by
   deleting the oldest eligible files first.
7. Associate each async avatar job with the seat name/upload generation that
   requested it. Apply completion only if that request is still current, so an
   old generation cannot overwrite a newer upload or renamed seat.
8. Keep cleanup and quota timers unref'd and stop them during graceful shutdown
   tests.

#### Acceptance

- Limits allow normal full games and test-mode seat creation.
- Deterministic tests cover exhaustion, refill, key eviction, trusted-proxy
  behavior, and 429 headers.
- Quota history survives restart and expired entries are pruned.
- Referenced avatars survive cleanup; eligible unreferenced files and over-cap
  files are removed in deterministic order.
- A deliberately delayed stale avatar result cannot overwrite the latest
  request.
- `npm test`, `npm run typecheck`, and browser tests pass.

### Batch 10 — authenticated seats and final phase-view protocol

Tracker item: 21 and completion of item 18.

This is the coordinated breaking server/Pages cutover.

#### Credential model

- `seatId` remains a public stable identifier used in rosters, selections,
  votes, and logs.
- A new seat receives a 256-bit base64url `seatToken` exactly once.
- Persist only `SHA-256(seatToken)` with the seat. Because the token has full
  cryptographic entropy, a password-style slow hash is unnecessary.
- The server derives the acting/viewing seat exclusively from a verified token.
  Public `seatId` is never accepted as proof of identity.

#### API and Pages transport

1. New join returns `{ seatId, seatToken, code }`. Rejoin/session probes,
   actions, leaving, and private streams require `Authorization: Bearer ...`.
   Action bodies no longer contain `playerId`.
2. A token is scoped to its room and resolves to exactly one seat. Use a
   timing-safe digest comparison or a digest-index lookup with constant public
   behavior for failures.
3. Replace native `EventSource` in the already-extracted transport module with
   streaming `fetch` and an `AbortController`. Implement the small SSE parser
   needed for `data:` messages and comments; preserve heartbeat, retry,
   reconnect, focus/online wake-up, and stale-stream cancellation semantics.
4. For the configured Pages origin, allow the `Authorization` and
   `Content-Type` headers and the required methods in CORS preflight. Do not
   reflect arbitrary origins, and keep same-origin Node clients working.
5. Replace local storage's player-ID-only record with a versioned credential
   record containing room code, seat ID, token, and name. Test mode stores one
   real credential per controlled seat and switches by reconnecting with that
   seat's token.
6. Do not provide a public-ID-to-token upgrade endpoint: it would recreate the
   impersonation flaw. This compatibility-free cutover intentionally discards
   old room snapshots and old local credential offers.
7. Remove legacy actor-ID action handling and the unauthenticated private SSE
   path in the same protocol version. Unauthenticated room existence responses
   may remain minimal, but must never reveal whether an arbitrary public seat ID
   is valid.
8. Finish discriminated phase views and remove legacy fields the new Pages
   client no longer uses. Update the API reference and protocol tests.
9. Bump `STATE_VERSION` for credential-bearing seats and `API_PROTOCOL` for the
   authenticated actions/stream/view contract. Keep both server and Pages
   constants asserted at the new protocol value.
10. Update the security documentation: room code grants permission to request a
    new lobby seat, while the secret token owns an existing seat. Document that
    tokens must not appear in URLs or logs.
11. Extend real-browser tests to use at least two isolated browser contexts.
    Prove that one seat cannot subscribe, rejoin, leave, vote, play a card, or
    submit a night action as the other, even though every public seat ID appears
    in the view.

#### Acceptance

- The previously identified exploit fails: knowing another public seat ID is
  insufficient to obtain their view or act for them.
- Tokens never appear in URL paths, queries, SSE data, logs, room views, or API
  error bodies.
- Rejoin, deployment reconnect, held-seat offers, leaving, and multi-seat test
  mode all work through authenticated credentials.
- Cross-origin Pages streaming works with restricted CORS; an unapproved origin
  receives no CORS authorization.
- Old unauthenticated actions and private streams are rejected.
- The update gate handles the new incompatible state version before restart,
  and health reports the new API/state versions.
- `npm test`, `npm run typecheck`, browser tests, release packaging, and
  deployment/controller tests all pass.

### Final audit and completion

After Batch 10:

1. Run the complete test, typecheck, browser, packaging, and deployment suites
   from a clean install.
2. Run `git diff --check` and an unused-code/i18n audit again; large refactors
   often create new dead adapters.
3. Confirm the packaged artifact contains no runtime dependency directory and
   the Pages artifact contains its complete stamped module graph.
4. Verify documentation for architecture, API, security, testing, deployment,
   Node requirements, configuration limits, snapshots, and replay matches the
   final code.
5. Check all 21 tracker boxes only against their stated batch acceptance
   criteria. Add commit or PR references beside completed batches if desired.
6. Do not mark the cleanup complete while a temporary compatibility adapter,
   legacy unauthenticated endpoint, unbounded cache, or skipped required test
   remains.
