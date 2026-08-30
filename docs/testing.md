# Testing

Run the complete gate with:

```bash
npm test
```

The project uses Node's built-in test runner, needs no network access or
browser after `npm ci`, and discovers JavaScript and TypeScript tests under
`test/`. The gate first builds the browser into `build/public/`; emitted-entry
tests select the fingerprinted module through Vite's build manifest, and HTTP
tests exercise the same output a browser receives.

Development also checks the TypeScript contracts with the locked tools:

```bash
npm ci
npm run typecheck
```

The no-emit checker covers validated commands, room and engine state,
snapshots, phase-specific views, the browser client, and the game registry.
Use `npm run build:browser` when only the emitted client is needed, or
`npm start` to rebuild it before starting the local server. CI runs the full
test and typecheck gates; see [`package.json`](../package.json),
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml), and
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml).

The suite covers:

- both game engines, deterministic randomness, rules, and hidden views;
- rooms, timers, persistence, reconnection, and real HTTP/SSE behavior;
- browser rendering and interaction through the lightweight DOM shim;
- translation coverage in English and Chinese; and
- release packaging, extracted-entry startup and snapshot restore, pointer
  validation, activation, deferral, and rollback.

Test filenames describe their scope. UI tests use
[`test/dom-shim.js`](../test/dom-shim.js) rather than a browser dependency.
