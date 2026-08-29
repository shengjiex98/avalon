// Snapshot validators. They validate persisted data, including references
// between engine state and the room roster, before any room is installed.

// @ts-check

import {
  HOUSE_RULE_KEYS as AVALON_HOUSE_RULES,
  OPTIONAL_ROLES as AVALON_OPTIONS,
  ROLES as AVALON_ROLES,
} from './avalon/rules.js';
import {
  HOUSE_RULE_KEYS as ONUW_HOUSE_RULES,
  OPTIONAL_ROLES as ONUW_OPTIONS,
  PACES,
  ROLES as ONUW_ROLES,
} from './onuw/rules.js';

/** @typedef {import('../../types/contracts.js').AvalonContext} AvalonContext */
/** @typedef {import('../../types/contracts.js').AvalonPhase} AvalonPhase */
/** @typedef {import('../../types/contracts.js').AvalonState} AvalonState */
/** @typedef {import('../../types/contracts.js').OnuwContext} OnuwContext */
/** @typedef {import('../../types/contracts.js').OnuwPhase} OnuwPhase */
/** @typedef {import('../../types/contracts.js').OnuwState} OnuwState */

/** @param {unknown} value @returns {value is Record<string, any>} */
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/** @param {unknown} value @param {number} [min] */
const integer = (value, min = 0) => Number.isInteger(value) && /** @type {number} */ (value) >= min;
/** @param {unknown} value */
const finite = (value) => Number.isFinite(value);
/** @param {unknown} value */
const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
/** @param {unknown} value */
const booleans = (value) => record(value) && Object.values(value).every((item) => typeof item === 'boolean');
/** @param {unknown} value */
const stringMap = (value) => record(value) && Object.values(value).every((item) => typeof item === 'string');
/** @param {unknown} values @param {Set<string>} ids */
const idsIn = (values, ids) => strings(values) && values.every((id) => ids.has(id));
/** @param {unknown} value @param {Set<string>} ids */
const keysIn = (value, ids) => record(value) && Object.keys(value).every((id) => ids.has(id));
/** @param {any[]} values */
const unique = (values) => new Set(values).size === values.length;
/** @param {Record<string, any>} value @param {string[]} required @param {string[]} [optional] */
const exactKeys = (value, required, optional = []) => {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
};
/** @param {unknown} value @param {Set<string>} ids @param {string[]} values */
const enumMap = (value, ids, values) => stringMap(value)
  && keysIn(value, ids)
  && Object.values(/** @type {Record<string, string>} */ (value)).every((item) => values.includes(item));
/** @param {unknown} value @param {string[]} keys */
const exactBooleanKeys = (value, keys) => booleans(value)
  && exactKeys(/** @type {Record<string, any>} */ (value), keys);

/** @param {AvalonContext | OnuwContext} g @param {(AvalonPhase | OnuwPhase)[]} phases */
function common(g, phases) {
  if (!phases.includes(g.phase)) return false;
  if (!record(g.options) || !booleans(g.houseRules)) return false;
  return true;
}

/** @param {AvalonContext} g @param {AvalonState} state */
export function validateAvalon(g, state) {
  const ids = new Set(g.players.map((player) => player.id));
  const stateKeys = [
    'phase', 'options', 'optionsTouched', 'houseRules', 'roles', 'round', 'leaderIndex',
    'rejects', 'team', 'votes', 'lastVote', 'cards', 'quests',
    'assassinTarget', 'winner', 'winReason',
  ];
  if (!exactKeys(state, stateKeys, ['ready'])) return false;
  if (!common(g, ['lobby', 'reveal', 'team', 'vote', 'quest', 'assassin', 'over'])) return false;
  if (g.players.length > 10 || (g.phase !== 'lobby' && g.players.length < 5)) return false;
  if (!exactBooleanKeys(g.options, AVALON_OPTIONS) || !exactBooleanKeys(g.houseRules, AVALON_HOUSE_RULES)) return false;
  if (typeof g.optionsTouched !== 'boolean' || !enumMap(g.roles, ids, Object.keys(AVALON_ROLES))) return false;
  if (!integer(g.round) || g.round > 4) return false;
  if (!integer(g.leaderIndex) || (g.players.length && g.leaderIndex >= g.players.length)) return false;
  if (!integer(g.rejects) || !idsIn(g.team, ids) || !unique(g.team)) return false;
  if (!booleans(g.votes) || !keysIn(g.votes, ids) || !booleans(g.cards) || !keysIn(g.cards, ids)) return false;
  if (!keysIn(g.ready ?? {}, ids) || !booleans(g.ready ?? {})) return false;
  if (g.lastVote !== null && !validateAvalonVote(g.lastVote, ids)) return false;
  if (!Array.isArray(g.quests) || !g.quests.every((quest) => validateQuest(quest, ids))) return false;
  if (g.assassinTarget !== null && !ids.has(g.assassinTarget)) return false;
  if (![null, 'good', 'evil'].includes(g.winner)) return false;
  if (g.winReason !== null && typeof g.winReason !== 'string') return false;
  if ((g.phase === 'over') !== (g.winner !== null && g.winReason !== null)) return false;
  if (g.phase === 'lobby' && Object.keys(g.roles).length) return false;
  if (g.phase !== 'lobby' && Object.keys(g.roles).length !== ids.size) return false;
  return true;
}

/** @param {any} vote @param {Set<string>} ids */
function validateAvalonVote(vote, ids) {
  return record(vote)
    && integer(vote.round)
    && integer(vote.attempt, 1)
    && idsIn(vote.team, ids)
    && unique(vote.team)
    && booleans(vote.votes)
    && keysIn(vote.votes, ids)
    && typeof vote.approved === 'boolean';
}

/** @param {any} quest @param {Set<string>} ids */
function validateQuest(quest, ids) {
  return record(quest)
    && integer(quest.round)
    && idsIn(quest.team, ids)
    && unique(quest.team)
    && integer(quest.fails)
    && typeof quest.success === 'boolean';
}

/** @param {OnuwContext} g @param {OnuwState} state */
export function validateOnuw(g, state) {
  const ids = new Set(g.players.map((player) => player.id));
  const stateKeys = [
    'phase', 'options', 'optionsTouched', 'houseRules', 'pace', 'script', 'step',
    'stepEndsAt', 'ready', 'startRoles', 'centreStart', 'finalRoles', 'centre',
    'nightActions', 'info', 'swaps', 'votes', 'dead', 'winners',
  ];
  if (!exactKeys(state, stateKeys)) return false;
  if (!common(g, ['lobby', 'reveal', 'night', 'day', 'vote', 'over'])) return false;
  if (g.players.length > 10 || (g.phase !== 'lobby' && g.players.length < 3)) return false;
  if (!exactBooleanKeys(g.options, ONUW_OPTIONS) || !exactBooleanKeys(g.houseRules, ONUW_HOUSE_RULES)) return false;
  if (typeof g.optionsTouched !== 'boolean' || !(g.pace in PACES)) return false;
  if (!Array.isArray(g.script) || !g.script.every(validateScriptStep)) return false;
  if (!Number.isInteger(g.step) || !finite(g.stepEndsAt)) return false;
  if (!booleans(g.ready) || !keysIn(g.ready, ids)) return false;
  if (!enumMap(g.startRoles, ids, Object.keys(ONUW_ROLES))) return false;
  if (!strings(g.centreStart) || !g.centreStart.every((role) => role in ONUW_ROLES)) return false;
  if (!enumMap(g.finalRoles, ids, Object.keys(ONUW_ROLES))) return false;
  if (!strings(g.centre) || !record(g.nightActions) || !keysIn(g.nightActions, ids)) return false;
  if (!g.centre.every((role) => role in ONUW_ROLES) || !Object.values(g.nightActions).every(record)) return false;
  if (!record(g.info) || !keysIn(g.info, ids) || !Object.values(g.info).every(validateInfo)) return false;
  if (!Array.isArray(g.swaps) || !g.swaps.every(validateEvent)) return false;
  if (!stringMap(g.votes) || !keysIn(g.votes, ids) || !Object.values(g.votes).every((id) => ids.has(id))) return false;
  if (!idsIn(g.dead, ids) || !unique(g.dead) || !strings(g.winners)) return false;
  if (!g.winners.every((team) => ['village', 'werewolf', 'tanner'].includes(team))) return false;
  if (g.phase === 'lobby' && (Object.keys(g.startRoles).length || g.centreStart.length)) return false;
  if (g.phase !== 'lobby' && Object.keys(g.startRoles).length !== ids.size) return false;
  if (g.phase !== 'lobby' && g.centreStart.length !== 3) return false;
  if (g.phase !== 'lobby' && g.centre.length !== 3) return false;
  if (g.phase === 'night' && (g.step < 0 || g.step >= g.script.length)) return false;
  return true;
}

/** @param {any} step */
const validateScriptStep = (step) => record(step)
  && typeof step.key === 'string'
  && finite(step.seconds) && step.seconds > 0
  && (step.role === undefined || step.role in ONUW_ROLES);

/** @param {any} event */
const validateEvent = (event) => record(event) && typeof event.key === 'string' && record(event.params);
/** @param {unknown} events */
const validateInfo = (events) => Array.isArray(events) && events.every(validateEvent);
