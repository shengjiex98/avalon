// Snapshot validators. They validate persisted data, including references
// between engine state and the room roster, before any room is installed.

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

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min = 0) => Number.isInteger(value) && value >= min;
const finite = (value) => Number.isFinite(value);
const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
const booleans = (value) => record(value) && Object.values(value).every((item) => typeof item === 'boolean');
const stringMap = (value) => record(value) && Object.values(value).every((item) => typeof item === 'string');
const idsIn = (values, ids) => strings(values) && values.every((id) => ids.has(id));
const keysIn = (value, ids) => record(value) && Object.keys(value).every((id) => ids.has(id));
const unique = (values) => new Set(values).size === values.length;
const exactKeys = (value, required, optional = []) => {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
};
const enumMap = (value, ids, values) => stringMap(value)
  && keysIn(value, ids)
  && Object.values(value).every((item) => values.includes(item));
const exactBooleanKeys = (value, keys) => booleans(value)
  && exactKeys(value, keys);

function common(g, phases) {
  if (!phases.includes(g.phase)) return false;
  if (!record(g.options) || !booleans(g.houseRules)) return false;
  return true;
}

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

function validateQuest(quest, ids) {
  return record(quest)
    && integer(quest.round)
    && idsIn(quest.team, ids)
    && unique(quest.team)
    && integer(quest.fails)
    && typeof quest.success === 'boolean';
}

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

const validateScriptStep = (step) => record(step)
  && typeof step.key === 'string'
  && finite(step.seconds) && step.seconds > 0
  && (step.role === undefined || step.role in ONUW_ROLES);

const validateEvent = (event) => record(event) && typeof event.key === 'string' && record(event.params);
const validateInfo = (events) => Array.isArray(events) && events.every(validateEvent);
