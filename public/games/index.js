// @ts-check
// Which games the client knows how to draw. Mirrors src/games/index.js.

import * as avalon from './avalon.js';
import * as onuw from './onuw.js';
import { assertNever } from '../assert-never.js';

/** @typedef {import('../../src/contracts/actions.ts').GameId} GameId */

export const GAMES = { avalon, onuw };
export const GAME_IDS = Object.keys(GAMES);
export const DEFAULT_GAME = 'avalon';
/** @param {unknown} id @returns {id is GameId} */
export const knownGame = (id) => typeof id === 'string' && Object.hasOwn(GAMES, id);

// Drawing an unknown game as Avalon would show a table the wrong board. A
// stored preference is sanitized where it is read; anything left is a server
// this client is too old to render, which the caller must handle as such.
/** @param {GameId} id */
export function gameFor(id) {
  switch (id) {
    case 'avalon': return GAMES.avalon;
    case 'onuw': return GAMES.onuw;
    default: return assertNever(id, `unknown game: ${String(id)}`);
  }
}
