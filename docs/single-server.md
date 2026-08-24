# Single-server deployment

This was Avalon's deployment model on 2026-08-23 before the optional GitHub
Pages client was restored. Keep this note as the reversion target if supporting
two entry points stops being worth its maintenance cost.

## Decision

One Node process owns the whole application:

```text
browser ──same origin──> Node
                         ├── public/*
                         ├── /api/*
                         └── in-memory rooms
```

There is no static-site deployment, configurable backend, or CORS. A room link
uses the Node server's URL and `#/ROOM`. The server-generated `/version.json`
is retained so open clients can offer to reload after a deployment.

This model is preferable when operational simplicity matters more than having a
stable client URL independent of the machine hosting the rooms. It gives every
deployment one URL, one version, and one failure domain.

## Reversion checklist

1. Delete `.github/workflows/pages.yml` and
   `scripts/stamp-frontend-version.mjs`. Delete `public/config.js` and do not
   check in `public/version.json`; Node generates that response from public-file
   modification times.
2. In `public/app.js`, remove backend selection and protocol probing. Call
   `fetch(path)` and `new EventSource('/api/...')` directly, omit the server
   picker, and make copied invitations contain only `#/ROOM`.
3. In `src/server.js`, remove `CLIENT_ORIGIN`, CORS response headers, and
   `OPTIONS` handling. Keep `/api/health` only as a liveness endpoint; its
   protocol field may remain for diagnostics.
4. Remove the server-selection translation strings and change-server UI tests.
   Keep the test asserting that `/version.json` is generated with
   `Cache-Control: no-store`.
5. Update `README.md` and `deploy/avalon.service` so only `PORT` and `HOST` are
   deployment settings. Run `npm test`.

The resulting runtime should contain no references to `CLIENT_ORIGIN`,
`avalon.server`, `?server=`, GitHub Pages actions, or cross-origin API calls.
