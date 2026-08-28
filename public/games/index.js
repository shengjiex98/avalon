// Which games the client knows how to draw. Mirrors src/games/index.js.

import * as avalon from './avalon.js';
import * as onuw from './onuw.js';

export const GAMES = { avalon, onuw };
export const GAME_IDS = Object.keys(GAMES);
export const DEFAULT_GAME = 'avalon';
export const knownGame = (id) => Object.hasOwn(GAMES, id);

// Drawing an unknown game as Avalon would show a table the wrong board. A
// stored preference is sanitized where it is read; anything left is a server
// this client is too old to render, which the caller must handle as such.
export function gameFor(id) {
  const game = GAMES[id];
  if (!game) throw new Error(`unknown game: ${id}`);
  return game;
}
