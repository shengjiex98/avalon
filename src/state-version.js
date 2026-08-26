// Bump when the in-memory room/game state shape changes incompatibly.
// A snapshot stamped with a different version is discarded on boot,
// which degrades to today's behavior: those games end.
export const STATE_VERSION = 1;
