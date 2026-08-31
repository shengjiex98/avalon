# Operational logging

The server writes structured JSON records to standard output and error, which
systemd captures for `avalon.service`. The record shapes and intentionally
small event set live in [`src/server/logging.ts`](../src/server/logging.ts),
[`src/server/main.ts`](../src/server/main.ts), and
[`src/server/rooms.ts`](../src/server/rooms.ts).

Each completed API request has a request ID, method, normalized route, status,
and duration. Other records cover unexpected failures, room and game lifecycle
transitions, snapshot health changes, and SSE connection counts. Repeated
successful snapshot writes are suppressed. Browser interaction telemetry stays
out of scope; successful game commands already live in the private room
journal.

Operational logs must not contain request bodies, credentials, uploaded
avatars, hidden game state, or raw room and player identifiers. Do not record
client IP addresses by default. Emit through standard output and error so
production records remain available through `journalctl --user -u
avalon.service`; retention remains the host journal's responsibility.
