// The Avalon state machine. Pure logic: it never touches the network, the
// clock (beyond timestamps) or randomness it was not handed.

import {
  HOUSE_RULES, HOUSE_RULE_KEYS, MAX_PLAYERS, MAX_REJECTS, MIN_PLAYERS, OPTIONAL_ROLES,
  buildRoleList, defaultOptions, failsRequired, knowledgeFor, sideOf, teamSize,
} from './rules.js';
import * as lobby from '../../lobby.js';
import { logEvent, playerById, randInt, require_, shuffleWith } from '../../lobby.js';

export function createGame(code, { now = Date.now, seed } = {}) {
  return {
    ...lobby.baseState(code, 'avalon', { now, seed }),
    options: Object.fromEntries(OPTIONAL_ROLES.map((r) => [r, false])),
    optionsTouched: false,  // manual choices last only until the table size changes
    houseRules: { ...HOUSE_RULES },    // variants, as a new table plays them
    roles: {},              // playerId -> role key
    round: 0,               // 0-based quest index
    leaderIndex: 0,
    rejects: 0,
    team: [],
    votes: {},              // playerId -> boolean
    lastVote: null,         // { team, votes, approved, round, attempt }
    cards: {},              // playerId -> boolean (true = success)
    quests: [],             // [{ round, team, fails, success }]
    assassinTarget: null,
    winner: null,           // 'good' | 'evil'
    winReason: null,
  };
}

const leader = (g) => g.players[g.leaderIndex];
const evilPlayers = (g) => g.players.filter((p) => sideOf(g.roles[p.id]) === 'evil');

/**
 * The deck the lobby is currently describing. Once the cards are out, it is
 * whatever they were dealt from.
 */
const liveOptions = (g) =>
  (g.phase !== 'lobby' || g.optionsTouched ? g.options : defaultOptions(g.players.length));

const houseRulesOf = (g) => lobby.houseRulesInForce(g, HOUSE_RULE_KEYS);

// ---------------------------------------------------------------- lobby

function resetOptionsForPlayerCount(g) {
  g.options = defaultOptions(g.players.length);
  g.optionsTouched = false;
}

export function addPlayer(g, player) {
  const count = g.players.length;
  const joined = lobby.addPlayer(g, player, { maxPlayers: MAX_PLAYERS });
  if (g.players.length !== count) resetOptionsForPlayerCount(g);
  return joined;
}

export function removePlayer(g, playerId) {
  const count = g.players.length;
  lobby.removePlayer(g, playerId);
  if (g.players.length !== count) resetOptionsForPlayerCount(g);
}

export function setOptions(g, playerId, options) {
  require_(g.phase === 'lobby', 'gameAlreadyStarted');
  require_(playerId === g.hostId, 'hostOnly');
  if (options.houseRules) lobby.setHouseRules(g, options.houseRules, HOUSE_RULE_KEYS);
  const next = { ...liveOptions(g) };
  let touched = g.optionsTouched;
  for (const r of OPTIONAL_ROLES) {
    if (r in options) { next[r] = Boolean(options[r]); touched = true; }
  }
  g.options = next;
  g.optionsTouched = touched;
}

export function startGame(g, playerId, { shuffle = (list) => shuffleWith(g, list) } = {}) {
  require_(g.phase === 'lobby', 'gameAlreadyStarted');
  require_(playerId === g.hostId, 'hostOnly');
  require_(g.players.length >= MIN_PLAYERS, 'needMorePlayers', { min: MIN_PLAYERS });

  const options = liveOptions(g);
  const randomLeader = houseRulesOf(g).randomLeader;
  const roleList = shuffle(buildRoleList(g.players.length, options));
  // Roles come off a shuffled deck either way; only the seating and the first
  // leader are what this house rule decides.
  const seats = randomLeader ? shuffle(g.players.slice()) : g.players.slice();
  g.options = options;
  g.players = seats;
  g.roles = Object.fromEntries(seats.map((p, i) => [p.id, roleList[i]]));

  g.phase = 'reveal';
  g.ready = {};
  g.leaderIndex = randomLeader ? randInt(g, g.players.length) : 0;
  logEvent(g, 'log.gameStarted', { count: g.players.length });
}

/** Every player confirms they have read their role; then the first leader proposes. */
export function confirmRole(g, playerId) {
  require_(g.phase === 'reveal', 'wrongPhase');
  require_(playerById(g, playerId), 'notInGame');
  g.ready[playerId] = true;
  if (g.players.every((p) => g.ready[p.id])) {
    g.phase = 'team';
    logEvent(g, 'log.leaderTurn', { name: leader(g).name, size: currentTeamSize(g) });
  }
}

// ---------------------------------------------------------------- quests

export const currentTeamSize = (g) => teamSize(g.players.length, g.round);
export const currentFailsRequired = (g) => failsRequired(g.players.length, g.round);

export function proposeTeam(g, playerId, memberIds) {
  require_(g.phase === 'team', 'wrongPhase');
  require_(playerId === leader(g).id, 'notLeader');
  const unique = [...new Set(memberIds)];
  require_(unique.length === memberIds.length, 'duplicateMember');
  require_(unique.every((id) => playerById(g, id)), 'unknownMember');
  require_(unique.length === currentTeamSize(g), 'wrongTeamSize', { size: currentTeamSize(g) });

  g.team = unique;
  g.votes = {};
  g.phase = 'vote';
  logEvent(g, 'log.teamProposed', {
    name: leader(g).name,
    members: unique.map((id) => playerById(g, id).name),
  });
}

export function castVote(g, playerId, approve) {
  require_(g.phase === 'vote', 'wrongPhase');
  require_(playerById(g, playerId), 'notInGame');
  require_(!(playerId in g.votes), 'alreadyVoted');
  g.votes[playerId] = Boolean(approve);
  if (Object.keys(g.votes).length === g.players.length) resolveVote(g);
}

function resolveVote(g) {
  const approvals = g.players.filter((p) => g.votes[p.id]).length;
  const approved = approvals * 2 > g.players.length;
  g.lastVote = {
    round: g.round,
    attempt: g.rejects + 1,
    team: g.team.slice(),
    votes: { ...g.votes },
    approved,
  };
  logEvent(g, approved ? 'log.voteApproved' : 'log.voteRejected', {
    yes: approvals,
    no: g.players.length - approvals,
  });

  if (approved) {
    // With the switch off, rejections accumulate across quests until the fifth
    // hands evil the game. An approved team clears them only when requested.
    if (houseRulesOf(g).resetRejects) g.rejects = 0;
    g.cards = {};
    g.phase = 'quest';
    return;
  }

  g.rejects += 1;
  if (g.rejects >= MAX_REJECTS) {
    finish(g, 'evil', 'win.hammer');
    return;
  }
  nextLeader(g);
  g.team = [];
  g.phase = 'team';
  logEvent(g, 'log.leaderTurn', { name: leader(g).name, size: currentTeamSize(g) });
}

function nextLeader(g) {
  g.leaderIndex = (g.leaderIndex + 1) % g.players.length;
}

export function playCard(g, playerId, success) {
  require_(g.phase === 'quest', 'wrongPhase');
  require_(g.team.includes(playerId), 'notOnTeam');
  require_(!(playerId in g.cards), 'alreadyPlayed');
  const wantsFail = success === false;
  require_(!(wantsFail && sideOf(g.roles[playerId]) === 'good'), 'goodMustSucceed');
  g.cards[playerId] = !wantsFail;
  if (g.team.every((id) => id in g.cards)) resolveQuest(g);
}

function resolveQuest(g) {
  const fails = g.team.filter((id) => g.cards[id] === false).length;
  const success = fails < currentFailsRequired(g);
  g.quests.push({ round: g.round, team: g.team.slice(), fails, success });
  logEvent(g, success ? 'log.questSucceeded' : 'log.questFailed', {
    round: g.round + 1,
    fails,
  });
  afterQuest(g);
}

/** Where a settled quest leaves the game. */
function afterQuest(g) {
  const successes = g.quests.filter((q) => q.success).length;
  const failures = g.quests.length - successes;

  if (failures >= 3) return finish(g, 'evil', 'win.threeFails');
  if (successes >= 3) {
    g.phase = 'assassin';
    g.team = [];
    logEvent(g, 'log.assassinTurn', {});
    return;
  }

  g.round += 1;
  g.team = [];
  g.cards = {};
  nextLeader(g);
  g.phase = 'team';
  logEvent(g, 'log.leaderTurn', { name: leader(g).name, size: currentTeamSize(g) });
}

/**
 * The Assassin names anyone but themselves. Only Merlin is a hit — naming
 * another evil player is a legal, losing move, and has to stay legal: with
 * Oberon at the table the Assassin cannot tell him from a Loyal Servant, so
 * refusing the pick would answer that question for free and hand back the
 * shot.
 */
export function assassinate(g, playerId, targetId) {
  require_(g.phase === 'assassin', 'wrongPhase');
  require_(g.roles[playerId] === 'assassin', 'assassinOnly');
  const target = playerById(g, targetId);
  require_(target, 'unknownMember');
  require_(targetId !== playerId, 'cannotTargetSelf');

  g.assassinTarget = targetId;
  const hit = g.roles[targetId] === 'merlin';
  logEvent(g, hit ? 'log.assassinHit' : 'log.assassinMiss', { name: target.name });
  finish(g, hit ? 'evil' : 'good', hit ? 'win.merlinSlain' : 'win.threeSuccesses');
}

function finish(g, winner, reason) {
  g.phase = 'over';
  g.winner = winner;
  g.winReason = reason;
  logEvent(g, 'log.gameOver', { winner });
}

/** What this table agreed to before the cards came out, and keeps. */
const lobbyKeeps = (g) => ({
  options: g.options,
  optionsTouched: Boolean(g.optionsTouched),
  houseRules: houseRulesOf(g),
});

export function resetToLobby(g, playerId, { now = Date.now } = {}) {
  lobby.resetToLobby(g, playerId, () => ({
    fresh: createGame(g.code, { now, seed: g.seed }),
    keep: lobbyKeeps(g),
  }));
}

export function restartToLobby(g, playerId, { now = Date.now } = {}) {
  lobby.restartToLobby(g, playerId, () => ({
    fresh: createGame(g.code, { now, seed: g.seed }),
    keep: lobbyKeeps(g),
  }));
}

// ---------------------------------------------------------------- views

/**
 * What one player is allowed to see. Roles of others are only ever included
 * through `knowledge`, or once the game is over.
 */
export function viewFor(g, viewerId) {
  const me = playerById(g, viewerId);
  const myRole = g.roles[viewerId] ?? null;
  const revealAll = g.phase === 'over';

  return {
    ...lobby.baseView(g, viewerId),
    you: me ? {
      id: me.id, name: me.name, avatar: me.avatar ?? null,
      role: myRole, side: myRole ? sideOf(myRole) : null,
    } : null,
    players: g.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar ?? null,
      seat: i,
      isLeader: g.phase !== 'lobby' && i === g.leaderIndex,
      onTeam: g.team.includes(p.id),
      hasVoted: g.phase === 'vote' ? p.id in g.votes : undefined,
      hasPlayed: g.phase === 'quest' && g.team.includes(p.id) ? p.id in g.cards : undefined,
      ready: g.phase === 'reveal' ? Boolean(g.ready?.[p.id]) : undefined,
      role: revealAll ? g.roles[p.id] : undefined,
    })),
    options: { ...liveOptions(g) },
    houseRules: houseRulesOf(g),
    // The deck is public — the lobby agreed it — and only the mapping from a
    // role to a player is secret. `deck` is what the lobby is heading for,
    // with `null` for a table that cannot be dealt as asked; `roleCounts` is
    // what a running game was dealt, and stays absent from the lobby so a
    // client that predates the lobby deck cannot mistake one for the other.
    deck: g.phase === 'lobby' ? safeRoleCounts(g) : null,
    roleCounts: g.phase === 'lobby' ? null : countRoles(buildRoleList(g.players.length, g.options)),
    round: g.round,
    rejects: g.rejects,
    maxRejects: MAX_REJECTS,
    teamSize: g.phase === 'lobby' ? null : currentTeamSize(g),
    failsRequired: g.phase === 'lobby' ? null : currentFailsRequired(g),
    boardSizes: g.players.length >= MIN_PLAYERS && g.players.length <= MAX_PLAYERS
      ? [0, 1, 2, 3, 4].map((r) => ({
          size: teamSize(g.players.length, r),
          twoFails: failsRequired(g.players.length, r) === 2,
        }))
      : null,
    team: g.team.slice(),
    quests: g.quests.map((q) => ({
      round: q.round, success: q.success, fails: q.fails, team: q.team,
    })),
    // Under hidden votes the per-player ballot never leaves the server: the
    // table gets the tally, which is what decides the mission, and nothing
    // else. Withholding the whole field rather than emptying it keeps a client
    // that predates the rule from drawing everyone as a rejection.
    lastVote: houseRulesOf(g).hiddenVotes ? null : g.lastVote,
    voteTally: voteTally(g),
    knowledge: myRole ? knowledgeFor(viewerId, g.roles) : [],
    assassinTarget: g.assassinTarget,
    winner: g.winner,
    winReason: g.winReason,
    // Everything below is "what am I waiting on" for the UI.
    waitingFor: waitingFor(g).map((p) => p.id),
    evilCount: g.phase === 'lobby' ? null : evilPlayers(g).length,
  };
}

function countRoles(roles) {
  const counts = {};
  for (const role of roles) counts[role] = (counts[role] ?? 0) + 1;
  return counts;
}

/** The lobby's deck, or nothing when this table cannot be dealt as asked. */
function safeRoleCounts(g) {
  try {
    return countRoles(buildRoleList(g.players.length, liveOptions(g)));
  } catch {
    return null;
  }
}

/** How the last vote went, without saying who made it go that way. */
function voteTally(g) {
  if (!g.lastVote) return null;
  const ballots = Object.values(g.lastVote.votes);
  const yes = ballots.filter(Boolean).length;
  return {
    round: g.lastVote.round,
    attempt: g.lastVote.attempt,
    approved: g.lastVote.approved,
    yes,
    no: ballots.length - yes,
  };
}

function waitingFor(g) {
  switch (g.phase) {
    case 'reveal': return g.players.filter((p) => !g.ready?.[p.id]);
    case 'team':   return [leader(g)];
    case 'vote':   return g.players.filter((p) => !(p.id in g.votes));
    case 'quest':  return g.team.map((id) => playerById(g, id)).filter((p) => !(p.id in g.cards));
    case 'assassin': return g.players.filter((p) => g.roles[p.id] === 'assassin');
    default: return [];
  }
}
