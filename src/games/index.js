// The registry. A game is anything that can build a room state, take actions
// and render a per-player view; the room layer knows nothing else about it.

import { GameError } from '../lobby.js';
import * as avalon from './avalon/game.js';
import { MAX_PLAYERS as AVALON_MAX, MIN_PLAYERS as AVALON_MIN } from './avalon/rules.js';
import * as onuw from './onuw/game.js';
import { MAX_PLAYERS as ONUW_MAX, MIN_PLAYERS as ONUW_MIN } from './onuw/rules.js';

export const GAMES = {
  avalon: {
    id: 'avalon',
    minPlayers: AVALON_MIN,
    maxPlayers: AVALON_MAX,
    create: (code, opts) => avalon.createGame(code, opts),
    addPlayer: avalon.addPlayer,
    removePlayer: avalon.removePlayer,
    viewFor: avalon.viewFor,
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
  },

  onuw: {
    id: 'onuw',
    minPlayers: ONUW_MIN,
    maxPlayers: ONUW_MAX,
    create: (code, opts) => onuw.createGame(code, opts),
    addPlayer: onuw.addPlayer,
    removePlayer: onuw.removePlayer,
    viewFor: onuw.viewFor,
    nextDeadline: onuw.nextDeadline,
    tick: onuw.tick,
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
  },
};

export const DEFAULT_GAME = 'avalon';
export const GAME_IDS = Object.keys(GAMES);

// An id nobody recognizes is not a game of Avalon. Callers holding a request
// value let this reach the client as `noSuchGame`; callers holding room state
// are reporting a corrupt room, which no caller should paper over.
export function gameFor(id) {
  const game = GAMES[id];
  if (!game) throw new GameError('noSuchGame', { game: id });
  return game;
}
