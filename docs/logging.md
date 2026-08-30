# Planned operational logging

Status: planned; the server currently writes only startup and unexpected-error
messages to standard output and error, which systemd captures for
`avalon.service`.

Add one structured JSON record for each completed API request, with a request
ID, method, normalized route, status, and duration. Add similarly structured
records for unexpected failures, room and game lifecycle events, snapshot
outcomes, and SSE connection counts. Keep browser interaction telemetry out of
scope; successful game commands already live in the private room journal.

Operational logs must not contain request bodies, credentials, uploaded
avatars, hidden game state, or raw room and player identifiers. Do not record
client IP addresses by default. Emit through standard output and error so
production records remain available through `journalctl --user -u
avalon.service`; retention remains the host journal's responsibility.
