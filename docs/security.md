# Security and trust model

Avalon is designed for a private game among people who know one another.

- Anyone with a room code can join the room.
- A random ID stored by the browser represents a player's identity.
- There are no accounts, passwords, or server-side authentication.
- Use a private network or add access control at the reverse proxy if the
  server should not be publicly reachable.
- Automatic avatars send the player's display name to Cloudflare Workers AI.
  They are disabled unless the server operator supplies a Cloudflare account ID
  and Workers AI token, are cached by normalized name, and are capped at 30 new
  generations per hour and 200 per rolling day by default. Uploaded photos are
  cropped and re-encoded in the browser before being stored, which strips their
  original metadata.

The server still enforces game rules and hidden information. Editing the
browser client cannot reveal another player's role, vote twice, or let a good
Avalon character submit a Fail card.

## Deployment authority

The Tailscale Funnel exposes only the Avalon application. Deployment has no
public inbound endpoint: the host makes outbound GitHub and ntfy connections.
An exact `deploy` ntfy message is only a wake-up and cannot name code. Authority
comes from `latest.json` on the fixed `deployment-artifacts` GitHub Release;
the default-branch workflow publishes the immutable archive before replacing
that pointer. The installed updater derives the archive name from a validated
commit, verifies the pointer's SHA-256, checks the embedded manifest, and never
executes candidate deployment scripts.
