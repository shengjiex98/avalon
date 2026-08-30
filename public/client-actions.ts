// Shell-owned actions are constructed here so they are checked against the
// same schema-derived union as game renderer actions.

import type { ClientAction, GameId } from '../src/contracts/actions.ts';

export const switchGameAction = (game: GameId): ClientAction => ({ type: 'setGame', game });
export const resetAction = (): ClientAction => ({ type: 'reset' });
export const startAction = (): ClientAction => ({ type: 'start' });
