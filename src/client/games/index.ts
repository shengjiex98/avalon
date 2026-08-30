// Which games the client knows how to draw. Mirrors the server game registry.

import * as avalon from './avalon.ts';
import * as onuw from './onuw.ts';
import { assertNever } from '../assert-never.ts';
import type { GameId } from '../../contracts/actions.ts';

export const GAMES = { avalon, onuw };
export const GAME_IDS: GameId[] = ['avalon', 'onuw'];
export const DEFAULT_GAME: GameId = 'avalon';
export const knownGame = (id: unknown): id is GameId =>
  typeof id === 'string' && Object.hasOwn(GAMES, id);

// Drawing an unknown game as Avalon would show a table the wrong board. A
// stored preference is sanitized where it is read; anything left is a server
// this client is too old to render, which the caller must handle as such.
export function gameFor(id: GameId) {
  switch (id) {
    case 'avalon': return GAMES.avalon;
    case 'onuw': return GAMES.onuw;
    default: return assertNever(id, `unknown game: ${String(id)}`);
  }
}
