# Build and deployment simplification plan

Status: implemented.

This plan replaces project-specific artifact construction with one standard
build tool while preserving the deployment behavior that protects running
games. It deliberately treats the build and the deployment controller as
different concerns:

- Vite will own browser compilation, asset fingerprinting, and the production
  Node bundle.
- A small amount of repository code will still stage runtime configuration,
  describe a release, test the finished artifact, and create its archive.
- The installed updater will continue to own selection, compatibility,
  snapshot, activation, health, and rollback policy.

The goal is not to eliminate every script. It is to leave custom code only
where Avalon has a custom requirement.

## Target state

The authored tree follows the runtime boundary already established under
`src/`:

```text
index.html
src/
├── client/
│   ├── app.ts
│   └── styles.css
├── contracts/
└── server/
    └── main.ts
public/
├── art/
├── audio/
└── config.js
vite.config.ts
```

`public/` contains only files that Vite copies without transformation.
`config.js` is a safe same-origin development default; staging overwrites it
for each deployment target.

One CI build produces:

```text
build/
├── public/                 # fingerprinted browser artifact
│   ├── index.html
│   ├── config.js           # default until staging replaces it
│   ├── assets/
│   ├── art/
│   └── audio/
└── server/
    └── main.mjs            # Node 24 bundle, including Zod
```

The server release then contains only:

```text
avalon-<commit>/
├── release.json
└── build/
    ├── public/             # self-hosted configured copy
    └── server/main.mjs
```

There is no source tree, `node_modules`, package manifest, lockfile, compiler,
test suite, or deployment control plane in the archive. Production still
installs nothing and performs no build.

## Decisions

These decisions should not be reopened during implementation unless a stop
condition below is reached.

### Preserve the deployment safety model

Keep these properties and their existing coverage:

- CI builds once, tests the assembled output, and publishes those same bytes.
- `latest.json` identifies an immutable archive by commit and SHA-256 digest,
  and moves only after the archive is available.
- The updater rejects unsafe archive paths and extracted objects before
  activation.
- Releases remain immutable directories selected through the atomic `current`
  symlink.
- `STATE_VERSION` and `API_PROTOCOL` continue to gate deployment through an
  active game.
- The updater snapshots state before restart, proves the exact commit through
  health, and restores the previous release and snapshot on failure.
- The server deploys and proves the target commit before the Pages client is
  published.
- The deployment control plane remains statically installed outside candidate
  releases. Candidate code is never executed to decide whether it is safe.

These are application or operating requirements, not consequences of the
current build implementation.

### Remove accidental archive requirements

The archive does not need to be reproducible byte-for-byte. The updater
compares the downloaded file with the digest computed from the exact file CI
published; it never rebuilds the archive. Keep the digest and remove:

- the GNU-tar capability gate;
- normalized timestamps, ownership, ordering, and `gzip -n`;
- the test that packaging one commit twice produces identical bytes; and
- documentation that incorrectly makes reproducibility the basis of digest
  trust.

Packaging must remain fail-closed and atomic: write a partial archive, verify
that it can be listed, then rename it to its final name. Ordinary `tar` is
sufficient.

Do not ship `deploy/` or trusted verifier scripts inside application releases.
The installed updater does not use them, and the host clone is the explicit
source for manual control-plane installation.

### Use Vite for both runtime outputs

Use Vite as the only new direct build dependency.

For the browser build:

- use `index.html` as the standard entry;
- set a relative base so the same output works at `/` and under the Pages
  project path;
- move authored CSS beside the client source and let Vite fingerprint it;
- retain `public/art/` and `public/audio/` as copy-only assets;
- emit Vite's build manifest for artifact verification; and
- disable production source maps.

Remove `src/client/bootstrap.ts`. Vite's fingerprinted HTML, entry, chunks, and
CSS replace the bootstrap and recursive import stamping.

The loaded client still needs an exact release identity for update checks.
Define it at build time from `AVALON_BUILD_COMMIT`; CI must supply its 40-digit
workflow commit, while local builds may use `dev`. Continue staging
`version.json` so a deployed page can detect a newer front-end without relying
on cache freshness.

Keep backend configuration external to the bundle. `index.html` loads
`config.js` before the module entry, and the client reads one typed value from
`globalThis`. Staging writes the self-hosted and Pages values from the authored
`API_PROTOCOL` and the workflow's `API_BASE`. Do not use Vite environment
replacement for `API_BASE`: that would require two builds and break the tested
build-once boundary.

For the server build:

- use `src/server/main.ts` as the Node-targeted entry;
- emit ESM as `build/server/main.mjs`;
- bundle Zod and other application dependencies;
- leave Node built-ins external; and
- disable minification and source maps unless a measured production need
  justifies them later.

The production entry must locate `release.json` and `build/public` from the
service working directory, which is already the selected release root. Keep
path inputs injectable for tests. Checkout development may continue to run the
native TypeScript source; production and artifact tests run the bundle.

### Keep a small release adapter

Vite is not a deployment system. Retain small, single-purpose code for:

- generating the target-specific `config.js` and `version.json` files;
- writing `release.json` from the authored compatibility constants;
- assembling and atomically archiving the release directory;
- verifying the browser and release manifests from the trusted checkout; and
- starting the extracted production entry and exercising health, HTTP, SSE,
  static assets, snapshot, and restart behavior.

Do not replace this adapter with `npm pack`. The target is a runnable release,
not an installable npm package, and bundling removes the dependency-packaging
problem that `npm pack` would otherwise solve.

Do not introduce a container, registry, self-hosted Actions runner, or general
deployment framework. None replaces Avalon's live-game compatibility and
state transaction, and each adds an operating component.

## Execution

Implement this in two PRs. The first changes only the browser build and can use
the current updater unchanged. The second is one deliberate server artifact
and static-control-plane cutover; it must not leave parallel release layouts.

### PR 1 — Standard browser build

1. Add Vite as a pinned development dependency and add the browser portion of
   `vite.config.ts`.
2. Move `public/index.html` to the repository root and `public/styles.css` to
   `src/client/styles.css`. Make `public/` copy-only.
3. Replace the imported `src/client/config.ts` runtime value with a typed
   `globalThis` configuration populated by `public/config.js`.
4. Replace the bootstrap entry with the normal Vite entry and replace the
   query-string release identity with `AVALON_BUILD_COMMIT`.
5. Change `build:browser` to invoke Vite. In deployment CI, pass
   `AVALON_BUILD_COMMIT=$GITHUB_SHA`; keep a useful local `dev` default.
6. Simplify browser staging to copy the tested build twice, overwrite
   `config.js`, write `version.json`, and add Pages' `.nojekyll`. It must not
   rewrite HTML, JavaScript, CSS, or Vite's module graph.
7. Change browser verification to use Vite's manifest and referenced output
   files, plus explicit checks for runtime configuration, release identity,
   copy-only assets, and absence of TypeScript/source maps.
8. Delete `scripts/build-browser.mjs`,
   `scripts/stamp-frontend-version.mjs`, `src/client/bootstrap.ts`, and
   `tsconfig.browser.json`, along with tests of their removed behavior.
9. Update architecture, testing, and deployment documentation to describe the
   implemented browser build without copying Vite configuration into prose.

Acceptance:

- `npm test` and `npm run typecheck` pass;
- the ordinary suite imports and exercises the emitted client entry selected
  by the build manifest;
- the self-hosted and Pages trees come from one browser build and differ only
  in generated configuration, `version.json`, and Pages metadata;
- a fresh load and an old cached page both resolve a complete single-version
  asset graph;
- update detection still reports a newly published front end;
- the Pages client still reaches the configured backend and rejects an
  incompatible API protocol; and
- `API_PROTOCOL` and `STATE_VERSION` do not change.

### PR 2 — Bundled server and minimal release

Preflight the server bundle in the PR branch before changing the release
contract. Extract a release-shaped directory with no `node_modules`, start
`build/server/main.mjs` through a `current` symlink, and run the packaged
behavior test. Stop if Vite cannot produce a Node 24 bundle without runtime
shims or another production dependency.

After that proof:

1. Add the server build to `vite.config.ts` and package scripts. Ensure the
   client and server outputs can be cleaned and built together without one
   deleting the other.
2. Make production root/static paths explicit and testable, then change the
   packaged behavior test to start `build/server/main.mjs`.
3. Reduce the package verifier to the release manifest, bundled entry, browser
   artifact, allowed tree shape, Node major, and compatibility values. Remove
   dependency and candidate-control-plane checks.
4. Reduce `scripts/package-release.sh` to assemble `release.json`,
   `build/server/`, and the staged self-hosted `build/public/`, then create and
   read back an atomic archive with ordinary `tar`.
5. Remove production pruning, copied `node_modules`, source export, lockfile
   packaging, deterministic-tar options, and their tests.
6. Bump `deployerSchema` once for the new required paths. Update the installed
   updater to require `build/server/main.mjs` and `build/public/index.html`, and
   update the systemd unit to start the bundle.
7. Keep archive-name, link, extracted-tree, digest, manifest, active-game,
   snapshot, health, rollback, and retention tests. Add a negative assertion
   that the release contains no source, packages, tests, or `deploy/` tree.
8. Simplify the deployment workflow arguments and update the maintained docs.
   It must still upload the exact archive and Pages tree tested in the first
   job and must not rebuild either later.

The schema and service change is a manual control-plane cutover, not a
compatibility feature. After the PR merges, immediately update the host clone
to that merge commit and run:

```bash
deploy/install-updater.sh
systemctl --user daemon-reload
```

The deployment workflow may be waiting for exact-commit health while this is
done; its periodic wake-up will let the newly installed updater reconcile the
already published release. Do not teach the updater to run two server paths,
translate an old release, install itself from a candidate, or preserve a
schema-2 release as an automatic rollback. The previous release remains an
operator-visible artifact, but crossing this deployment schema is an explicit
manual operation.

Acceptance:

- `npm test` and `npm run typecheck` pass;
- an extracted archive starts on Node 24 with an empty `node_modules` search
  path and passes the packaged startup, HTTP, SSE, static, snapshot, and restart
  checks;
- the archive contains only `release.json`, `build/server/`, and
  `build/public/` beneath its commit root;
- corrupt downloads, unsafe paths, bad manifests, failed health, incompatible
  active games, and failed restarts retain their current fail-closed behavior;
- the host runs the exact merged commit after the manual installation;
- Pages publishes only after that server health check succeeds; and
- the obsolete release layout and all tests/documentation requiring it are
  deleted in the same PR.

## Expected script disposition

| Current script | End state |
| --- | --- |
| `build-browser.mjs` | Delete; Vite builds the browser. |
| `stamp-frontend-version.mjs` | Delete; hashed output plus staged identity replaces graph rewriting. |
| `browser-config.mjs` | Retain or fold into staging as the small runtime-config generator. |
| `stage-browser-artifacts.mjs` | Retain, simplified to copy and generate target metadata. |
| `verify-browser-artifact.mjs` | Retain, simplified around the Vite manifest and deployment invariants. |
| `package-release.sh` | Retain as a short atomic archive adapter. |
| `write-release-manifest.mjs` | Retain; it owns Avalon compatibility metadata, not compilation. |
| `verify-packaged-release.mjs` | Retain, simplified to the minimal release contract. |
| `test-packaged-release.mjs` | Retain; it proves the exact production entry and state lifecycle. |
| `tools/generate-onuw-audio.py` | Keep unchanged; it is an offline source-asset generator. |

Completion should reduce custom build/packaging code and tests materially, but
line count is not the acceptance criterion. Every remaining script must map to
one of the repository-specific responsibilities above.

## Stop conditions

Stop and bring back evidence rather than broadening the design if:

1. the server bundle needs a runtime loader, generated native binary, or a
   production package outside the bundle;
2. runtime `API_BASE` configuration requires separate browser builds;
3. Vite output cannot work for both root hosting and the Pages project path;
4. artifact tests would need to execute source or candidate deployment code;
5. production would need an install, build, compiler, or package manager;
6. build output is regenerated after its artifact tests;
7. the implementation changes gameplay, persistence, API shapes, or public
   trust boundaries; or
8. the cutover would require permanent dual-layout support in the updater.

If the server preflight fails, still complete PR 1 and retain native server
TypeScript plus production packages. In that fallback, simplify the archive by
removing reproducibility and candidate control-plane files, but do not add a
second bundler merely to force the target layout.

## Completion criteria

This plan is complete when Vite owns browser and server emission, the archive
contains only runnable output and release metadata, the old stamping and
dependency-packaging paths are gone, the static updater has been manually
installed for the new schema, and the preserved deployment safety tests pass
against the running merged release.
