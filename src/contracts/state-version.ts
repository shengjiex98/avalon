// Bump when the in-memory room/game state or its meaning changes incompatibly.
// A snapshot stamped with a different version is discarded on boot,
// which degrades to today's behavior: those games end.
export const STATE_VERSION = 3;
