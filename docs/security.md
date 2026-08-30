# Security and trust model

Avalon is intended for private games among people who know one another. A room
code grants access to a room, and an unguessable browser-held player ID
represents a seat. There are no accounts or server-side authentication; add
network or reverse-proxy access control when that model is insufficient.

The server—not the browser—enforces legal actions and derives filtered views,
so modifying a client does not grant another player's hidden information or an
illegal move. The authoritative boundaries are the action and view functions
under [`src/server/games/`](../src/server/games/) and the request validation in
[`src/server/commands.ts`](../src/server/commands.ts).

Uploaded avatars are processed before storage. Automatic avatars are disabled
unless Cloudflare credentials are configured and send the display name to
Cloudflare Workers AI. Storage, limits, and request behavior are implemented in
[`src/server/avatars.ts`](../src/server/avatars.ts) and
[`src/client/app.ts`](../src/client/app.ts).

## Deployment authority

Expose only the game application. The host reaches GitHub and ntfy outbound;
deployment has no inbound control endpoint. An exact `deploy` notification can
only wake the updater and cannot select code.

The protected workflow publishes immutable bytes before changing `latest.json`.
The permanently installed updater validates that pointer and archive, checks
the release manifest, and never executes candidate deployment scripts. See
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml),
[`deploy/listen.mjs`](../deploy/listen.mjs), and
[`deploy/updater.sh`](../deploy/updater.sh).
