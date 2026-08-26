# Testing

Run all tests with Node's built-in test runner:

```bash
npm test
```

The suite does not need network access or a browser.

## Test groups

- **rules:** role setup, role fitting, and each role's knowledge.
- **game:** deterministic Avalon games, including rejected teams, the fifth
  rejection, two-fail quests, assassination outcomes, and hidden-role views.
- **onuw:** deterministic nights on a controlled clock, deck-derived scripts,
  center roles, fixed step timing, hidden actor state, forced Drunk swaps, win
  conditions, and card privacy.
- **rooms:** timer-driven night steps, broadcasts, and timer cleanup when rooms
  expire, plus action recording and persistence hooks.
- **determinism:** seeded deals, seating, and leader selection.
- **persistence:** JSON-state invariants, atomic snapshot round trips, restored
  timers and idle age, and corrupt or incompatible snapshot handling.
- **server:** real HTTP on an ephemeral port, including a complete five-player
  game over SSE.
- **i18n-coverage:** every client key, server error, win reason, and log event
  exists in English and Chinese.
- **ui:** home, invitations, language switching, and joining, rendered with the
  lightweight DOM shim in `test/dom-shim.js`.
- **ui-game / ui-onuw:** every phase of both games, rendered from real engine
  views in both languages, including countdown redraw regressions.
- **ui-connect:** cold joins, reconnection, and failures inside game view hooks.
- **ui-reconnect:** what a deployment restart does to an open game -- recovering
  when the room survived, re-taking a seat it did not, ending cleanly when the
  room is gone, and waking on `online`/`focus` rather than sitting out a backoff.
- **ui-reload:** reloading for a new client build mid-game, including a reload
  that arrives without the URL fragment and one that lands while the server is
  still restarting.
- **ui-testmode:** adding and switching seats through normal join and event
  paths, including rejected joins.
- **deploy:** Node-hosted and GitHub Pages entry points, frontend version
  stamping, HTTPS backend selection, protocol checks, and state-compatible
  update gating.
