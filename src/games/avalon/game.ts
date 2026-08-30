// The Avalon state machine. Pure logic: it never touches the network, the
// clock (beyond timestamps) or randomness it was not handed.

import {
  HOUSE_RULES, HOUSE_RULE_KEYS, MAX_PLAYERS, MAX_REJECTS, MIN_PLAYERS, OPTIONAL_ROLES,
  buildRoleList, defaultOptions, failsRequired, knowledgeFor, sideOf, teamSize,
} from './rules.ts';
import type { AvalonOptions, AvalonRole } from './rules.ts';
import * as lobby from '../../lobby.ts';
import { logEvent, playerById, randInt, require_, shuffleWith } from '../../lobby.ts';
import type { AvalonState, Player } from '../../contracts/persistence.ts';
import type { AvalonCommand, AvalonContext } from '../../contracts/runtime.ts';
import type { AvalonView } from '../../contracts/views.ts';

type CreateOptions = { now?: () => number; seed?: number };
type SetOptions = Extract<AvalonCommand, { type: 'options' }>['options'];
type ShuffleOptions = { shuffle?: <T>(list: T[]) => T[] };

export function createGame(code: string, { now = Date.now, seed }: CreateOptions = {}): AvalonContext {
  const state: AvalonState = {
    phase: 'lobby',
    options: { percival: false, morgana: false, mordred: false, oberon: false },
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
  const room = lobby.baseRoom(code, 'avalon', state, { now, ...(seed === undefined ? {} : { seed }) });
  return { room, state };
}

const leader = (g: AvalonContext): Player => g.room.players[g.state.leaderIndex]!;
const evilPlayers = (g: AvalonContext): Player[] =>
  g.room.players.filter((player) => sideOf(g.state.roles[player.id]!) === 'evil');

/**
 * The deck the lobby is currently describing. Once the cards are out, it is
 * whatever they were dealt from.
 */
/** @param {AvalonContext} g */
const liveOptions = (g: AvalonContext): AvalonOptions =>
  (g.state.phase !== 'lobby' || g.state.optionsTouched ? g.state.options : defaultOptions(g.room.players.length));

/** @param {AvalonContext} g */
const houseRulesOf = (g: AvalonContext): AvalonState['houseRules'] =>
  lobby.houseRulesInForce(g, HOUSE_RULE_KEYS);

// ---------------------------------------------------------------- lobby

/** @param {AvalonContext} g */
function resetOptionsForPlayerCount(g: AvalonContext): void {
  g.state.options = defaultOptions(g.room.players.length);
  g.state.optionsTouched = false;
}

/** @param {AvalonContext} g @param {{ id: string, name?: string, avatar?: string }} player */
export function addPlayer(
  g: AvalonContext,
  player: { id: string; name?: string; avatar?: string },
): Player {
  const count = g.room.players.length;
  const joined = lobby.addPlayer(g, player, { maxPlayers: MAX_PLAYERS });
  if (g.room.players.length !== count) resetOptionsForPlayerCount(g);
  return joined;
}

/** @param {AvalonContext} g @param {string} playerId */
export function removePlayer(g: AvalonContext, playerId: string): void {
  const count = g.room.players.length;
  lobby.removePlayer(g, playerId);
  if (g.room.players.length !== count) resetOptionsForPlayerCount(g);
}

export function setOptions(g: AvalonContext, playerId: string, options: SetOptions): void {
  require_(g.state.phase === 'lobby', 'gameAlreadyStarted');
  require_(playerId === g.room.hostId, 'hostOnly');
  if (options.houseRules) lobby.setHouseRules(g, options.houseRules, HOUSE_RULE_KEYS);
  const next = { ...liveOptions(g) };
  let touched = g.state.optionsTouched;
  for (const r of OPTIONAL_ROLES) {
    if (r in options) { next[r] = Boolean(options[r]); touched = true; }
  }
  g.state.options = next;
  g.state.optionsTouched = touched;
}

/** @param {AvalonContext} g @param {string} playerId @param {{ shuffle?: <T>(list: T[]) => T[] }} [options] */
export function startGame(
  g: AvalonContext,
  playerId: string,
  { shuffle = <T>(list: T[]) => shuffleWith(g, list) }: ShuffleOptions = {},
): void {
  require_(g.state.phase === 'lobby', 'gameAlreadyStarted');
  require_(playerId === g.room.hostId, 'hostOnly');
  require_(g.room.players.length >= MIN_PLAYERS, 'needMorePlayers', { min: MIN_PLAYERS });

  const options = liveOptions(g);
  const randomLeader = houseRulesOf(g).randomLeader;
  const roleList = shuffle(buildRoleList(g.room.players.length, options));
  // Roles come off a shuffled deck either way; only the seating and the first
  // leader are what this house rule decides.
  const seats = randomLeader ? shuffle(g.room.players.slice()) : g.room.players.slice();
  g.state.options = options;
  g.room.players = seats;
  g.state.roles = Object.fromEntries(seats.map((player, index) => [player.id, roleList[index]!]));

  g.state.phase = 'reveal';
  g.state.ready = {};
  g.state.leaderIndex = randomLeader ? randInt(g, g.room.players.length) : 0;
  logEvent(g, 'log.gameStarted', { count: g.room.players.length });
}

/** Every player confirms they have read their role; then the first leader proposes. */
/** @param {AvalonContext} g @param {string} playerId */
export function confirmRole(g: AvalonContext, playerId: string): void {
  require_(g.state.phase === 'reveal', 'wrongPhase');
  require_(playerById(g, playerId), 'notInGame');
  const ready = g.state.ready ??= {};
  ready[playerId] = true;
  if (g.room.players.every((p) => ready[p.id])) {
    g.state.phase = 'team';
    logEvent(g, 'log.leaderTurn', { name: leader(g).name, size: currentTeamSize(g) });
  }
}

// ---------------------------------------------------------------- quests

/** @param {AvalonContext} g */
export const currentTeamSize = (g: AvalonContext): number =>
  teamSize(g.room.players.length, g.state.round)!;
/** @param {AvalonContext} g */
export const currentFailsRequired = (g: AvalonContext): number =>
  failsRequired(g.room.players.length, g.state.round);

/** @param {AvalonContext} g @param {string} playerId @param {string[]} memberIds */
export function proposeTeam(g: AvalonContext, playerId: string, memberIds: string[]): void {
  require_(g.state.phase === 'team', 'wrongPhase');
  require_(playerId === leader(g).id, 'notLeader');
  const unique = [...new Set(memberIds)];
  require_(unique.length === memberIds.length, 'duplicateMember');
  require_(unique.every((id) => playerById(g, id)), 'unknownMember');
  require_(unique.length === currentTeamSize(g), 'wrongTeamSize', { size: currentTeamSize(g) });

  g.state.team = unique;
  g.state.votes = {};
  g.state.phase = 'vote';
  logEvent(g, 'log.teamProposed', {
    name: leader(g).name,
    members: unique.map((id) => playerById(g, id)!.name),
  });
}

/** @param {AvalonContext} g @param {string} playerId @param {boolean} approve */
export function castVote(g: AvalonContext, playerId: string, approve: boolean): void {
  require_(g.state.phase === 'vote', 'wrongPhase');
  require_(playerById(g, playerId), 'notInGame');
  require_(!(playerId in g.state.votes), 'alreadyVoted');
  g.state.votes[playerId] = Boolean(approve);
  if (Object.keys(g.state.votes).length === g.room.players.length) resolveVote(g);
}

/** @param {AvalonContext} g */
function resolveVote(g: AvalonContext): void {
  const approvals = g.room.players.filter((p) => g.state.votes[p.id]).length;
  const approved = approvals * 2 > g.room.players.length;
  g.state.lastVote = {
    round: g.state.round,
    attempt: g.state.rejects + 1,
    team: g.state.team.slice(),
    votes: { ...g.state.votes },
    approved,
  };
  logEvent(g, approved ? 'log.voteApproved' : 'log.voteRejected', {
    yes: approvals,
    no: g.room.players.length - approvals,
  });

  if (approved) {
    // With the switch off, rejections accumulate across quests until the fifth
    // hands evil the game. An approved team clears them only when requested.
    if (houseRulesOf(g).resetRejects) g.state.rejects = 0;
    g.state.cards = {};
    g.state.phase = 'quest';
    return;
  }

  g.state.rejects += 1;
  if (g.state.rejects >= MAX_REJECTS) {
    finish(g, 'evil', 'win.hammer');
    return;
  }
  nextLeader(g);
  g.state.team = [];
  g.state.phase = 'team';
  logEvent(g, 'log.leaderTurn', { name: leader(g).name, size: currentTeamSize(g) });
}

/** @param {AvalonContext} g */
function nextLeader(g: AvalonContext): void {
  g.state.leaderIndex = (g.state.leaderIndex + 1) % g.room.players.length;
}

/** @param {AvalonContext} g @param {string} playerId @param {boolean} success */
export function playCard(g: AvalonContext, playerId: string, success: boolean): void {
  require_(g.state.phase === 'quest', 'wrongPhase');
  require_(g.state.team.includes(playerId), 'notOnTeam');
  require_(!(playerId in g.state.cards), 'alreadyPlayed');
  const wantsFail = success === false;
  const role = g.state.roles[playerId];
  require_(role, 'notInGame');
  require_(!(wantsFail && sideOf(role) === 'good'), 'goodMustSucceed');
  g.state.cards[playerId] = !wantsFail;
  if (g.state.team.every((id) => id in g.state.cards)) resolveQuest(g);
}

/** @param {AvalonContext} g */
function resolveQuest(g: AvalonContext): void {
  const fails = g.state.team.filter((id) => g.state.cards[id] === false).length;
  const success = fails < currentFailsRequired(g);
  g.state.quests.push({ round: g.state.round, team: g.state.team.slice(), fails, success });
  logEvent(g, success ? 'log.questSucceeded' : 'log.questFailed', {
    round: g.state.round + 1,
    fails,
  });
  afterQuest(g);
}

/** Where a settled quest leaves the game. */
/** @param {AvalonContext} g */
function afterQuest(g: AvalonContext): void {
  const successes = g.state.quests.filter((q) => q.success).length;
  const failures = g.state.quests.length - successes;

  if (failures >= 3) return finish(g, 'evil', 'win.threeFails');
  if (successes >= 3) {
    g.state.phase = 'assassin';
    g.state.team = [];
    logEvent(g, 'log.assassinTurn', {});
    return;
  }

  g.state.round += 1;
  g.state.team = [];
  g.state.cards = {};
  nextLeader(g);
  g.state.phase = 'team';
  logEvent(g, 'log.leaderTurn', { name: leader(g).name, size: currentTeamSize(g) });
}

/**
 * The Assassin names anyone but themselves. Only Merlin is a hit — naming
 * another evil player is a legal, losing move, and has to stay legal: with
 * Oberon at the table the Assassin cannot tell him from a Loyal Servant, so
 * refusing the pick would answer that question for free and hand back the
 * shot.
 */
/** @param {AvalonContext} g @param {string} playerId @param {string} targetId */
export function assassinate(g: AvalonContext, playerId: string, targetId: string): void {
  require_(g.state.phase === 'assassin', 'wrongPhase');
  require_(g.state.roles[playerId] === 'assassin', 'assassinOnly');
  const target = playerById(g, targetId);
  require_(target, 'unknownMember');
  require_(targetId !== playerId, 'cannotTargetSelf');

  g.state.assassinTarget = targetId;
  const hit = g.state.roles[targetId] === 'merlin';
  logEvent(g, hit ? 'log.assassinHit' : 'log.assassinMiss', { name: target.name });
  finish(g, hit ? 'evil' : 'good', hit ? 'win.merlinSlain' : 'win.threeSuccesses');
}

/** @param {AvalonContext} g @param {'good' | 'evil'} winner @param {string} reason */
function finish(g: AvalonContext, winner: 'good' | 'evil', reason: string): void {
  g.state.phase = 'over';
  g.state.winner = winner;
  g.state.winReason = reason;
  logEvent(g, 'log.gameOver', { winner });
}

/** What this table agreed to before the cards came out, and keeps. */
/** @param {AvalonContext} g */
const lobbyKeeps = (g: AvalonContext): Partial<AvalonState> => ({
  options: g.state.options,
  optionsTouched: Boolean(g.state.optionsTouched),
  houseRules: houseRulesOf(g),
});

/** @param {AvalonContext} g @param {string} playerId @param {{ now?: () => number }} [options] */
export function resetToLobby(
  g: AvalonContext,
  playerId: string,
  { now = Date.now }: { now?: () => number } = {},
): void {
  lobby.resetToLobby(g, playerId, () => ({
    fresh: createGame(g.room.code, { now, seed: g.room.seed }),
    keep: lobbyKeeps(g),
  }));
}

/** @param {AvalonContext} g @param {string} playerId @param {{ now?: () => number }} [options] */
export function restartToLobby(
  g: AvalonContext,
  playerId: string,
  { now = Date.now }: { now?: () => number } = {},
): void {
  lobby.restartToLobby(g, playerId, () => ({
    fresh: createGame(g.room.code, { now, seed: g.room.seed }),
    keep: lobbyKeeps(g),
  }));
}

// ---------------------------------------------------------------- views

/**
 * What one player is allowed to see. Roles of others are only ever included
 * through `knowledge`, or once the game is over.
 * @param {AvalonContext} g
 * @param {string} viewerId
 * @returns {AvalonView}
 */
export function viewFor(g: AvalonContext, viewerId: string): AvalonView {
  const me = playerById(g, viewerId);
  const myRole = g.state.roles[viewerId] ?? null;
  const common = {
    ...lobby.baseView(g, viewerId),
    setup: {
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      options: OPTIONAL_ROLES.slice(),
      houseRules: HOUSE_RULE_KEYS.slice(),
    },
  };
  const you = me ? {
    id: me.id, name: me.name, avatar: me.avatar ?? null,
    role: myRole, side: myRole ? sideOf(myRole) : null,
  } : null;
  const players = g.room.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar ?? null,
      seat: i,
    }));

  if (g.state.phase === 'lobby') return {
    ...common, phase: 'lobby',
    you: me ? { id: me.id, name: me.name, avatar: me.avatar ?? null } : null,
    players,
    options: { ...liveOptions(g) },
    houseRules: houseRulesOf(g),
    deck: safeRoleCounts(g),
  };

  const inGame = {
    ...common, you,
    houseRules: houseRulesOf(g),
    roleCounts: countRoles(buildRoleList(g.room.players.length, g.state.options)),
    round: g.state.round,
    rejects: g.state.rejects,
    maxRejects: MAX_REJECTS,
    boardSizes: [0, 1, 2, 3, 4].map((r) => ({
      size: teamSize(g.room.players.length, r),
      twoFails: failsRequired(g.room.players.length, r) === 2,
    })),
    quests: g.state.quests.map((q) => ({
      round: q.round, success: q.success, fails: q.fails, team: q.team,
    })),
    // Under hidden votes the per-player ballot never leaves the server: the
    // table gets the tally, which is what decides the mission, and nothing
    // else. Withholding the whole field rather than emptying it keeps a client
    // that predates the rule from drawing everyone as a rejection.
    lastVote: houseRulesOf(g).hiddenVotes ? null : g.state.lastVote,
    voteTally: voteTally(g),
    knowledge: myRole ? knowledgeFor(viewerId, g.state.roles) : [],
    evilCount: evilPlayers(g).length,
  };

  const waiting = () => ({ waitingFor: waitingFor(g).map((p) => p.id) });
  if (g.state.phase === 'reveal') return {
    ...inGame, phase: 'reveal',
    players: players.map((p, i) => ({ ...p, isLeader: i === g.state.leaderIndex, ready: Boolean(g.state.ready?.[p.id]) })),
    ...waiting(),
  };
  if (g.state.phase === 'team') return {
    ...inGame, phase: 'team', team: g.state.team.slice(), teamSize: currentTeamSize(g),
    players: players.map((p, i) => ({ ...p, isLeader: i === g.state.leaderIndex, onTeam: g.state.team.includes(p.id) })),
    failsRequired: currentFailsRequired(g), ...waiting(),
  };
  if (g.state.phase === 'vote') return {
    ...inGame, phase: 'vote', team: g.state.team.slice(), teamSize: currentTeamSize(g), ...waiting(),
    players: players.map((p, i) => ({
      ...p, isLeader: i === g.state.leaderIndex, onTeam: g.state.team.includes(p.id), hasVoted: p.id in g.state.votes,
    })),
  };
  if (g.state.phase === 'quest') return {
    ...inGame, phase: 'quest', team: g.state.team.slice(), failsRequired: currentFailsRequired(g), ...waiting(),
    players: players.map((p, i) => ({
      ...p, isLeader: i === g.state.leaderIndex, onTeam: g.state.team.includes(p.id),
      ...(g.state.team.includes(p.id) ? { hasPlayed: p.id in g.state.cards } : {}),
    })),
  };
  if (g.state.phase === 'assassin') return {
    ...inGame, phase: 'assassin', assassinTarget: g.state.assassinTarget, ...waiting(),
    players: players.map((p, i) => ({ ...p, isLeader: i === g.state.leaderIndex })),
  };
  if (g.state.phase === 'over') return {
    ...inGame, phase: 'over',
    players: players.map((p, i) => ({ ...p, isLeader: i === g.state.leaderIndex, role: g.state.roles[p.id] })),
    assassinTarget: g.state.assassinTarget,
    winner: g.state.winner,
    winReason: g.state.winReason,
  };
  throw new Error(`unknown Avalon phase: ${g.state.phase}`);
}

/** @param {string[]} roles */
function countRoles(roles: AvalonRole[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const role of roles) counts[role] = (counts[role] ?? 0) + 1;
  return counts;
}

/** The lobby's deck, or nothing when this table cannot be dealt as asked. */
/** @param {AvalonContext} g */
function safeRoleCounts(g: AvalonContext): Record<string, number> | null {
  try {
    return countRoles(buildRoleList(g.room.players.length, liveOptions(g)));
  } catch {
    return null;
  }
}

/** How the last vote went, without saying who made it go that way. */
/** @param {AvalonContext} g */
function voteTally(g: AvalonContext) {
  if (!g.state.lastVote) return null;
  const ballots = Object.values(g.state.lastVote.votes);
  const yes = ballots.filter(Boolean).length;
  return {
    round: g.state.lastVote.round,
    attempt: g.state.lastVote.attempt,
    approved: g.state.lastVote.approved,
    yes,
    no: ballots.length - yes,
  };
}

/** @param {AvalonContext} g */
function waitingFor(g: AvalonContext): Player[] {
  switch (g.state.phase) {
    case 'reveal': return g.room.players.filter((p) => !g.state.ready?.[p.id]);
    case 'team':   return [leader(g)];
    case 'vote':   return g.room.players.filter((p) => !(p.id in g.state.votes));
    case 'quest':  return g.state.team
      .map((id) => playerById(g, id)!)
      .filter((p) => !(p.id in g.state.cards));
    case 'assassin': return g.room.players.filter((p) => g.state.roles[p.id] === 'assassin');
    default: return [];
  }
}
