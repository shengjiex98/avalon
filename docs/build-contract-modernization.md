# Build and contract modernization plan

Status: proposed, revised after an audit of the current repository. An
implementation item may be checked in the pull request that makes its
acceptance criteria pass; the status becomes authoritative when that pull
request is merged.

This plan retires the repository's "no dependencies, no build" rule and
replaces it with the narrower rule that was doing the real work:

> The production host installs nothing and executes no build tools.

A development toolchain, a browser build, and a vendored runtime package are
all permitted under that rule. The immutable archive, the exact-commit health
proof, the active-game deferral, and the rollback behavior are not negotiable
under it, and this plan protects all four.

The first sections explain the end state and the evidence for it. The tracker
and phase instructions then give an implementing agent the order, boundaries,
tests, and stopping conditions needed to get there without redesigning the
architecture along the way.

## What the audit found

Line counts are from `main` at the time of writing: 6,532 lines of production
JavaScript (3,143 under `src/`, 3,389 under `public/`) and 6,103 lines of test.

The old rule has already lapsed on its own terms. `package.json` declares
`typescript` and `@types/node`, CI runs `npm ci` and `npm run typecheck`, and
[`docs/testing.md`](testing.md) documents a two-command workflow — while
[`AGENTS.md`](../AGENTS.md) still states that "`package.json` declares none".
The open question is not whether to have development dependencies. It is
whether the ones already installed are earning their cost.

In four specific places they are not.

**1. The type layer covers the wrong 60%.** Twelve of 27 production modules
carry `@ts-check`, totalling 2,707 lines. The 3,825 unchecked lines include
`public/i18n.js` (831), `public/games/onuw.js` (722), `public/app.js` (634),
`public/games/avalon.js` (402), `src/server.js` (392), and `src/avatars.js`
(292) — the entire browser render layer and the HTTP entrypoint — while
`src/state-version.js` (4 lines) is checked. The cost of TypeScript is already
paid; most of the benefit is not collected.

**2. `types/contracts.d.ts` cannot be checked against the code it describes.**
A declaration file for JavaScript in another directory is an assertion nothing
verifies. To stay believable it had to widen until it asserts almost nothing:
`PublicViewBase` carries `[field: string]: unknown`, and `you` is intersected
with `Record<string, unknown>`. Every renderer that reads `view.round` or
`view.quests` type-checks against a promise the type never made. The secrecy
boundary — the most safety-critical contract in the project — is the one the
compiler currently checks least.

**3. The request validator rejects unknown keys.** `exact()` in
`src/api-validation.js` throws `badRequest` when a body carries any
unrecognized property. This buys no safety, because the engines only read
fields they name. What it does buy is a compatibility problem: a Pages client
that ships after the server, sending or omitting one additive field, gets a
hard 400. That converts routine additive change into an `API_PROTOCOL` bump,
which the staged release order then has to absorb.

**4. Asset versioning is four bespoke parts approximating a content hash.**
`scripts/stamp-frontend-version.mjs` rewrites import specifiers with a regular
expression; `public/bootstrap.js` fetches `version.json` and only then
dynamically imports the app, costing a serial round trip on every cold load;
`public/config.js` is checked in so the deploy workflow can overwrite it with
`node -e`; and `test/deploy.test.js` asserts on the resulting source text. The
regex is also a latent defect: it rewrites any `'./name.js'` string, including
one inside a comment or template literal.

Two things the old rule bought are genuinely good, and this plan protects both:
the install-free immutable archive, and `test/dom-shim.js` — 240 lines carrying
2,334 lines of interaction tests, with no browser, in about 25 seconds.

## Outcome

At the end of this plan:

- server, shared-contract, and browser source is TypeScript;
- one standard build produces the Node server and hashed browser assets;
- the production archive is immutable and runs without installing packages on
  the host;
- runtime schemas parse untrusted HTTP input and persisted snapshots, and the
  corresponding TypeScript types are inferred rather than restated;
- public game views are discriminated unions by game and phase, with no
  catch-all index signature;
- client actions are checked where they are constructed, without a final cast;
- the existing game engines, UI design, native HTTP/SSE transport, persistence,
  Pages client, DOM-shim test suite, and safe deployment behavior remain
  recognizable;
- the regex import stamper, parallel declaration file, selective `@ts-check`
  layer, and hand-written request-shape checker are gone.

Success is not measured by having more tooling. It is measured by deleting more
project-specific concepts than the selected tools introduce. Every phase below
names what it deletes.

## Fixed architectural decisions

An implementing agent should not reopen these unless a phase's proof of concept
demonstrates a concrete incompatibility with this repository.

### Product and runtime

- Keep a single Node process, native `node:http`, native server-sent events,
  memory-first rooms, JSON snapshots, and the existing game-engine boundary.
- Do not introduce a front-end framework, HTTP framework, database, state
  container, dependency-injection framework, or monorepo tooling in this work.
- Keep both delivery modes: the Node-hosted client and the independently
  deployed GitHub Pages client.
- Keep `API_PROTOCOL` and `STATE_VERSION`. A build does not replace deployment
  compatibility, and neither number changes for a source-only migration.
- Keep the immutable release, exact-commit health proof, active-game deferral,
  and rollback behavior. This plan may simplify how the application artifact is
  built; it does not redesign the installed updater.

### Toolchain

- Use TypeScript as source, not as a no-emit annotation checker.
- Run server TypeScript directly. Node 24 strips types natively, so
  `src/server.ts` runs with no flag and the release carries no server bundle
  and no server output directory (D5).
- Use Vite for the browser production build only. It owns hashed assets and the
  module graph, which is what retires the import stamper. Browsers cannot run
  TypeScript, so this build is not optional the way the server one is.
- Keep `tsc --noEmit` as the type gate. Node strips types; it does not check
  them. Node's test runner executes `.ts` files directly, so no development
  loader is needed and `node:test` is unchanged.
- Set `erasableSyntaxOnly` so the compiler rejects syntax Node cannot strip
  (`enum`, `namespace`, parameter properties, decorators — none of which this
  codebase uses), and `allowImportingTsExtensions` so relative imports name the
  real `.ts` file.
- Use Zod for runtime schemas. Normal API object schemas use the default
  behavior of stripping unrecognized keys from parsed output. Persisted-state
  schemas use strict objects where an exact stored shape is required. The
  package is copied into the release at package time (D5); the host never
  installs it.
- Lock every package in `package-lock.json`. Do not use floating CDN imports or
  dependencies downloaded by the production host.

These follow the tools' supported paths: Node runs `.ts` entry points and test
files with no flag; Vite builds an `index.html` entry and hashed static assets;
Zod returns typed parsed data, infers TypeScript types from schemas, and strips
unknown object keys by default.

- <https://nodejs.org/api/typescript.html#type-stripping>
- <https://vite.dev/guide/build>
- <https://zod.dev/basics>
- <https://zod.dev/api#objects>

Do not pin versions in this document. Each implementing PR installs a current
Node-24-compatible release and commits the exact lockfile result.

### Contract ownership

- HTTP schemas validate transport shape and return normalized command objects.
  Route handlers must dispatch the parsed result, never the original JSON.
- Unknown HTTP object properties are ignored and stripped. Wrong required
  types, missing required properties, invalid discriminants, excessive sizes,
  and malformed JSON remain errors.
- Game engines continue to own semantic legality: phase, turn, membership,
  target validity, team size, role-specific action rules, and win conditions.
  Do not duplicate these rules in schemas.
- Persisted snapshots are different from HTTP commands: validate their complete
  structure before restoring any room. Retain all-or-nothing restore.
- Public views are compile-time discriminated unions with a member for every
  game phase, and no catch-all index signature.
- View builders return those unions directly. Browser renderers narrow on
  `gameId` and `phase` before reading phase fields.
- The client sends a discriminated action object. The room session adds the
  current `playerId`; it does not accept a string plus an untyped `extra` bag.
- The transport exposes semantic methods with typed responses (`createRoom`,
  `joinRoom`, `probeRoom`, `sendAction`) instead of one public string-path
  function returning `Promise<any>`.
- `API_PROTOCOL` and supported game IDs have one source definition under
  `src/shared/`. The browser build embeds them in its output; the server and
  release-manifest generator import the same source.
- Backend selection is data, not a second browser build. The same hashed module
  graph reads a small no-cache configuration file: the Node-hosted artifact
  supplies the same-origin value and Pages supplies the configured HTTPS API
  base. Generating that data file must not rewrite executable assets.

## Decisions this plan makes explicitly

These four are the ones a future reader is most likely to second-guess, so they
are recorded with their reasoning rather than left implicit in a task list.

**D1 — Unknown HTTP keys are stripped, not rejected.** This is a deliberate
loosening of the wire contract, not a refactor: bodies that return 400 today
will succeed afterwards. It is adopted because exact-key rejection protects
nothing the engines do not already guard, while making every additive field a
protocol-compatibility event for a client that ships on a different schedule
than the server. Engine-level legality checks are unaffected. Phase 2 owns it.

**D2 — The `gameContext` Proxy is decided on purpose, not incidentally.** The
Proxy in `src/games/index.js` forwards ten room fields onto engine state so
engines keep a flat API. No build decision created it, and TypeScript makes it
harder rather than easier, because a Proxy is exactly what a structural type
system cannot see through. Phase 3 must either replace it with explicit context
construction or keep it and type its boundary honestly — and must say which, in
the PR, before converting the modules around it. Do not let it be removed as a
side effect of a rename.

**D3 — No browser automation is added.** Playwright was considered and
rejected. It is a large dependency, a browser download in CI, a second test
paradigm, and a trace-artifact story, and by its own framing it would complement
rather than replace the DOM-shim tests — so it adds a concept and deletes none,
which is the opposite of this plan's success measure. The 240-line
`test/dom-shim.js` carrying 2,334 lines of fast, deterministic interaction tests
is the single strongest result the old constraint produced. Keep it as the
interaction suite. Revisit only if a real layout defect ships that the shim
provably could not have caught.

**D4 — No source-tree reshuffle.** Server source stays under `src/`, browser
source stays under `public/`. Moving files damages `git blame` and buys nothing
a maintainer can feel at this size. Two exceptions, each with a mechanical
reason: `src/shared/` is added because a single definition of `API_PROTOCOL` and
the game IDs must be importable by both runtimes, and `public/audio/` and
`public/art/` move to `static/` because Vite's browser root cannot also serve as
its verbatim-copy directory. Nothing else moves.

**D5 — The server runs TypeScript directly; only the browser is built.** Node 24
strips types natively, so `src/server.ts` runs as-is and no server bundle is
produced. This serves the goal `scripts/package-release.sh` already states: the
archive must be byte-identical for a given commit on every machine that builds
it, so the host can compare a download against what CI published. `git archive`
plus GNU tar flags delivers that almost for free, while a bundler is a much
larger determinism surface — plugin order, absolute paths leaking into banners
and source maps, the bundler's own version — bought for no property the
deployment needs. Production stack traces also keep pointing at real files.

Zod is the one runtime dependency. Packaging copies `node_modules/zod` — a
zero-dependency package — into the staging tree from an `npm ci` lockfile
install, so the host still installs nothing and executes no build tool. That is
a smaller determinism surface than a bundler, but it is not zero: Phase 0 must
prove the copy reproduces byte-identically rather than assume it. Committing the
package to the repository instead was considered and rejected — it makes every
upgrade a vendor commit and gives up npm's integrity checking.

## Scope boundaries

This migration must not be used to smuggle in unrelated product changes.

In scope:

- build, type, schema, artifact, and test-harness changes needed to reach the
  outcome above;
- deletion of custom code made obsolete by those changes; and
- documentation updates that describe the new development and release model.

Out of scope:

- game rule, house rule, visual design, copy, translation, room-code, avatar,
  reconnect, or test-mode behavior changes;
- seat-authentication or abuse-limiting work;
- a new persistence format or database;
- replacing SSE, the Node HTTP server, the DOM helper, the DOM-shim suite, or
  the installed updater;
- browser automation (see D3);
- source-tree reorganization beyond the two moves named in D4;
- replay/fuzzing work from the earlier cleanup tracker; and
- broad UI component or CSS redesigns.

If an out-of-scope defect is discovered, add a focused regression test and fix
only what is required to preserve current behavior. Record larger work
separately rather than expanding this migration.

## Source and output layout

```text
src/                    server, rooms, persistence, avatars, game engines;
                        shipped and run as TypeScript, never built
src/shared/             API_PROTOCOL, game ids, command schemas, view types
public/                 browser entry, session, transport, UI, game renderers
static/                 assets addressed by dynamic path (ONUW audio, art)
test/                   Node unit/integration tests, organized by behavior
dist/public/            Vite browser output; never checked in
```

## Verification model

The completed repository has two commands:

- `npm test` is the fast inner loop and the merge gate: `tsc --noEmit` plus the
  Node unit, integration, and DOM-shim tests, run straight from `.ts` sources.
- `npm run check` adds the browser build and packaged-artifact verification, and
  is what CI and the release workflow run.

Until those scripts exist, follow the current `AGENTS.md` command. Every
implementing PR must leave `main` deployable and must run the strongest gate
available in that PR.

The final release workflow must:

1. install exactly the lockfile with `npm ci`;
2. run `npm run check` against source;
3. build `dist/public` once;
4. package the commit's server sources, those exact browser bytes, the vendored
   Zod package, and the release manifest;
5. verify the extracted archive rather than rebuilding it;
6. activate the server artifact through the existing updater; and
7. upload the same `dist/public` bytes to Pages after exact-commit server
   health.

The production archive must contain everything needed to run, but must not
contain a full `node_modules` tree, TypeScript, Vite, or a requirement to run
`npm install` on the host. The vendored Zod package is the single exception,
and it is named in the release manifest.

## Progress tracker

Work in table order. One row may use more than one PR when reviewability
requires it, but do not combine rows from different phases merely to reduce PR
count.

| Phase | Status | Deliverable | Completion signal |
|---:|:---:|---|---|
| 0 | - [ ] | Characterize behavior and prove the toolchain | Old and candidate builds pass the same characterization tests |
| 1 | - [ ] | Add a production build beside the current entrypoints | `dist/` is reproducible and not yet deployed |
| 2 | - [ ] | Establish shared contracts and schema parsing | Parsed commands are typed and dispatched; D1 is in effect |
| 3 | - [ ] | Convert the server and game engines to TypeScript | No server JSDoc type layer remains; D2 is answered |
| 4 | - [ ] | Discriminate public views by game and phase | No catch-all view field; renderers narrow before reading |
| 5 | - [ ] | Convert the browser client to TypeScript | Every browser module is strictly checked; action casts are gone |
| 6 | - [ ] | Switch release and Pages to the new artifact shape | Production runs the extracted archive with rollback intact |
| 7 | - [ ] | Delete obsolete machinery and reconcile docs | Exit criteria pass and only one contract/build path remains |

## Implementation instructions

### Phase 0 — characterize and prove

Goal: establish a behavioral baseline and prove the selected tools can satisfy
the unusual parts of this repository before moving source files.

Tasks:

- [ ] Record the current counts and duration for `npm test` and
      `npm run typecheck` in the first implementing PR description, not in a
      permanent documentation table.
- [ ] Add behavior-level characterization where a build migration could hide a
      regression: Node-hosted static files, Pages base URLs, dynamic ONUW audio,
      avatar URLs, `version.json`, API protocol reporting, release identity, and
      an extracted archive starting successfully.
- [ ] Prove that the server runs from `.ts` sources on Node 24 with no loader
      and no build, that `node --test` discovers and runs `.ts` test files, and
      that `erasableSyntaxOnly` holds across the codebase.
- [ ] Prove that a `node_modules/zod` copied from an `npm ci` lockfile install
      reproduces byte-identically inside the archive on two machines. This is
      the one determinism surface D5 adds and it must be measured, not assumed.
- [ ] Create a throwaway proof that Vite can produce the browser graph with
      hashed assets from the current module structure.
- [ ] Prove that the server can locate `release.json`, `dist/public`, and its
      writable state path without relying on the source checkout layout.
- [ ] Prove that the browser build preserves root-relative `/api/avatars/*` URLs
      and copies dynamically selected audio files from `static/`.
- [ ] Confirm that one browser build can read either an empty same-origin or a
      production HTTPS `API_BASE` from a separately generated data file, without
      a checked-in generated `public/config.js` or a second module build.

Acceptance:

- Current production remains unchanged.
- No protocol or state version changes.
- The proof uses the selected tools without a custom import-rewriting plugin.
- Any failed assumption is reported in the PR before substituting another tool.
  A substitute must still satisfy the fixed outcomes and delete at least the
  same bespoke mechanisms. If the vendored package cannot be made to reproduce
  byte-identically, the fallbacks in order are: bundle only the server with a
  Node-target build, or drop the runtime dependency and keep hand-written
  validation. Never weaken the reproducibility guarantee itself.

### Phase 1 — build beside production

Goal: introduce the browser build and the typed toolchain without yet changing
what systemd or Pages serves.

Tasks:

- [ ] Add locked TypeScript, Vite, and Zod dependencies with their roles
      correctly classified. Zod is the only runtime dependency; nothing else may
      reach the archive.
- [ ] Add strict shared TypeScript settings, including `erasableSyntaxOnly` and
      `allowImportingTsExtensions`, and separate browser/Node settings only
      where their libraries or module resolution genuinely differ.
- [ ] Add `npm run build` (browser only) and `clean` scripts. Cleaning must
      target only the resolved repository `dist/` directory.
- [ ] Move `public/audio/` and `public/art/` to `static/` as a mechanical,
      behavior-preserving commit, and configure it as the verbatim-copy
      directory so the served URLs are unchanged (D4).
- [ ] Generate `version.json` and release metadata through a small typed build
      hook or script. This generation may write data; it must not rewrite source
      imports.
- [ ] Add a built-artifact verifier that checks required files and can start the
      server on an ephemeral port.
- [ ] Add `dist/` to `.gitignore`; no generated output belongs in commits.

Acceptance:

- Two clean builds of the same checkout, on two machines, have identical file
  contents and names after excluding timestamps that are not packaged.
- Browser assets referenced through the module graph are content-hashed, and
  `/audio/*` and `/art/*` resolve at their current URLs.
- The server started from `src/server.ts` serves the built client.
- The current source entrypoint and deployment remain active.
- `npm test` passes.

### Phase 2 — one request contract

Goal: replace the parallel request declaration and manual shape checker with
schemas that return the command values actually dispatched, and put D1 into
effect.

Tasks:

- [ ] Add shared schemas under `src/shared/` for create, join, room probe
      responses, structured API errors, and each discriminated player action.
- [ ] Infer exported input/output types from the schemas; do not restate object
      interfaces with the same fields.
- [ ] Use normal Zod objects for HTTP commands so unknown keys are stripped
      (D1). State the loosening explicitly in the PR description.
- [ ] Preserve current normalization intentionally: `playerId: null` on join is
      treated as an absent seat, names remain normalized by the lobby layer, and
      optional avatar behavior stays unchanged.
- [ ] Convert schema failures to the existing `badRequest` response. Do not send
      Zod diagnostics to clients.
- [ ] Change each route to dispatch `result.data`, never the pre-parse object.
- [ ] Keep body-size, content-type, malformed-JSON, method, CORS, and
      status-code handling in the HTTP adapter.
- [ ] Keep phase, membership, target, role, and game-rule checks in the engines.
- [ ] Add tests showing that irrelevant keys are stripped rather than rejected,
      while wrong required values never reach room dispatch or the journal.
- [ ] Remove `src/api-validation.js` in the same PR that lands its replacement.

Acceptance:

- One schema definition owns each HTTP command's runtime shape and static type.
- The create/join regression is covered through the real client/server path.
- Existing valid requests and error keys behave the same.
- Adding an irrelevant object key does not require an `API_PROTOCOL` bump.
- `npm test` passes with `API_PROTOCOL` unchanged.

### Phase 3 — typed server and engines

Goal: make the server implementation readable as typed source rather than
JavaScript surrounded by assertions.

Answer D2 first. Before converting `src/games/`, decide in writing whether the
`gameContext` Proxy is replaced by explicit context construction or kept and
typed at its boundary, and say why in the PR. This is the single item most
likely to expand, because it is where the current architecture and a structural
type system disagree. It gets its own PR either way.

Suggested conversion order after that:

1. version constants, rules, and small shared primitives;
2. lobby and game engines;
3. game registry and restore schemas;
4. rooms and persistence;
5. avatars; and
6. the HTTP/server entrypoint.

Tasks:

- [ ] Rename one coherent module group at a time and update imports
      mechanically. Do not combine a rename with a behavioral refactor.
- [ ] Replace JSDoc imports, `@ts-check`, and `/** @type */` assertions with
      TypeScript declarations or real narrowing.
- [ ] Model the game registry with explicit generic/discriminated operations.
      Remove `Record<string, any>` and module-wide `any` once focused game and
      room tests have direct typed seams.
- [ ] Keep the persisted room envelope separate from game-owned state in both
      types and runtime data.
- [ ] Convert restore validation to strict Zod schemas, keeping the cross-field
      refinements for roster references and phase invariants as explicit,
      readable rules rather than dissolving them into schema shape.
- [ ] Preserve whole-snapshot validation before installation.
- [ ] Ensure timer handles, subscriptions, file paths, and injected clocks have
      explicit types rather than assertions.
- [ ] Keep tests behavior-focused; do not add tests that assert `.ts` suffixes
      or particular type aliases exist.

Acceptance:

- All server and game source is strict TypeScript.
- No `any` remains in production server code without a one-line explanation at
  an unavoidable external boundary; prefer `unknown` plus narrowing.
- Persisted JSON remains byte-shape compatible, so `STATE_VERSION` is unchanged.
- Determinism, secrecy, timers, persistence, and HTTP integration tests pass.
- `node src/server.ts` starts the server on Node 24 with no loader or build.

### Phase 4 — discriminated public views

Goal: make the privacy and rendering boundary a contract the compiler can
enforce, and stop there.

The valuable change is narrow: today `PublicViewBase` carries
`[field: string]: unknown`, so the view type asserts nothing and a renderer
reading a field the engine stopped sending still compiles. Removing that, and
discriminating on `gameId` with `phase` as a literal type, catches that bug
class. Per-phase `you` and `players` shapes are deliberately not attempted: they
are where the effort concentrates and the marginal safety is smallest, and
secrecy is already covered behaviorally by negative assertions, which is the
right level for that invariant.

Tasks:

- [ ] Define shared base player, log, setup, and view fields once under
      `src/shared/`.
- [ ] Delete the `[field: string]: unknown` index signature and the
      `Record<string, unknown>` intersections on `you` and `players`.
- [ ] Define an Avalon view type discriminated on `gameId: 'avalon'` with
      `phase` as a union of its seven literals, and an ONUW view type
      discriminated on `gameId: 'onuw'` with its six.
- [ ] Give `you` and `players` one explicit shape per game, wide enough for
      every phase of that game. Optional fields are acceptable here; unknown
      fields are not.
- [ ] Make each view builder return the correct union member without a cast.
- [ ] Add an exhaustive phase switch or `assertNever` at renderer boundaries.
- [ ] Retain the negative secrecy assertions: roles, ballots, awake/acted
      signals, centre cards, and night information must remain absent in phases
      and for viewers where they are secret.

Acceptance:

- Removing or renaming a field a renderer reads fails type checking.
- Adding a phase requires handling in its engine view and browser renderer.
- No runtime view shape changes are required; `API_PROTOCOL` remains unchanged.
- Existing secrecy and UI tests pass.

### Phase 5 — typed browser and actions

Goal: make every browser module a checked consumer of the real server contract.

Suggested conversion order:

1. storage and transport;
2. room session and test seats;
3. shared UI/rendering;
4. game registry and renderers;
5. i18n; and
6. app/bootstrap composition.

Tasks:

- [ ] Convert browser modules in place under `public/` (D4). Do not reorganize
      the directory while converting it.
- [ ] Keep DOM construction and renderer ownership explicit; do not add a UI
      framework during conversion.
- [ ] Replace the generic path-based public transport API with typed semantic
      methods and typed successful responses.
- [ ] Replace `send(type, extra)` with a discriminated action object. The
      session adds a proven non-null player ID and sends the resulting command.
- [ ] Type renderer contexts and lifecycle methods, including ONUW clock/audio
      disposal.
- [ ] Type DOM lookups with focused helpers that prove required shell elements
      and narrow input/dialog elements. Avoid scattered non-null assertions.
- [ ] Type translation keys enough to preserve language-key parity without
      making dynamic server keys impossible to render.
- [ ] Keep the DOM shim and current UI tests running unchanged; Node runs `.ts`
      and `.js` tests side by side, so tests may remain JavaScript until
      production source is fully converted.
- [ ] Delete `types/contracts.d.ts` once its last import is gone.

Acceptance:

- Every production browser module is strict TypeScript.
- There is no `Promise<any>` transport result, catch-all view field, or
  assertion from an arbitrary action object to a validated command.
- Running the compiler over the entire production client reports zero errors; no
  file-level opt-in or opt-out comments are needed.
- UI, reconnect, test-seat, audio, and language tests pass.

### Phase 6 — production cutover

Goal: switch production to the new archive shape — TypeScript server sources,
the built browser bytes, and the vendored package — without weakening rollout
safety.

Tasks:

- [ ] Change the release packager to stage the commit's sources, build the
      browser once into that staging directory, copy `node_modules/zod` in from
      the lockfile install, and archive those exact bytes plus `release.json`
      and required static control-plane files. Keep the existing deterministic
      tar flags; the archive must stay byte-identical per commit.
- [ ] Record the vendored package and its resolved version in `release.json`,
      and have the packaged verifier check it is present and complete.
- [ ] Change packaged verification to inspect the archive's real entry and
      browser output, and to start the server from the extracted tree.
- [ ] Change the systemd application unit to run `src/server.ts`. Keep the
      installed updater outside releases and follow the existing manual
      installation rule for the unit change.
- [ ] Make the server resolve its public directory and release root explicitly;
      do not infer either from a source-tree-relative `../public`.
- [ ] Change Pages publication to upload the exact browser output already tested
      and activated, without rebuilding it in the Pages job.
- [ ] Generate a small validated backend-configuration data file after the one
      browser build. Verify both empty same-origin configuration and the
      production HTTPS backend without changing hashed executable assets.
- [ ] Keep a small `version.json` for in-app update detection, but remove query
      stamping from module imports. `index.html` points at hashed build assets.
- [ ] Update release retention, manifest, rollback, and exact-commit tests for
      paths only; do not relax their behavior.
- [ ] Confirm the updater treats this as compatible when protocol/state values
      are unchanged and still defers a deliberately incompatible fixture.

Acceptance:

- The extracted archive starts with no package installation and no build tool,
  carrying only the vendored Zod package.
- Node-hosted and Pages clients use the same tested browser bytes with no
  post-build mutation. If backend configuration must differ, it must be a
  separately generated data file whose bytes and use are explicitly tested, not
  a rebuilt module graph.
- Active-game deferral, rollback, snapshot backup, and health proof pass.
- The built release deploys with compatibility numbers unchanged.
- The manual updater/unit installation consequence is called out in the PR and
  deployment documentation.

### Phase 7 — delete and reconcile

Goal: finish the migration rather than maintaining two architectures.

Tasks:

- [ ] Delete `scripts/stamp-frontend-version.mjs`, the import-stamping tests,
      checked-in generated client configuration, and the bootstrap version round
      trip made obsolete by hashed assets.
- [ ] Delete `types/contracts.d.ts`, remaining production JSDoc type imports,
      selective `@ts-check` comments, and superseded tsconfig files.
- [ ] Remove source-text tests whose only purpose was to enforce an
      implementation pattern now guaranteed by types or build output. Retain
      behavioral deployment and security tests.
- [ ] Remove old source entrypoints and packaging paths after the built release
      is active.
- [ ] Update `README.md`, `AGENTS.md`, and maintained docs to distinguish
      development dependencies, browser build-time dependencies, the single
      vendored runtime package, and the install-free production artifact. `AGENTS.md`'s current claim that
      "`package.json` declares none" is already false and must go.
- [ ] Replace the repository rule with: the production host installs nothing and
      executes no build tools; a dependency requires a short deletion and
      ownership rationale, not exceptional permission merely because it is a
      dependency.
- [ ] Update `docs/README.md` and archive or remove completed migration trackers
      that no longer help future maintenance.
- [ ] Record final source/build/test counts in the closing PR description and
      compare them with Phase 0. Do not preserve vanity metrics in code.

Acceptance:

- There is exactly one supported source path, contract path, build path, and
  production entrypoint.
- `rg '@ts-check|types/contracts|stamp-frontend-version'` finds no production
  dependency on the old approach.
- `npm test` and `npm run check` pass from a clean clone after documented setup.
- The packaged archive starts without source or development dependencies.
- Architecture, testing, API, deployment, and contributor docs agree.

## Agent working rules

1. Read `AGENTS.md` and the files named by the current phase before editing.
2. Work in phase and task order. Mark a checkbox in the pull request that makes
   its acceptance criteria pass; do not mark speculative or partial work.
3. Keep each PR behavior-preserving unless a task explicitly names a behavior
   change. D1 is the one named behavior change in this plan. State
   `API_PROTOCOL` and `STATE_VERSION` impact in every PR.
4. Prefer mechanical rename-only commits before typed refactors. This keeps
   review and `git blame` useful.
5. When introducing a schema, delete the corresponding hand-written validator in
   the same PR, or explain the short-lived duplication and name the PR that will
   remove it.
6. When introducing generated output, add verification before switching
   deployment to it. Never commit `dist/`.
7. Use parsed schema output and compiler narrowing. Do not make a migration pass
   by replacing JSDoc assertions with `as` assertions or `any`.
8. Do not rewrite stable game logic merely to make a type prettier. Model the
   domain first; refactor only when the model exposes a real ambiguity.
9. Run the current repository gate after every coherent change and the full
   phase acceptance suite before opening a PR.
10. Keep `main` deployable. The production cutover is one deliberate phase, not
    a partially switched sequence across unrelated PRs.
11. Preserve user changes in a dirty worktree and do not regenerate media.
12. Update this tracker in the implementation PR that completes a task or phase,
    with a link to the authoritative code rather than duplicating its
    operational details here.
13. If a phase's work is growing well past its acceptance criteria, stop and say
    so in the PR rather than widening it. This plan is deliberately smaller than
    the maximal version of itself.

## Pull request template for implementation phases

Each implementing PR description should answer:

```text
Plan phase and task:
Concepts/code deleted:
Concepts/dependencies added:
Behavior intentionally changed:
API_PROTOCOL impact:
STATE_VERSION impact:
Source verification:
Built/archive verification:
Deployment or manual-install consequence:
Follow-up required before old path can be deleted:
```

## Final exit criteria

The modernization is complete only when all of the following are true:

- [ ] Every production source module is TypeScript and checked in one strict
      program appropriate to its runtime.
- [ ] Request schema types are inferred, and routes dispatch normalized parsed
      data with unknown keys stripped.
- [ ] Snapshot validation is complete, strict, and all-or-nothing.
- [ ] Public views are discriminated by game and phase without catch-all fields.
- [ ] Client action construction and successful responses are typed end to end.
- [ ] The browser build owns asset hashing and module traversal, and is the
      only build in the project.
- [ ] The server ships and runs as TypeScript; the Pages client ships the exact
      browser bytes that were tested.
- [ ] Production installs no packages and executes no build tools.
- [ ] The archive is still byte-identical per commit across build machines.
- [ ] The DOM-shim suite still runs as the fast interaction gate, without a
      browser.
- [ ] The old validator, declaration, stamping, and source-entry paths are gone.
- [ ] The maintained documentation describes one coherent architecture.
