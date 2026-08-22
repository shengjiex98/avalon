// Which games the client knows how to draw. Mirrors src/games/index.js.

import * as avalon from './avalon.js';
import * as onuw from './onuw.js';

export const GAMES = { avalon, onuw };
export const GAME_IDS = Object.keys(GAMES);
export const DEFAULT_GAME = 'avalon';
export const gameFor = (id) => GAMES[id] ?? GAMES[DEFAULT_GAME];
