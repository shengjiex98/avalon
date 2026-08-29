# Testing

Run the complete gate with:

```bash
npm test
```

The project uses Node's built-in test runner, needs no dependency installation,
network access, or browser, and discovers `test/**/*.test.js`. CI and release
packaging run the same gate on Node 24.

Development also checks the JavaScript boundary contracts after installing the
locked development tools:

```bash
npm ci
npm run typecheck
```

The no-emit checker covers validated commands, room and engine state,
snapshots, phase-specific views, and the game registry. It does not build or
change the shipped modules, and it does not replace `npm test`. CI runs both;
see [`package.json`](../package.json),
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml), and
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml).

The suite covers:

- both game engines, deterministic randomness, rules, and hidden views;
- rooms, timers, persistence, reconnection, and real HTTP/SSE behavior;
- browser rendering and interaction through the lightweight DOM shim;
- translation coverage in English and Chinese; and
- release packaging, pointer validation, activation, deferral, and rollback.

Test filenames describe their scope. UI tests use
[`test/dom-shim.js`](../test/dom-shim.js) rather than a browser dependency.
