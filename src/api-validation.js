// @ts-check

import { GameError } from './lobby.js';
import {
  HOUSE_RULE_KEYS as AVALON_HOUSE_RULES,
  OPTIONAL_ROLES as AVALON_OPTIONS,
} from './games/avalon/rules.js';
import {
  HOUSE_RULE_KEYS as ONUW_HOUSE_RULES,
  OPTIONAL_ROLES as ONUW_OPTIONS,
  PACES,
} from './games/onuw/rules.js';

/** @typedef {import('../types/contracts.js').CreateRoomCommand} CreateRoomCommand */
/** @typedef {import('../types/contracts.js').GameId} GameId */
/** @typedef {import('../types/contracts.js').JoinCommand} JoinCommand */
/** @typedef {import('../types/contracts.js').ValidatedAction} ValidatedAction */

/** @returns {never} */
const fail = () => { throw new GameError('badRequest'); };
/** @param {unknown} value @returns {Record<string, unknown>} */
const record = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
  return /** @type {Record<string, unknown>} */ (value);
};
/** @param {unknown} value */
const string = (value) => typeof value === 'string' && value.length > 0;

/**
 * @param {unknown} value
 * @param {string[]} allowed
 * @param {string[]} [required]
 */
function exact(value, allowed, required = []) {
  const body = record(value);
  if (Object.keys(body).some((key) => !allowed.includes(key))) fail();
  if (required.some((key) => !(key in body))) fail();
  return body;
}

/** @param {unknown} value @param {string[]} allowed */
function booleanSettings(value, allowed) {
  const settings = exact(value, allowed);
  if (Object.values(settings).some((entry) => typeof entry !== 'boolean')) fail();
}

/** @param {unknown} value @returns {CreateRoomCommand} */
export function validateCreateRoom(value) {
  const body = exact(value, ['game']);
  if ('game' in body && !string(body.game)) fail();
  return /** @type {CreateRoomCommand} */ (body);
}

/** @param {unknown} value @returns {JoinCommand} */
export function validateJoin(value) {
  const body = exact(value, ['name', 'playerId', 'avatar'], ['name']);
  if (typeof body.name !== 'string') fail();
  // A browser holding no seat for this room sends null rather than omitting the
  // key, and the join below already reads a non-string id as no id at all.
  if (body.playerId != null && !string(body.playerId)) fail();
  if ('avatar' in body && body.avatar !== false && typeof body.avatar !== 'string') fail();
  return /** @type {JoinCommand} */ (body);
}

/** @param {GameId} gameId @param {unknown} value @returns {ValidatedAction} */
export function validateAction(gameId, value) {
  const body = record(value);
  if (!string(body.type) || !string(body.playerId)) fail();

  if (body.type === 'setGame') {
    exact(body, ['type', 'playerId', 'game'], ['game']);
    if (!string(body.game)) fail();
    return /** @type {ValidatedAction} */ (body);
  }
  if (body.type === 'leave') {
    exact(body, ['type', 'playerId']);
    return /** @type {ValidatedAction} */ (body);
  }

  if (gameId === 'avalon') validateAvalonAction(body);
  else if (gameId === 'onuw') validateOnuwAction(body);
  else throw new GameError('noSuchGame', { game: gameId });
  return /** @type {ValidatedAction} */ (body);
}

/** @param {Record<string, unknown>} body */
function validateAvalonAction(body) {
  switch (body.type) {
    case 'options': {
      exact(body, ['type', 'playerId', 'options'], ['options']);
      const options = exact(body.options, [...AVALON_OPTIONS, 'houseRules']);
      for (const key of AVALON_OPTIONS) if (key in options && typeof options[key] !== 'boolean') fail();
      if ('houseRules' in options) booleanSettings(options.houseRules, AVALON_HOUSE_RULES);
      break;
    }
    case 'start': case 'confirm': case 'reset': case 'again':
      exact(body, ['type', 'playerId']);
      break;
    case 'propose':
      exact(body, ['type', 'playerId', 'team'], ['team']);
      if (!Array.isArray(body.team) || body.team.some((id) => !string(id))) fail();
      break;
    case 'vote':
      exact(body, ['type', 'playerId', 'approve'], ['approve']);
      if (typeof body.approve !== 'boolean') fail();
      break;
    case 'card':
      exact(body, ['type', 'playerId', 'success'], ['success']);
      if (typeof body.success !== 'boolean') fail();
      break;
    case 'assassinate':
      exact(body, ['type', 'playerId', 'target'], ['target']);
      if (!string(body.target)) fail();
      break;
    default:
      throw new GameError('unknownAction', { type: body.type });
  }
}

/** @param {Record<string, unknown>} body */
function validateOnuwAction(body) {
  switch (body.type) {
    case 'options': {
      exact(body, ['type', 'playerId', 'options'], ['options']);
      const options = exact(body.options, [...ONUW_OPTIONS, 'houseRules', 'pace']);
      for (const key of ONUW_OPTIONS) if (key in options && typeof options[key] !== 'boolean') fail();
      if ('houseRules' in options) booleanSettings(options.houseRules, ONUW_HOUSE_RULES);
      if ('pace' in options
          && (typeof options.pace !== 'string' || !Object.hasOwn(PACES, options.pace))) fail();
      break;
    }
    case 'start': case 'confirm': case 'startVote': case 'reset': case 'again':
      exact(body, ['type', 'playerId']);
      break;
    case 'night':
      exact(body, ['type', 'playerId', 'action'], ['action']);
      validateNightAction(body.action);
      break;
    case 'vote':
      exact(body, ['type', 'playerId', 'target'], ['target']);
      if (!string(body.target)) fail();
      break;
    default:
      throw new GameError('unknownAction', { type: body.type });
  }
}

/** @param {unknown} value */
function validateNightAction(value) {
  const action = record(value);
  const keys = Object.keys(action);
  if (keys.length === 1 && action.skip === true) return;
  if (keys.length === 1 && Number.isInteger(action.centre)) return;
  if (keys.length === 1 && string(action.target)) return;
  if (keys.length === 1 && Array.isArray(action.targets)
      && action.targets.length === 2 && action.targets.every(string)) return;
  if (action.mode === 'player') {
    exact(action, ['mode', 'target'], ['target']);
    if (string(action.target)) return;
  }
  if (action.mode === 'centre') {
    exact(action, ['mode', 'centres'], ['centres']);
    if (Array.isArray(action.centres) && action.centres.length === 2
        && action.centres.every(Number.isInteger)) return;
  }
  fail();
}
