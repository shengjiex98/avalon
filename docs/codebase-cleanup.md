# Deferred public-service hardening

Status: deferred; this is not the current project priority.

The former cleanup tracker mixed completed work, speculative test tooling, and
future hardening. It now retains only the three decisions that may matter if the
game is exposed beyond its current friends-only trust model.

- Completed items have been removed from this tracker; the code and history are
  authoritative for what already landed.
- Former items 15–16 are dropped. Replay tooling and expanded fuzz/property
  testing are not planned.
- Three hardening items remain deliberately deferred.

Deferral is a scope decision, not a security conclusion. In particular, a
public seat ID is still identity rather than a secure authorization capability.

## Remaining work

| Item | Outcome | Priority now | Status |
| --- | --- | --- | --- |
| 1 | Bound public resource use and request abuse | Not current | Deferred |
| 2 | Bound avatar storage and async lifecycle | Not current | Deferred |
| 3 | Authenticate private seat views and actions | Not current | Deferred |

Reassess these items if the service is intentionally opened to untrusted users.
Item 3 should be the first
security design revisited before calling the deployment safe for public use;
items 1–2 protect availability and storage.

## Item 1 — Public resource and request bounds

Goal: one user or network origin cannot consume unbounded rooms, joins, actions,
or avatar-generation capacity.

Implementation outline:

- Put rate and concurrency decisions at the HTTP/service boundary rather than
  inside game rules.
- Bound limiter key storage and make time injectable for deterministic tests.
- Trust forwarded client addresses only behind explicitly configured proxy
  boundaries.
- Return consistent `429`/capacity errors that reveal no private room state.
- Keep limits in one configuration object and avoid duplicating values in docs.

Acceptance:

- deterministic tests cover bursts, refill/expiry, bounded key storage, proxy
  trust, and concurrent avatar work;
- normal reconnect and live-game flows remain usable; and
- memory use cannot grow indefinitely from unique rejected identities.

## Item 2 — Avatar lifecycle

Goal: avatar work and stored avatar files remain bounded without deleting files
referenced by live rooms.

Implementation outline:

- Reserve quota before generation and release it atomically on failure.
- Prune by explicit age/storage policy while protecting live references.
- Ignore stale asynchronous completions after a player leaves, changes avatar,
  or the room is replaced.
- Cover concurrent generation, cleanup, restart, and failure paths.

Acceptance:

- quota cannot be exceeded through concurrent requests;
- stale work cannot overwrite newer player state;
- cleanup never removes a live referenced avatar; and
- failed or abandoned work eventually releases its reservation and files.

## Item 3 — Seat credentials

Goal: knowing a public room code or seat ID cannot reveal private views or
authorize actions for that seat.

Implementation outline:

- Issue a high-entropy seat credential and persist only the server-side material
  needed to verify it.
- Derive the viewer/actor from the verified credential; do not accept an actor
  ID in an action body as authority.
- Carry credentials through same-origin and Pages transports without placing
  them in URLs, views, event payloads, errors, or logs.
- Define explicit credential/version migration. Do not silently upgrade a
  public seat ID into a secret.
- Remove unauthenticated private endpoints and overly broad response fields in a
  coordinated compatibility release.
- Update the security and API docs only after the implemented protocol is
  authoritative.

Acceptance:

- a public seat ID alone cannot read that seat's role/private state or act as
  the seat;
- reconnect and test mode use credentials deliberately;
- old unauthenticated paths fail after the compatibility cutover; and
- focused leak tests cover URLs, views, events, errors, and logs.

Because this changes persisted identity and the browser/server protocol, plan
the required `STATE_VERSION` and `API_PROTOCOL` bumps as part of the item rather
than hiding them in a cleanup refactor.
