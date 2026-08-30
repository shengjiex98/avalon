// @ts-check
// Shell-owned actions are constructed here so they are checked against the
// same schema-derived union as game renderer actions.

/** @typedef {import('../src/contracts/actions.ts').ClientAction} ClientAction */
/** @typedef {import('../src/contracts/actions.ts').GameId} GameId */

/** @param {GameId} game @returns {ClientAction} */
export const switchGameAction = (game) => ({ type: 'setGame', game });
/** @returns {ClientAction} */
export const resetAction = () => ({ type: 'reset' });
/** @returns {ClientAction} */
export const startAction = () => ({ type: 'start' });
