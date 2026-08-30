# Contract and TypeScript modernization

Status: in progress.

This plan replaces the original all-at-once build migration. Its purpose is to
make the contracts easier to understand and change, not to acquire a modern
toolchain for its own sake.

The intended end state is:

- server, shared contract, and test code are TypeScript source executed
  directly by Node 24;
- runtime schemas define untrusted HTTP and persisted data, and TypeScript
  types are inferred from those schemas where practical;
- public views and actions are discriminated unions, so each game phase has an
  exact shape instead of a large collection of optional properties;
- browser modules are TypeScript source compiled to plain browser ES modules;
- production installs no packages and runs no compiler or build tool;
- CI tests the source model and the exact server/client artifacts it publishes;
- deployment compatibility, live-game behavior, and the current small-module
  architecture remain intact.

The plan deliberately does **not** require a server bundle, Vite, Playwright, a
front-end framework, an HTTP framework, or a container. Those remain possible
later decisions, not prerequisites for getting the contract benefits.

## Why this is the next change

The code currently describes important shapes in several overlapping places:

1. `types/contracts.d.ts` describes static room, action, and view types.
2. `src/api-validation.js` validates HTTP input with project-specific helpers.
3. `src/games/restore.js` separately validates persisted state.
4. Game modules construct public views directly.
5. Browser renderers and transport code assume the response shapes they
   receive.

The registry boundary in `src/games/index.js` then joins shared room state and
game state through a `Proxy`, `Record<string | symbol, any>`, and casts. This is
the architectural cost to remove: changing one concept requires reconciling
several representations, and the compiler cannot reliably follow the value
through the central registry.

The strictness itself is not the goal. This is a private hobby game, so the
contract layer should prevent realistic mistakes without trying to prove every
possible semantic invariant at every boundary. Runtime schemas should answer
“is this untrusted value structurally safe to use?” Game engines and focused
tests should answer “is this move or state legal?”

The development-dependency question is already settled in practice:
`package.json` contains TypeScript and Node types, CI runs `npm ci`, and the
repository has a strict `tsconfig.json`. The mismatch is that `checkJs` is off,
so only files that opt into `@ts-check` receive the benefit. The HTTP entrypoint
and most browser rendering code remain outside that strict program, while
`PublicViewBase` in `types/contracts.d.ts` uses catch-all fields that prevent
the compiler from checking the most important browser/server boundary. The
project is already paying the conceptual cost of TypeScript; this plan makes it
the ordinary source language where it can replace those parallel assertions.

## Fixed decisions

These decisions should not be reopened by each implementing agent.

### Node-native TypeScript comes first

Node 24 can execute erasable TypeScript directly. Server modules and Node tests
therefore move from `.js` plus JSDoc to `.ts` without `tsx`, a server compiler,
or a server bundle.

Use only syntax supported by Node's type stripping:

- use `import type` for type-only imports;
- include file extensions in relative imports;
- enable `erasableSyntaxOnly` and `verbatimModuleSyntax`;
- do not use enums, namespaces, parameter properties, or path aliases that
  require transformation;
- keep `tsc --noEmit` as the static checker even though Node is the runtime.

The permanently installed service currently starts `src/server.js`. Keep that
path as a tiny compatibility launcher that imports `server.ts` during the
migration. Removing the launcher is a later control-plane change and is not
needed to gain native TypeScript.

The `gameContext` proxy is not preserved as an architectural option. It exists
to make split room/game state look like one flat mutable object, which is the
kind of relationship structural typing cannot make honest. Phase 3 first
replaces it in JavaScript with explicit ownership, then converts that stable
boundary mechanically to TypeScript. If explicit ownership would instead make
each game depend on room internals, the stop rule applies and the concrete
alternative comes back for human review.

### Runtime schemas replace structural hand-validation

Adopt Zod as the runtime schema library. It is the first production dependency
in this repository, so pin it in the lockfile and ship its production package
inside the release. CI may install dependencies; the host must not.

Use schemas for:

- request bodies, route parameters, and externally supplied options;
- the persisted room envelope and per-game persisted state;
- structural constraints such as exact keys, primitives, arrays, enums, and
  simple ranges.

Keep these outside schemas:

- authorization and actor selection;
- phase-dependent command legality;
- cross-player and cross-turn game rules;
- state transitions and compatibility policy.

Unknown HTTP fields should normally be stripped. Persisted snapshots should be
strict, because silently accepting an unknown stored field can conceal a
version mismatch. Add schema refinements only when they replace a real current
check or prevent an observed invalid state; do not translate every game rule
into a second declarative language.

Stripping unknown HTTP keys is the one intentional behavior change in this
plan: a body that currently receives `badRequest` solely for an extra field will
be accepted after Phase 2. It expands accepted input and does not change any
response an existing client relies on, so it does not require an
`API_PROTOCOL` bump. The Phase 2 PR must call out the loosening and replace the
current exact-key rejection tests with strip-policy tests.

### Browser TypeScript gets the smallest useful build

Browsers do not execute TypeScript. Browser modules will therefore be compiled,
but the first implementation uses the TypeScript compiler already present in
the repository, emitting plain ES modules into a staging directory.

Initially preserve the existing static-file layout and `config.js` mechanism.
Treat `bootstrap.js` and the version stamper as a measured comparison, not a
presumed destination: Phase 5 compares the existing path with a standard
browser tool that deletes both, without inventing another project-specific
graph rewriter. This keeps the migration about types and module contracts while
making the known caching compromise explicit.

Vite is not part of the committed plan. Reconsider it only after browser
TypeScript is complete, using the decision gate near the end of this document.

Keep server source under `src/` and browser source under `public/` during the
migration. Do not reorganize the tree to imitate a framework convention. A
module moves only when the two runtimes must share one authored contract and
the existing location makes that impossible.

Shared contract modules may be imported by the browser with `import type`, so
Zod does not become a browser runtime dependency. The browser's generated
configuration should eventually carry `API_PROTOCOL` from the server's one
authored constant; do not retain a manually synchronized protocol number in
`public/app`.

The browser does not need a second exhaustive runtime schema for responses the
same repository's server constructs. Its transport may perform a small envelope
and discriminant check, then make one named trust assertion to the shared view
union. That assertion is the serialization boundary and must not spread into
sessions or renderers. If independently deployed/untrusted servers become a
supported threat model, runtime response schemas are a separate design change.

Do not add browser automation in this plan. The small DOM shim supports a large,
fast interaction suite and Playwright would initially complement it rather than
delete it. Revisit browser automation only after a browser-only defect escapes
that suite or a proposed smoke suite replaces material existing machinery.

### The deployable artifact is the verification boundary

The important property is not that all source is extractable. It is that CI
builds once, tests what it built, and publishes those same bytes.

Use layered verification:

1. In the checkout, run type checking and the complete behavioral suite against
   the authored modules.
2. Build the browser once into a clean staging directory.
3. Assemble the server release from native server TypeScript, emitted browser
   JavaScript, locked production packages, and required static assets.
4. Extract the archive and run artifact checks against its production entrypoint
   and emitted browser modules.
5. Publish the already-tested archive and the already-tested Pages directory;
   do not rebuild either in a later job.

The complete test suite may remain in the archive when that is cheap, but its
presence and source visibility are not acceptance criteria. Any test whose
purpose is to verify compilation, packaging, module resolution, static assets,
or startup must run against the assembled output rather than the authored
source.

A container or pre-built executable would only improve this boundary if host
drift becomes a demonstrated problem. Today the production surface is Node 24,
architecture-neutral JavaScript, static files, and one locked runtime package.
Adding an image registry, base image, or platform-specific binary would create
more operational concepts than it removes.

## Relationship to deferred cleanup

`docs/codebase-cleanup.md` now contains only items 19–21. They are public-service
hardening work and are explicitly not the current priority.

- Items 15–16 are dropped; replay tooling and expanded fuzz/property testing
  are not planned.
- Items 19–20 (abuse controls and avatar lifecycle) remain useful later but do
  not block this plan.
- Item 21 (seat credentials) closes a real authorization weakness. Deferring it
  is an explicit acceptance of the current friends-only trust model, not a
  claim that public seat IDs are secure capabilities.

Do not mix those security changes into contract migration PRs. They change
behavior and compatibility, which makes it harder to tell whether a type or
schema migration preserved the game.

## Scope guardrails

Preserve unless a phase explicitly says otherwise:

- both Avalon and One Night Ultimate Werewolf behavior;
- English and Chinese clients;
- self-hosted and GitHub Pages clients;
- `STATE_VERSION` and `API_PROTOCOL` compatibility rules;
- memory-first rooms, snapshot restore, timers, reconnect, and test mode;
- dependency-free browser runtime output;
- immutable release, exact-commit health, deferred incompatible rollout, and
  rollback behavior.

The unknown-HTTP-key loosening described above is the sole exception to the
otherwise behavior-preserving migration.

Out of scope:

- gameplay or visual redesign;
- seat authentication and general public-internet hardening;
- frontend framework or component-system adoption;
- Playwright or replacement of `test/dom-shim.js`;
- server bundling or conversion to a different runtime;
- containerization;
- database or persistence redesign.

## How agents decide whether to stop

An agent should not attempt to score architectural elegance or compare raw line
counts. Those judgments are too easy to manipulate and too dependent on taste.
Instead, each phase has named deletions, preserved properties, and mechanical
acceptance checks.

Stop the phase and ask for a design decision if any of these occurs:

1. It requires a runtime/build dependency other than Zod, TypeScript, or the
   browser compiler selected in this plan.
2. A behavior-preserving phase unexpectedly requires an `API_PROTOCOL` or
   `STATE_VERSION` bump.
3. The named old representation cannot be deleted in the same phase, or in one
   explicitly identified cutover PR immediately following it.
4. Production would need two active implementations for more than one cutover
   PR.
5. The implementation needs `any`, an unchecked cast at a contract boundary
   other than the single named browser-response trust assertion, or a
   suppression other than a documented negative type fixture.
6. The host would need to run `npm install`, `npm ci`, `tsc`, or another build
   command.
7. The release or Pages job would rebuild output after its artifact tests.
8. Existing artifact coverage is removed without a replacement that exercises
   the same production entrypoint or emitted module.
9. The phase expands into an out-of-scope feature, security change, or behavior
   change other than the named unknown-key policy.

For every PR, include a short migration ledger in its description:

- old representations or mechanisms deleted;
- temporary bridge introduced, with the next PR that removes it;
- new dependencies or generated directories;
- source tests run;
- assembled-output tests run;
- compatibility version decision and reason.

This gives a coding agent evidence it can collect. The human decision is needed
only when a stop condition fires, not for routine implementation choices.

## Progress

| Phase | Outcome | Status |
| --- | --- | --- |
| 0 | Baseline and prove Node-native TypeScript | Complete |
| 1 | Model exact public views | Complete |
| 2 | Replace structural validators with schemas | Complete |
| 3 | Convert server and tests to native TypeScript | Complete |
| 4 | Make the browser boundary explicit | Complete |
| 5 | Convert browser modules and add minimal emit | Complete |
| 6 | Cut over packaging and remove superseded contracts | Complete |
| 7 | Reassess enhanced browser tooling | Not started |

Phase 0 is a preflight performed in the Phase 1 working branch, not a standalone
PR. Every other phase is independently reviewable. Complete and merge one phase
before starting the next. A phase may use multiple small PRs only when it names
the temporary bridge and removes it in the immediately following PR.

## Phase 0 — Baseline and proof

Goal: turn assumptions about Node-native TypeScript into executable checks
before changing application modules.

Tasks:

- Record the current `npm test` and `npm run typecheck` commands and duration in
  the first PR description, not in maintained docs.
- Update TypeScript configuration for Node-native syntax constraints, including
  `allowImportingTsExtensions`, `erasableSyntaxOnly`, and
  `verbatimModuleSyntax`, while retaining strict checking.
- Add a disposable test fixture proving Node 24 can execute a `.ts` module and
  `node --test` can discover a `.test.ts` file. Delete the probe before merging;
  do not add `tsx`.

Acceptance:

- `npm test` and `npm run typecheck` pass on Node 24.
- A `.ts` test executes directly under Node without a loader.
- No application module or production entrypoint changes in this phase.

## Phase 1 — Exact public views

Goal: make illegal phase/view combinations unrepresentable before moving many
files.

Tasks:

- Define `AvalonView` and `OnuwView` as discriminated unions keyed by game and
  phase. A phase contains only fields the server actually exposes in that
  phase.
- Define the shared lobby/player/room envelope once and compose game-specific
  views into it.
- Compose nested overlays where presence is determined by phase. A field whose
  presence also depends on runtime state stays optional inside the phase that
  can carry it: `players[].hasPlayed?` within Avalon `quest`, and
  `you.action?` within ONUW `night`.
- Type every view builder against its exact phase result.
- Add positive fixtures for representative views.
- Add negative fixtures with `@ts-expect-error` for at least:
  - the viewer's role in `lobby`;
  - another player's role outside Avalon `over`;
  - another player's `startRole` or `finalRole` outside ONUW `over`;
  - `hasPlayed` outside Avalon `quest`; and
  - another phase-only top-level field on the wrong phase.

Do not attempt to encode exact viewer/team predicates in the type. Existing
secrecy tests remain authoritative for whether `hasPlayed` is present for a
particular team member and whether `you.action` is present for an awake viewer.

Acceptance:

- `tsc` fails if any `@ts-expect-error` fixture becomes valid or its expected
  error disappears.
- View builders introduce no new `any` or boundary casts.
- HTTP JSON remains byte-compatible; `API_PROTOCOL` does not change.
- Existing browser and server behavior tests pass.

Named deletion: remove the former broad view declarations from
`types/contracts.d.ts` as their exact replacements land. Do not leave both as
authoritative definitions.

## Phase 2 — Schemas at untrusted boundaries

Goal: make runtime structure and static input types share a source of truth.

Tasks:

- Add Zod as a pinned production dependency. Create schemas for the common HTTP
  envelope and each game/action union, and infer the request types from those
  schemas. Do not first create a parallel handwritten action union.
- Parse incoming action bodies once at the HTTP boundary. Pass parsed values to
  room and game code; internal code must not revalidate the same structure.
- Create schemas for the persisted room envelope and the discriminated state
  of each game.
- Preserve current reference and phase invariants as focused schema refinements
  or post-parse restore checks. Prefer a named post-parse check when the rule
  describes game semantics rather than shape.
- Add table-driven malformed-input and malformed-snapshot tests around each
  schema boundary.
- Add negative `@ts-expect-error` fixtures for a missing required action
  payload and an action belonging to the other game.
- Verify snapshot compatibility using committed fixtures for the current
  `STATE_VERSION`.
- Prove a staged production dependency tree can import Zod after development
  dependencies are pruned.

Acceptance:

- Valid current requests and snapshots behave unchanged.
- Unknown HTTP keys follow the chosen strip policy; unknown persisted keys are
  rejected.
- Invalid snapshots still fail closed and start empty under the existing
  policy.
- Registry action dispatch consumes the schema-derived union without a second
  handwritten payload type.
- `API_PROTOCOL` remains unchanged because the named unknown-key policy only
  broadens accepted requests; `STATE_VERSION` remains unchanged. If another
  incompatibility appears, the stop rule applies.

Named deletions: delete `src/api-validation.js` and the structural validator
machinery in `src/games/restore.js`. If a semantic restore check remains, move
it to a narrowly named module; do not retain the generic helper layer.

## Phase 3 — Native TypeScript server and tests

Goal: replace opt-in JSDoc checking and the registry type hole with ordinary
TypeScript, while continuing to execute source directly.

Tasks:

- Phase 3a removes the facade while the implementation is still JavaScript.
  Pass an explicit `{ room, state }` context, delete `gameContext`,
  `splitState`, `ROOM_FIELDS`, and direct proxy-only uses, and introduce no
  `.ts` file. Keep the engine, determinism, and room suites passing unchanged.
- Phase 3b performs the mechanical TypeScript conversion only after Phase 3a
  merges. Do not combine field-access changes with file conversion.
- Convert server modules under `src/` to `.ts` in coherent dependency slices.
  Convert their focused tests to `.test.ts` in the same slice.
- Update relative imports to explicit `.ts` extensions and use `import type`.
- Keep `src/server.js` only as a compatibility launcher importing
  `src/server.ts`; do not duplicate server setup in it.
- Type the explicit registry contract created by Phase 3a. Shared room data and
  game-specific state remain separate; no merged dynamic object crosses the
  registry.
- Give each registry entry typed `create`, `rosterChange`, `command`, `view`,
  `deadline`, `tick`, and restore operations for its game.
- Move Phase 1 contract definitions out of `types/contracts.d.ts` into normal
  `.ts` modules at the closest shared boundary.
- Update scripts that import server constants to import `.ts` source directly
  under Node 24.

Acceptance:

- Phase 3a has no proxy/facade helpers or TypeScript file conversion, and all
  focused behavior tests pass.
- `node src/server.js` starts the native TypeScript implementation.
- `node --test` discovers and runs converted `.test.ts` files without a loader.
- `tsc --noEmit` checks every server and test TypeScript module under strict
  settings.
- Registry dispatch narrows actions by game and type without `any`, a proxy, or
  unchecked casts.
- Release verification still checks the stable `src/server.js` entrypoint.
- All behavior and deploy tests pass.

Named deletions: delete `ROOM_FIELDS`, `gameContext`, `splitState`, their proxy
and casts, converted `.js` implementations, and the migrated declarations in
`types/contracts.d.ts`.

## Phase 4 — Explicit browser boundary

Goal: give the browser one small typed seam for server data before changing its
execution path.

Tasks:

- Opt the browser boundary and renderer modules into checking for this phase;
  use a focused `checkJs` config or temporary `@ts-check` comments, and name
  their removal in Phase 5.
- Define the transport result and error types, including reconnect and protocol
  mismatch outcomes.
- Check the network envelope and game/phase discriminants at
  `public/transport.ts`, then convert to the shared view union at one named
  trust boundary. Renderers receive typed domain values rather than `unknown`,
  `any`, or raw response objects.
- Make game renderers exhaustive over the discriminated view unions. Use a
  shared `assertNever`-style check for missed games or phases.
- Type the browser action creation path against the action schemas/types from
  Phase 2 without importing Zod into the browser runtime unless measurement
  shows runtime browser validation is needed.
- Add negative type fixtures for renderer-only secrets and impossible phases.

Acceptance:

- Transport is the only browser boundary that handles untrusted response
  values.
- There is one documented response assertion after the envelope/discriminant
  checks and no response cast in session or rendering code.
- Adding a game phase without a renderer fails type checking.
- Removing a renderer-required field from a view fails a real
  `@ts-expect-error`/consumer fixture, not merely a prose assertion.
- Current DOM-shim UI tests and reconnect tests pass unchanged in purpose.

Named deletion: remove redundant browser response/action typedefs and broad
`Promise<any>` or equivalent boundary types. The DOM shim remains.

## Phase 5 — Browser TypeScript with minimal emit

Goal: make browser TypeScript the authored source while adding no more build
machinery than compilation requires.

Tasks:

- Convert browser modules to `.ts` in dependency order, starting with leaf
  utilities and game modules, then transport/rendering/UI, then `app`.
- Keep styles, HTML, art, and audio as static assets.
- Define one clean generated directory for browser output and keep it out of
  source control.
- Add a browser-specific TypeScript config that emits standards-based ES
  modules to a clean staging directory and rewrites relative `.ts` imports to
  `.js`.
- Add one build command that cleans the staging directory, copies static
  assets, and compiles browser modules.
- Measure the caching path before finalizing it. Compare plain `tsc` plus the
  existing stamper against a standard browser tool that deletes the stamper and
  `bootstrap.js` path. Do not write a custom content-hashing or import-rewriting
  script for either arm. A bundler adoption invokes the Phase 7 gate as its own
  decision; if no alternative clears that gate and the artifact tests, retain
  the stamper on emitted output and record why.
- Keep build orchestration small and explicit. Prefer npm scripts plus focused
  existing scripts; do not create a general-purpose task runner.
- Before converting the full graph, compile a nested-import probe with
  `rewriteRelativeImportExtensions` and verify the emitted browser URLs. Delete
  the probe after it passes.
- Point local production-mode server tests and Pages artifact tests at the
  emitted directory.
- Keep a documented development command that rebuilds before starting the
  server. A watch mode is optional and must not be required in CI.

Acceptance:

- No `.ts` file is served to a browser.
- The emitted tree contains no source maps or development-only files unless
  explicitly chosen and tested.
- Both self-hosted and Pages configurations load the emitted client.
- DOM-shim tests can exercise authored modules; at least one integration test
  imports/loads the emitted entry graph and catches missing generated files or
  incorrect extensions.
- A clean checkout can run install, typecheck, test, and browser build using
  documented package scripts.

Named deletion: remove converted browser `.js` source files. Generated output
must stay untracked.

Abort-specific check: if keeping `bootstrap.js` or the stamper forces a second
module graph, source rewriting beyond the existing stamper, or duplicated
configuration, stop and invoke the Phase 7 Vite decision early with the
concrete duplication listed.

If plain `tsc` cannot emit the current module graph with browser-loadable
relative URLs, the same stop rule applies: report the failing source import and
emitted output before selecting another compiler or bundler.

Implementation result: plain TypeScript emit produces 15 standards-based
modules (167,645 bytes before compression) under the untracked `build/public/`
tree, and `rewriteRelativeImportExtensions` makes the nested source imports
browser-loadable without a custom graph rewriter. The existing stamper now
operates only on that emitted Pages tree. Vite was not adopted: the module
count and compile-then-start loop are small, there are no browser package or
asset-resolution needs, and it would delete `bootstrap.js` and the stamper but
not a third project-specific packaging mechanism. None of the Phase 7 adoption
triggers is therefore present yet.

## Phase 6 — Package the tested output

Goal: publish immutable server and Pages artifacts assembled from the outputs
already tested in CI.

Tasks:

- Install locked dependencies once at the start of CI.
- Compile the browser once and apply the caching path selected in Phase 5 to a
  canonical clean staging directory, then copy it into self-hosted and Pages
  staging directories. Generate the target-specific `config.js` in each copy;
  treat the Pages backend URL as packaging configuration, not as a second
  authored client.
- Assemble the server archive from the native server entrypoint/source,
  production `node_modules`, the emitted self-hosted client, and operational
  files required by the updater.
- Exclude development dependencies from the archive. Source/tests may remain
  when useful, but production must not depend on them.
- Update `scripts/verify-packaged-release.mjs` to verify the actual production
  entrypoint, required runtime package, manifest, and emitted client entry.
- After extraction, start the packaged server and test health, static entry
  loading, an HTTP action/view round trip, snapshot restore, and any deployment
  behavior not already exercised through the entrypoint.
- Run the full extracted-archive test suite only if it remains a useful cheap
  check; do not count it as a substitute for the artifact tests above.
- Upload the tested server archive and tested Pages directory without rerunning
  compilation or stamping in publish/deploy jobs.
- Preserve reproducible archive metadata and exact-commit verification.

Acceptance:

- The host performs no install or build.
- The published archive digest matches the archive that passed extraction and
  startup tests.
- The published Pages directory matches the staged directory that passed its
  emitted-graph tests.
- A missing Zod production package, browser output file, or static asset fails
  before publication.
- Updater rollback and compatibility deferral tests still pass.

Named deletion: remove source-tree-as-release assumptions from
`scripts/package-release.sh` and the workflow. Delete obsolete package/stamp
steps only when the new artifact test covers their purpose.

Implementation result: deployment installs the lockfile and emits the browser
once, then derives separately configured self-hosted and Pages trees from that
canonical output. The server archive is assembled from runtime source,
production packages, operational files, and the tested self-hosted client; it
no longer installs dependencies, compiles, or treats the repository tree as
the release. CI extracts the archive and exercises its stable production
entrypoint through health, static loading, an action/view round trip, and
snapshot restore. The separately tested Pages tree is carried into the Pages
job as an artifact, so neither publication path rebuilds or restamps output.
The archive also carries `public/index.html` as a byte-for-byte copy of the
emitted entry for compatibility with the statically installed updater; no
authored browser source is packaged or served.

## Phase 7 — Reassess enhanced browser tooling

Goal: decide with post-migration evidence whether a bundler would simplify the
finished browser build. This phase may end with no code change.

Adopt Vite only if at least one of these is true:

- it deletes `bootstrap.js`, the import stamper, and another project-specific
  packaging mechanism together;
- the emitted module count or cache behavior is a measured production problem;
- browser dependencies require asset/module handling that `tsc` cannot provide;
- local browser development is materially impaired by the compile-then-reload
  loop, demonstrated by a repeatable workflow problem.

If adopted:

- use Vite for the browser only;
- keep Node-native server TypeScript unbundled;
- preserve runtime backend configuration for Pages and self-hosting without
  maintaining two client sources;
- build once and publish the tested output;
- delete every superseded script/config in the same PR.

Do not adopt Vite merely for hashed filenames or convention. If none of the
triggers is present, mark this phase “No change needed” and close the plan.

Playwright is a separate future proposal. It should be considered only when a
real browser-only failure escapes the DOM-shim suite or when it can replace a
material portion of that suite.

## Completion criteria

The modernization is complete when:

- HTTP input, persistence, actions, and views each have one authoritative
  contract representation;
- schema-derived types replace parallel handwritten structural types;
- public game views and actions are exact discriminated unions;
- server/test TypeScript runs directly on Node 24;
- the registry contains no proxy, `any`, or unchecked contract casts;
- browser TypeScript emits plain modules through the smallest build that proved
  sufficient;
- obsolete validators, declarations, and converted JavaScript sources are
  deleted;
- CI tests authored behavior and the exact artifacts it publishes;
- production performs no dependency installation or build;
- all compatibility and deployment tests pass; and
- Phase 7 records either an evidence-backed browser tooling change or an
  explicit no-change decision.
