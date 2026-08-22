// The Avalon state machine. Pure logic: it never touches the network, the
// clock (beyond timestamps) or randomness it was not handed.

import {
  GameError, MAX_PLAYERS, MAX_REJECTS, MIN_PLAYERS, OPTIONAL_ROLES,
  buildRoleList, failsRequired, knowledgeFor, sideOf, teamSize,
} from './rules.js';

export const PHASES = ['lobby', 'reveal', 'team', 'vote', 'quest', 'assassin', 'over'];

export function createGame(code, { now = Date.now } = {}) {
  return {
    code,
    createdAt: now(),
    phase: 'lobby',
    players: [],            // [{ id, name }] in seating order
    hostId: null,
    options: Object.fromEntries(OPTIONAL_ROLES.map((r) => [r, false])),
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
    log: [],
    version: 0,
  };
}

const playerById = (g, id) => g.players.find((p) => p.id === id);
const leader = (g) => g.players[g.leaderIndex];
const evilPlayers = (g) => g.players.filter((p) => sideOf(g.roles[p.id]) === 'evil');

function require_(cond, key, params) {
  if (!cond) throw new GameError(key, params);
}

function logEvent(g, key, params = {}) {
  g.log.push({ key, params, at: g.log.length });
}

// ---------------------------------------------------------------- lobby

export function addPlayer(g, { id, name }) {
  const existing = playerById(g, id);
  if (existing) {                       // reconnect keeps the seat and the role
    if (name && name !== existing.name) existing.name = name;
    return existing;
  }
  require_(g.phase === 'lobby', 'gameAlreadyStarted');
  require_(g.players.length < MAX_PLAYERS, 'roomFull', { max: MAX_PLAYERS });
  const clean = String(name ?? '').trim().slice(0, 24);
  require_(clean.length > 0, 'nameRequired');
  require_(!g.players.some((p) => p.name.toLowerCase() === clean.toLowerCase()), 'nameTaken');

  const player = { id, name: clean };
  g.players.push(player);
  if (!g.hostId) g.hostId = id;
  logEvent(g, 'log.joined', { name: clean });
  return player;
}

export function removePlayer(g, id) {
  require_(g.phase === 'lobby', 'cannotLeaveMidGame');
  const player = playerById(g, id);
  if (!player) return;
  g.players = g.players.filter((p) => p.id !== id);
  logEvent(g, 'log.left', { name: player.name });
  if (g.hostId === id) g.hostId = g.players[0]?.id ?? null;
}

export function setOptions(g, playerId, options) {
  require_(g.phase === 'lobby', 'gameAlreadyStarted');
  require_(playerId === g.hostId, 'hostOnly');
  for (const r of OPTIONAL_ROLES) {
    if (r in options) g.options[r] = Boolean(options[r]);
  }
}

export function startGame(g, playerId, { shuffle = defaultShuffle } = {}) {
  require_(g.phase === 'lobby', 'gameAlreadyStarted');
  require_(playerId === g.hostId, 'hostOnly');
  require_(g.players.length >= MIN_PLAYERS, 'needMorePlayers', { min: MIN_PLAYERS });

  const roleList = shuffle(buildRoleList(g.players.length, g.options));
  const seats = shuffle(g.players.slice());   // seating order is randomised too
  g.players = seats;
  g.roles = Object.fromEntries(seats.map((p, i) => [p.id, roleList[i]]));

  g.phase = 'reveal';
  g.ready = {};
  g.leaderIndex = Math.floor(Math.random() * g.players.length);
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
    g.rejects = 0;
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
  g.rejects = 0;
  g.team = [];
  g.cards = {};
  nextLeader(g);
  g.phase = 'team';
  logEvent(g, 'log.leaderTurn', { name: leader(g).name, size: currentTeamSize(g) });
}

export function assassinate(g, playerId, targetId) {
  require_(g.phase === 'assassin', 'wrongPhase');
  require_(g.roles[playerId] === 'assassin', 'assassinOnly');
  const target = playerById(g, targetId);
  require_(target, 'unknownMember');
  require_(sideOf(g.roles[targetId]) === 'good', 'targetMustBeGood');

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

/** Back to the lobby with the same people, ready for another game. */
export function resetToLobby(g, playerId) {
  require_(playerId === g.hostId, 'hostOnly');
  require_(g.phase === 'over', 'gameInProgress');
  const keep = { code: g.code, players: g.players, hostId: g.hostId, options: g.options };
  const fresh = createGame(g.code);
  Object.assign(g, fresh, keep, { version: g.version });
  logEvent(g, 'log.newGame', {});
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
    code: g.code,
    phase: g.phase,
    version: g.version,
    hostId: g.hostId,
    you: me ? { id: me.id, name: me.name, role: myRole, side: myRole ? sideOf(myRole) : null } : null,
    players: g.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      seat: i,
      isLeader: g.phase !== 'lobby' && i === g.leaderIndex,
      onTeam: g.team.includes(p.id),
      hasVoted: g.phase === 'vote' ? p.id in g.votes : undefined,
      hasPlayed: g.phase === 'quest' && g.team.includes(p.id) ? p.id in g.cards : undefined,
      ready: g.phase === 'reveal' ? Boolean(g.ready?.[p.id]) : undefined,
      role: revealAll ? g.roles[p.id] : undefined,
    })),
    options: { ...g.options },
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
    quests: g.quests.map((q) => ({ round: q.round, success: q.success, fails: q.fails, team: q.team })),
    lastVote: g.lastVote,
    knowledge: myRole ? knowledgeFor(viewerId, g.roles) : [],
    assassinTarget: g.assassinTarget,
    winner: g.winner,
    winReason: g.winReason,
    log: g.log.slice(-40),
    // Everything below is "what am I waiting on" for the UI.
    waitingFor: waitingFor(g).map((p) => p.id),
    evilCount: g.phase === 'lobby' ? null : evilPlayers(g).length,
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

export function defaultShuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
