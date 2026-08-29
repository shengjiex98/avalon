# Build and contract modernization plan

Status: proposed. An implementation item may be checked in the pull request
that makes its acceptance criteria pass; the status becomes authoritative when
that pull request is merged.

This plan replaces the repository's absolute "no dependencies, no build"
constraint with a smaller and more useful constraint: keep the product and its
production artifact simple, while allowing standard tools that remove custom
machinery and duplicate sources of truth.

It is written for two audiences. The first sections explain the intended end
state and the reasons for it. The implementation tracker then gives a coding
agent the order, boundaries, tests, and stopping conditions needed to make the
change without having to redesign the architecture along the way.

## Outcome

At the end of this plan:

- server, shared-contract, and browser source is TypeScript;
- one standard build produces the Node server and hashed browser assets;
- the production archive is immutable and runs without installing packages on
  the host;
- runtime schemas parse untrusted HTTP input and persisted snapshots, and the
  corresponding TypeScript types are inferred rather than restated;
- public game views are real discriminated unions by game and phase;
- client actions are checked where they are constructed, without a final cast;
- the existing game engines, UI design, native HTTP/SSE transport, persistence,
  Pages client, and safe deployment behavior remain recognizable;
- the regex import stamper, parallel declaration file, selective `@ts-check`
  layer, and hand-written request-shape checker are gone; and
- a small real-browser smoke suite complements, rather than replaces, the fast
  unit and DOM-shim tests.

Success is not measured by having more tooling. It is measured by deleting
more project-specific concepts than the selected tools introduce.

## Why this change

The current runtime remains admirably small, but the development model is
already dependent on TypeScript while continuing to ship hand-authored
JavaScript. That compromise has created several overlapping contracts:

1. request and state declarations in `types/contracts.d.ts`;
2. JSDoc annotations and assertions in selected JavaScript modules;
3. manual runtime checks in `src/api-validation.js` and
   `src/games/restore.js`;
4. the actual command dispatch and view builders; and
5. the fields the browser renderers assume are present.

Those layers do not currently prove the same thing. In particular, the public
view types allow arbitrary fields, action payloads are asserted at the send
boundary, successful transport responses are `any`, and the largest browser
renderers are outside strict checking.

The no-build constraint also requires project-specific asset versioning:
`scripts/stamp-frontend-version.mjs` rewrites JavaScript imports with a regular
expression, `public/bootstrap.js` resolves the version at runtime, and tests
inspect source text to protect the resulting module graph. A standard browser
build can own that concern directly.

## Fixed architectural decisions

These decisions are part of the plan. An implementing agent should not reopen
them unless a phase's proof-of-concept demonstrates a concrete incompatibility
with this repository.

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
  built, but it does not redesign the installed updater.

### Toolchain

- Use TypeScript as source, not as a no-emit annotation checker.
- Use Vite for the browser production build and its Node-target server build.
  The browser build owns hashed assets and the module graph. The server build
  uses a Node target and bundles only the selected runtime schema dependency;
  Node built-ins remain external.
- Use Zod for runtime schemas. Normal API object schemas use the default
  behavior of stripping unrecognized keys from parsed output. Persisted-state
  schemas use strict objects where an exact stored shape is required.
- Use `tsx` only as the development/test loader needed to run TypeScript source
  through Node's existing test runner. Do not replace `node:test`.
- Add Playwright later in the plan for a Chromium-only smoke suite. Do not move
  the existing interaction matrix wholesale into browser tests.
- Lock every package in `package-lock.json`. Do not use floating CDN imports or
  dependencies downloaded by the production host.

These choices follow the tools' supported paths: Vite builds an `index.html`
entry and hashed static assets, supports a Node-target server build, and can
bundle an explicitly non-external dependency; Zod returns typed parsed data,
infers TypeScript types from schemas, and strips unknown object keys by
default. Reference documentation:

- <https://vite.dev/guide/build>
- <https://vite.dev/guide/ssr.html#building-for-production>
- <https://vite.dev/config/ssr-options.html>
- <https://zod.dev/basics>
- <https://zod.dev/api#objects>
- <https://playwright.dev/docs/test-webserver>

Do not pin versions in this document. Each implementing PR installs a current
Node-24-compatible release and commits the exact lockfile result.

### Source and output layout

The target layout is:

```text
src/
  client/                 browser entry, session, transport, UI, game renderers
  server/                 HTTP adapter, rooms, persistence, game engines
  shared/                 API versions, commands, public views, shared primitives
static/                   copied assets whose names are addressed dynamically
test/                     Node unit/integration tests, still organized by behavior
test/browser/             small Playwright smoke suite
dist/
  public/                 Vite browser output; never checked in
  server/                 Node-target application output; never checked in
```

Moving every file into this layout in one commit is not required. During the
migration, prefer small mechanical moves and keep the old production entrypoint
until the built artifact passes the same behavioral tests.

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
  game phase. They do not have a catch-all index signature.
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

## Scope boundaries

This migration must not be used to smuggle in unrelated product changes.

In scope:

- build, type, schema, source-layout, artifact, and test-harness changes needed
  to reach the outcome above;
- deletion of custom code made obsolete by those changes; and
- documentation updates that describe the new development and release model.

Out of scope:

- game rule, house rule, visual design, copy, translation, room-code, avatar,
  reconnect, or test-mode behavior changes;
- seat-authentication or abuse-limiting work;
- a new persistence format or database;
- replacing SSE, the Node HTTP server, the DOM helper, or the installed updater;
- replay/fuzzing work from the earlier cleanup tracker; and
- broad UI component or CSS redesigns.

If an out-of-scope defect is discovered, add a focused regression test and fix
only what is required to preserve current behavior. Record larger work
separately rather than expanding this migration.

## Verification model

The completed repository has two commands:

- `npm test` is the fast inner loop: strict type checking plus the Node unit,
  integration, and DOM-shim tests.
- `npm run check` is the merge gate: `npm test`, production builds, packaged
  artifact verification, and the Chromium smoke suite.

Until those scripts exist, follow the current `AGENTS.md` command. Every
implementing PR must leave `main` deployable and must run the strongest gate
available in that PR.

The final release workflow must:

1. install exactly the lockfile with `npm ci`;
2. run `npm run check` against source;
3. build `dist/server` and `dist/public` once;
4. package those exact bytes with the release manifest;
5. verify and smoke-test the extracted archive rather than rebuilding it;
6. activate the server artifact through the existing updater; and
7. upload the same `dist/public` bytes to Pages after exact-commit server health.

The production archive must contain everything needed to run, but must not
contain `node_modules`, TypeScript, Vite, `tsx`, Playwright, or a requirement to
run `npm install` on the host.

## Progress tracker

Work in table order. One row may use more than one PR when reviewability
requires it, but do not combine rows from different phases merely to reduce PR
count.

| Phase | Status | Deliverable | Completion signal |
|---:|:---:|---|---|
| 0 | - [ ] | Characterize behavior and prove the toolchain | Old and candidate builds pass equivalent smoke checks |
| 1 | - [ ] | Add a production build beside the current entrypoints | `dist/` is reproducible and not yet deployed |
| 2 | - [ ] | Establish shared contracts and schema parsing | Parsed commands are typed and dispatched; behavior unchanged |
| 3 | - [ ] | Convert the server and game engines to TypeScript | No server JSDoc type layer or unsafe registry facade remains |
| 4 | - [ ] | Define exact phase-specific public views | View builders and consumers compile without catch-all fields |
| 5 | - [ ] | Convert the browser client to TypeScript | Every browser module is strictly checked; action casts are gone |
| 6 | - [ ] | Switch release and Pages to built artifacts | Production runs the extracted build with rollback intact |
| 7 | - [ ] | Add real-browser smoke coverage | Chromium proves the critical create/join/play/reconnect path |
| 8 | - [ ] | Delete obsolete machinery and reconcile docs | Exit criteria pass and only one contract/build path remains |

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
- [ ] Create a throwaway proof inside tests or a draft commit showing that Vite
      can produce both the browser graph and a Node-target server entry while
      leaving `node:` built-ins external and bundling Zod.
- [ ] Prove that the built server can locate `release.json`, `dist/public`, and
      its writable state path without relying on the source checkout layout.
- [ ] Prove that the browser build preserves root-relative `/api/avatars/*` URLs
      and copies dynamically selected audio files.
- [ ] Confirm that one browser build can read either an empty same-origin or a
      production HTTPS `API_BASE` from a separately generated data file,
      without a checked-in generated `public/config.js` or a second module
      build.

Acceptance:

- Current production remains unchanged.
- No protocol or state version changes.
- The proof uses the selected tools without a custom import-rewriting plugin.
- Any failed assumption is reported in the PR before substituting another tool.
  A substitute must still satisfy the fixed outcomes and delete at least the
  same bespoke mechanisms.

### Phase 1 — build beside production

Goal: introduce a deterministic build without yet changing what systemd or
Pages serves.

Tasks:

- [ ] Add locked TypeScript, Vite, Zod, and `tsx` dependencies with their roles
      correctly classified as development or runtime source dependencies.
- [ ] Add strict shared TypeScript settings and separate browser/Node settings
      only where their libraries or module resolution genuinely differ.
- [ ] Add `npm run build`, `build:client`, `build:server`, and `clean` scripts.
      Cleaning must target only the resolved repository `dist/` directory.
- [ ] Configure the browser root and static asset directory explicitly. Do not
      rely on Vite's conventional `public/` meaning while source still lives in
      the repository's current `public/` directory.
- [ ] Configure a Node-target server build with Zod included in output and Node
      built-ins external. Do not bundle tests or deployment control-plane code.
- [ ] Generate `version.json` and release metadata through a small typed build
      hook or script. This generation may write data; it must not rewrite source
      imports.
- [ ] Add a built-artifact verifier that checks required files and can start the
      server on an ephemeral port.
- [ ] Add `dist/` to `.gitignore`; no generated output belongs in commits.

Acceptance:

- Two clean builds of the same checkout have identical file contents and names
  after excluding timestamps that are not packaged.
- Browser assets referenced through the module graph are content-hashed.
- The built Node entry starts and serves the built client.
- The current source entrypoint and deployment remain active.
- `npm test` passes.

### Phase 2 — one request contract

Goal: replace the parallel request declaration and manual shape checker with
schemas that return the command values actually dispatched.

Tasks:

- [ ] Add shared schemas for create, join, room probe responses, structured API
      errors, and each discriminated player action.
- [ ] Infer exported input/output types from the schemas; do not restate object
      interfaces with the same fields.
- [ ] Use normal Zod objects for HTTP commands so unknown keys are stripped.
- [ ] Preserve current normalization intentionally: `playerId: null` on join is
      treated as an absent seat, names remain normalized by the lobby layer,
      and optional avatar behavior stays unchanged.
- [ ] Convert schema failures to the existing `badRequest` response. Do not send
      Zod diagnostics to clients.
- [ ] Change each route to dispatch `result.data`, never the pre-parse object.
- [ ] Keep body-size, content-type, malformed-JSON, method, CORS, and status-code
      handling in the HTTP adapter.
- [ ] Keep phase, membership, target, role, and game-rule checks in the engines.
- [ ] Add tests showing that irrelevant keys are stripped rather than rejected,
      while wrong required values never reach room dispatch or the journal.
- [ ] Remove `src/api-validation.js` only when no route or test imports it.

Acceptance:

- One schema definition owns each HTTP command's runtime shape and static type.
- The create/join regression is covered through the real client/server path.
- Existing valid requests and error keys behave the same.
- Adding an irrelevant object key does not require an `API_PROTOCOL` bump.
- `npm test` passes with `API_PROTOCOL` unchanged.

### Phase 3 — typed server and engines

Goal: make the server implementation readable as typed source rather than
JavaScript surrounded by assertions.

Suggested conversion order:

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
      Remove `Record<string, any>`, module-wide `any`, and the Proxy-based flat
      facade only when focused game and room tests have direct typed seams.
- [ ] Keep the persisted room envelope separate from game-owned state in both
      types and runtime data.
- [ ] Convert restore validation to strict Zod schemas, including cross-field
      refinements for roster references and phase invariants that schemas alone
      cannot express.
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
- The candidate server build starts from `dist/server`.

### Phase 4 — phase-specific views

Goal: make the privacy and client/server rendering boundary the strongest
static contract in the repository.

Tasks:

- [ ] Define shared base player, log, setup, and view fields once.
- [ ] Define an Avalon union with members for `lobby`, `reveal`, `team`, `vote`,
      `quest`, `assassin`, and `over`.
- [ ] Define an ONUW union with members for `lobby`, `reveal`, `night`, `day`,
      `vote`, and `over`.
- [ ] Give `you` and `players` phase-appropriate fields. Do not use
      `Record<string, unknown>` intersections or a string index signature.
- [ ] Make each view builder return the correct union member without a cast.
- [ ] Add an exhaustive phase switch or `assertNever` at renderer boundaries.
- [ ] Retain negative secrecy assertions: roles, ballots, awake/acted signals,
      centre cards, and night information must remain absent in phases/viewers
      where they are secret.
- [ ] Add compile-time fixtures for representative valid and invalid views only
      where normal production code does not already exercise the distinction.

Acceptance:

- Removing or renaming a field used by a renderer fails type checking.
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

- [ ] Move executable browser source under `src/client/` and dynamic static
      assets under the configured `static/` directory in small mechanical PRs.
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
- [ ] Keep the DOM shim and current UI tests running through `tsx`; tests may
      remain JavaScript until production source is fully converted.
- [ ] Delete `types/contracts.d.ts` only after its last import is gone.

Acceptance:

- Every production browser module is strict TypeScript.
- There is no `Promise<any>` transport result, catch-all view field, or
  assertion from an arbitrary action object to a validated command.
- Running the compiler over the entire production client reports zero errors;
  no file-level opt-in or opt-out comments are needed.
- UI, reconnect, test-seat, audio, and language tests pass.

### Phase 6 — production cutover

Goal: deploy the already-proven build output without weakening rollout safety.

Tasks:

- [ ] Change the release packager to build once into a staging directory and
      archive the exact `dist/server` and `dist/public` bytes plus
      `release.json` and required static control-plane files.
- [ ] Change packaged verification to inspect and run output, not source.
- [ ] Change the systemd application unit to run the built Node entry. Keep the
      installed updater outside releases and follow the existing manual
      installation rule for the unit change.
- [ ] Make the built server resolve its public directory and release root
      explicitly; do not infer either from a source-tree-relative `../public`.
- [ ] Change Pages publication to upload the exact browser output already
      tested and activated, without rebuilding it in the Pages job.
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

- The extracted archive starts without `node_modules` or package installation.
- Node-hosted and Pages clients use the same tested browser bytes except for no
  post-build mutation. If backend configuration must differ, it must be a
  separately generated data file whose bytes and use are explicitly tested,
  not a rebuilt module graph.
- Active-game deferral, rollback, snapshot backup, and health proof pass.
- The built release deploys with compatibility numbers unchanged.
- The manual updater/unit installation consequence is called out in the PR and
  deployment documentation.

### Phase 7 — browser smoke coverage

Goal: cover the browser behaviors the hand-built DOM shim cannot represent,
without making browser automation the main test strategy.

Tasks:

- [ ] Add Playwright as a locked development dependency and install only the
      Chromium headless runtime in CI.
- [ ] Use Playwright's `webServer` support to start the built application on an
      isolated port. Do not point tests at production.
- [ ] Add one desktop and one phone-sized project only if they exercise distinct
      behavior; otherwise use a single phone-sized Chromium project.
- [ ] Cover: load home, create a room, join a second browser context, receive an
      SSE update, start one game far enough to reveal a private role, reload and
      reconnect, and confirm static audio/art requests succeed.
- [ ] Assert one or two critical layout properties that the DOM shim cannot
      catch, such as no horizontal overflow and the primary action being
      reachable at the phone viewport.
- [ ] Keep browser tests deterministic and independent of Cloudflare avatar
      generation, public Pages, external networks, and real-time ONUW duration.

Acceptance:

- The smoke suite runs against built bytes and passes without external network
  access.
- Failures retain a trace or screenshot in CI.
- Existing DOM-shim tests remain the fast, detailed interaction suite.
- `npm run check` is documented and passes locally with the browser installed.

### Phase 8 — delete and reconcile

Goal: finish the migration rather than maintaining two architectures.

Tasks:

- [ ] Delete `scripts/stamp-frontend-version.mjs`, the import-stamping tests,
      checked-in generated client configuration, and bootstrap behavior made
      obsolete by hashed assets.
- [ ] Delete `types/contracts.d.ts`, remaining production JSDoc type imports,
      selective `@ts-check` comments, and superseded tsconfig files.
- [ ] Remove source-text tests whose only purpose was to enforce an
      implementation pattern now guaranteed by types or build output. Retain
      behavioral deployment and security tests.
- [ ] Remove old source entrypoints and packaging paths after the built release
      is active.
- [ ] Update `README.md`, `AGENTS.md`, and maintained docs to distinguish:
      development dependencies, build-time dependencies, bundled runtime code,
      and the install-free production artifact.
- [ ] Replace the repository rule with: dependencies require a short deletion
      and ownership rationale, not exceptional permission merely because they
      are dependencies.
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

An implementation agent should follow these rules even when a local refactor
looks easier another way:

1. Read `AGENTS.md` and the files named by the current phase before editing.
2. Work in phase and task order. Mark a checkbox in the pull request that makes
   its acceptance criteria pass; do not mark speculative or partially complete
   work.
3. Keep each PR behavior-preserving unless a task explicitly names a behavior
   change. State `API_PROTOCOL` and `STATE_VERSION` impact in every PR.
4. Prefer mechanical rename-only commits before typed refactors. This keeps
   review and `git blame` useful.
5. When introducing a schema, delete the corresponding hand-written validator
   in the same PR or explain the short-lived dependency and name the PR that
   will remove it.
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
12. Update this tracker in the implementation PR that completes a task or
    phase, with a link to the authoritative code rather than duplicating its
    operational details here.

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
      data.
- [ ] Snapshot validation is complete, strict, and all-or-nothing.
- [ ] Public views are discriminated by game and phase without catch-all fields.
- [ ] Client action construction and successful responses are typed end to end.
- [ ] The browser build owns asset hashing and module traversal.
- [ ] One build produces the exact server and Pages artifacts that are tested.
- [ ] Production installs no packages and executes no build tools.
- [ ] The fast test suite and Chromium smoke suite pass without external
      services.
- [ ] The old validator, declaration, stamping, and source-entry paths are gone.
- [ ] The maintained documentation describes one coherent architecture.
