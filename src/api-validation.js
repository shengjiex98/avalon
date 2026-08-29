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

const fail = () => { throw new GameError('badRequest'); };
const record = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
  return value;
};
const string = (value) => typeof value === 'string' && value.length > 0;

function exact(value, allowed, required = []) {
  const body = record(value);
  if (Object.keys(body).some((key) => !allowed.includes(key))) fail();
  if (required.some((key) => !(key in body))) fail();
  return body;
}

function booleanSettings(value, allowed) {
  const settings = exact(value, allowed);
  if (Object.values(settings).some((entry) => typeof entry !== 'boolean')) fail();
}

export function validateCreateRoom(value) {
  const body = exact(value, ['game']);
  if ('game' in body && !string(body.game)) fail();
  return body;
}

export function validateJoin(value) {
  const body = exact(value, ['name', 'playerId', 'avatar'], ['name']);
  if (typeof body.name !== 'string') fail();
  if ('playerId' in body && !string(body.playerId)) fail();
  if ('avatar' in body && body.avatar !== false && typeof body.avatar !== 'string') fail();
  return body;
}

export function validateAction(gameId, value) {
  const body = record(value);
  if (!string(body.type) || !string(body.playerId)) fail();

  if (body.type === 'setGame') {
    exact(body, ['type', 'playerId', 'game'], ['game']);
    if (!string(body.game)) fail();
    return body;
  }
  if (body.type === 'leave') {
    exact(body, ['type', 'playerId']);
    return body;
  }

  if (gameId === 'avalon') validateAvalonAction(body);
  else if (gameId === 'onuw') validateOnuwAction(body);
  else throw new GameError('noSuchGame', { game: gameId });
  return body;
}

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

function validateOnuwAction(body) {
  switch (body.type) {
    case 'options': {
      exact(body, ['type', 'playerId', 'options'], ['options']);
      const options = exact(body.options, [...ONUW_OPTIONS, 'houseRules', 'pace']);
      for (const key of ONUW_OPTIONS) if (key in options && typeof options[key] !== 'boolean') fail();
      if ('houseRules' in options) booleanSettings(options.houseRules, ONUW_HOUSE_RULES);
      if ('pace' in options && !Object.hasOwn(PACES, options.pace)) fail();
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
