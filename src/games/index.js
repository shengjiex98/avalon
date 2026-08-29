// The registry is the room/game boundary. It gives game modules an explicit
// view of the shared room and the engine-owned state while an operation runs.

// @ts-check

import { GameError } from '../lobby.js';
import * as avalon from './avalon/game.js';
import { MAX_PLAYERS as AVALON_MAX, MIN_PLAYERS as AVALON_MIN } from './avalon/rules.js';
import * as onuw from './onuw/game.js';
import { MAX_PLAYERS as ONUW_MAX, MIN_PLAYERS as ONUW_MIN } from './onuw/rules.js';

/** @typedef {import('../../types/contracts.js').CreatedRoom} CreatedRoom */
/** @typedef {import('../../types/contracts.js').GameEntry} GameEntry */
/** @typedef {import('../../types/contracts.js').GameId} GameId */
/** @typedef {import('../../types/contracts.js').PersistedRoom} PersistedRoom */
/** @typedef {import('../../types/contracts.js').RuntimeRoom} RuntimeRoom */

/**
 * @param {{
 *   id: GameId,
 *   minPlayers: number,
 *   maxPlayers: number,
 *   module: any,
 *   actions: Record<string, (...args: any[]) => unknown>,
 * }} definition
 * @returns {GameEntry & Record<string, any>}
 */
function entry({ id, minPlayers, maxPlayers, module, actions }) {
  return {
    id,
    minPlayers,
    maxPlayers,

    /** Create the persisted room fields and engine member together. */
    create(code, options) {
      return /** @type {CreatedRoom} */ (module.createGame(code, options).room);
    },

    /** The only game hook for room membership changes. */
    rosterChange(room, type, player) {
      const context = { room, state: room.game.state };
      if (type === 'join') return module.addPlayer(context, player);
      if (type === 'leave') return module.removePlayer(context, player.id);
      throw new GameError('unknownAction', { type });
    },

    /** Dispatch one engine-owned command. */
    command(room, playerId, body, operationContext) {
      const action = actions[body.type];
      if (!action) throw new GameError('unknownAction', { type: body.type });
      return action({ room, state: room.game.state }, playerId, body, operationContext);
    },

    view(room, playerId, now) {
      return module.viewFor({ room, state: room.game.state }, playerId, now);
    },

    deadline(room) {
      return module.nextDeadline?.({ room, state: room.game.state }) ?? null;
    },

    tick(room, now) {
      return module.tick?.({ room, state: room.game.state }, now) ?? false;
    },

    // Direct game-module seams remain for focused rule tests. Room code uses
    // the explicit operations above.
    addPlayer: module.addPlayer,
    removePlayer: module.removePlayer,
    viewFor: module.viewFor,
    nextDeadline: module.nextDeadline,
    actions,
  };
}

/** @type {Record<GameId, GameEntry & Record<string, any>>} */
export const GAMES = {
  avalon: entry({
    id: 'avalon',
    minPlayers: AVALON_MIN,
    maxPlayers: AVALON_MAX,
    module: avalon,
    actions: {
      options: (g, id, body) => avalon.setOptions(g, id, body.options ?? {}),
      start: (g, id) => avalon.startGame(g, id),
      confirm: (g, id) => avalon.confirmRole(g, id),
      propose: (g, id, body) => avalon.proposeTeam(g, id, body.team ?? []),
      vote: (g, id, body) => avalon.castVote(g, id, body.approve === true),
      card: (g, id, body) => avalon.playCard(g, id, body.success !== false),
      assassinate: (g, id, body) => avalon.assassinate(g, id, body.target),
      reset: (g, id, _body, context) => avalon.restartToLobby(g, id, context),
      again: (g, id, _body, context) => avalon.resetToLobby(g, id, context),
    },
  }),

  onuw: entry({
    id: 'onuw',
    minPlayers: ONUW_MIN,
    maxPlayers: ONUW_MAX,
    module: onuw,
    actions: {
      options: (g, id, body) => onuw.setOptions(g, id, body.options ?? {}),
      start: (g, id, _body, { now } = {}) => onuw.startGame(g, id, { now }),
      confirm: (g, id, _body, { now } = {}) => onuw.confirmRole(g, id, { now }),
      night: (g, id, body) => onuw.submitNight(g, id, body.action ?? {}),
      startVote: (g, id) => onuw.startVote(g, id),
      vote: (g, id, body) => onuw.castVote(g, id, body.target),
      reset: (g, id, _body, context) => onuw.restartToLobby(g, id, context),
      again: (g, id, _body, context) => onuw.resetToLobby(g, id, context),
    },
  }),
};

export const DEFAULT_GAME = 'avalon';
export const GAME_IDS = Object.keys(GAMES);

/** @param {unknown} id @returns {GameEntry & Record<string, any>} */
export function gameFor(id) {
  const game = /** @type {Record<string, GameEntry & Record<string, any>>} */ (GAMES)[String(id)];
  if (!game) throw new GameError('noSuchGame', { game: id });
  return game;
}
