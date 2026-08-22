// One Night Ultimate Werewolf.
//
// The night is the whole game, and online it is the awkward part: waking one
// role at a time means eight people watching one person think. So every night
// action is submitted at once and then resolved in the canonical wake order.
// That is not a simplification — no role's *choice* depends on anything
// learned during the night, only its *result* does, and results are computed
// in order. The one exception is the lone werewolf, who must know they are
// alone before deciding whether to peek at a centre card; that follows from
// the starting deal, so their view can say so up front.
//
// The Doppelgänger is deliberately absent: it copies a role and then acts as
// it, a choice that genuinely depends on night information, and it is the one
// role this model cannot represent honestly.

import {
  MAX_PLAYERS, MIN_PLAYERS, NIGHT_ORDER, OPTIONAL_ROLES, ROLES,
  buildDeck, decideWinners, defaultOptions, roomForOptions, tallyVotes, teamOf,
} from './rules.js';
import * as lobby from '../../lobby.js';
import { defaultShuffle, logEvent, playerById, require_ } from '../../lobby.js';

export const PHASES = ['lobby', 'night', 'day', 'vote', 'over'];

export function createGame(code, { now = Date.now } = {}) {
  return {
    ...lobby.baseState(code, 'onuw', { now }),
    options: Object.fromEntries(OPTIONAL_ROLES.map((r) => [r, false])),
    optionsTouched: false,   // until the host picks, follow the table size
    startRoles: {},          // playerId -> the card dealt to them
    centreStart: [],         // the three cards nobody was dealt
    finalRoles: {},          // after the night's swaps
    centre: [],
    actions: {},             // playerId -> what they chose to do
    info: {},                // playerId -> private results, as i18n keys
    swaps: [],               // public at the end: what moved, not who saw what
    votes: {},               // playerId -> who they pointed at
    dead: [],
    winners: [],
  };
}

export const addPlayer = (g, player) => lobby.addPlayer(g, player, { maxPlayers: MAX_PLAYERS });
export const removePlayer = lobby.removePlayer;

const nameOf = (g, id) => playerById(g, id)?.name ?? '?';
/** The deck the lobby is currently describing. */
const liveOptions = (g) => (g.optionsTouched ? g.options : defaultOptions(g.players.length));

export function setOptions(g, playerId, options) {
  require_(g.phase === 'lobby', 'gameAlreadyStarted');
  require_(playerId === g.hostId, 'hostOnly');
  const next = { ...liveOptions(g) };
  for (const role of OPTIONAL_ROLES) if (role in options) next[role] = Boolean(options[role]);
  buildDeck(g.players.length, next);   // throws before anything is committed
  g.options = next;
  g.optionsTouched = true;
}

export function startGame(g, playerId, { shuffle = defaultShuffle } = {}) {
  require_(g.phase === 'lobby', 'gameAlreadyStarted');
  require_(playerId === g.hostId, 'hostOnly');
  require_(g.players.length >= MIN_PLAYERS, 'needMorePlayers', { min: MIN_PLAYERS });

  const deck = shuffle(buildDeck(g.players.length, liveOptions(g)));
  g.options = liveOptions(g);
  g.players = shuffle(g.players.slice());
  g.startRoles = Object.fromEntries(g.players.map((p, i) => [p.id, deck[i]]));
  g.centreStart = deck.slice(g.players.length);
  g.phase = 'night';
  logEvent(g, 'log.gameStarted', { count: g.players.length });

  // Every actor's card can be in the centre, in which case the night is over
  // before it starts.
  if (pendingActors(g).length === 0) resolveNight(g);
}

// ---------------------------------------------------------------- the night

const wolvesAmongPlayers = (g) => g.players.filter((p) => g.startRoles[p.id] === 'werewolf');

/** What this player must decide tonight, if anything. */
export function actionFor(g, playerId) {
  const role = g.startRoles[playerId];
  const kind = ROLES[role]?.acts;
  if (!kind) return null;
  if (kind === 'loneWolf') return wolvesAmongPlayers(g).length === 1 ? 'loneWolf' : null;
  return kind;
}

export const pendingActors = (g) =>
  g.players.filter((p) => actionFor(g, p.id) && !(p.id in g.actions));

/**
 * What a player knows the moment the cards are dealt — who their packmates
 * are, and so on. Available during the night, and repeated in the morning.
 */
export function staticKnowledge(g, playerId) {
  const role = g.startRoles[playerId];
  const others = (test) => g.players.filter((p) => p.id !== playerId && test(p)).map((p) => p.name);
  const out = [];

  if (role === 'werewolf') {
    const pack = others((p) => g.startRoles[p.id] === 'werewolf');
    out.push(pack.length
      ? { key: 'onuw.info.packmates', params: { names: pack } }
      : { key: 'onuw.info.loneWolf', params: {} });
  } else if (role === 'minion') {
    const wolves = g.players.filter((p) => g.startRoles[p.id] === 'werewolf').map((p) => p.name);
    out.push(wolves.length
      ? { key: 'onuw.info.minionSees', params: { names: wolves } }
      : { key: 'onuw.info.minionAlone', params: {} });
  } else if (role === 'mason') {
    const masons = others((p) => g.startRoles[p.id] === 'mason');
    out.push(masons.length
      ? { key: 'onuw.info.masons', params: { names: masons } }
      : { key: 'onuw.info.masonAlone', params: {} });
  }
  return out;
}

export function submitNight(g, playerId, action = {}) {
  require_(g.phase === 'night', 'wrongPhase');
  require_(playerById(g, playerId), 'notInGame');
  const kind = actionFor(g, playerId);
  require_(kind, 'noNightAction');
  require_(!(playerId in g.actions), 'alreadyActed');

  const known = (id) => Boolean(playerById(g, id));
  const centreIndex = (i) => Number.isInteger(i) && i >= 0 && i < g.centreStart.length;

  if (action.skip) {
    require_(kind !== 'drunk', 'drunkMustSwap');   // the Drunk has no choice
    g.actions[playerId] = { skip: true };
  } else if (kind === 'loneWolf') {
    require_(centreIndex(action.centre), 'badCentreCard');
    g.actions[playerId] = { centre: action.centre };
  } else if (kind === 'seer') {
    if (action.mode === 'player') {
      require_(known(action.target) && action.target !== playerId, 'badTarget');
      g.actions[playerId] = { mode: 'player', target: action.target };
    } else {
      const [a, b] = action.centres ?? [];
      require_(centreIndex(a) && centreIndex(b) && a !== b, 'badCentreCard');
      g.actions[playerId] = { mode: 'centre', centres: [a, b] };
    }
  } else if (kind === 'robber') {
    require_(known(action.target) && action.target !== playerId, 'badTarget');
    g.actions[playerId] = { target: action.target };
  } else if (kind === 'troublemaker') {
    const [a, b] = action.targets ?? [];
    require_(known(a) && known(b) && a !== b, 'badTarget');
    require_(a !== playerId && b !== playerId, 'troublemakerNotSelf');
    g.actions[playerId] = { targets: [a, b] };
  } else if (kind === 'drunk') {
    require_(centreIndex(action.centre), 'badCentreCard');
    g.actions[playerId] = { centre: action.centre };
  }

  if (pendingActors(g).length === 0) resolveNight(g);
}

/** Apply the night in wake order. The order is the whole point. */
function resolveNight(g) {
  const roles = { ...g.startRoles };
  const centre = g.centreStart.slice();
  const info = {};
  const add = (id, key, params = {}) => { (info[id] ??= []).push({ key, params }); };

  for (const p of g.players) for (const k of staticKnowledge(g, p.id)) add(p.id, k.key, k.params);

  for (const role of NIGHT_ORDER) {
    for (const p of g.players.filter((q) => g.startRoles[q.id] === role)) {
      const a = g.actions[p.id] ?? {};
      if (role === 'werewolf') {
        if (Number.isInteger(a.centre)) {
          add(p.id, 'onuw.info.sawCentre', { index: a.centre + 1, role: centre[a.centre] });
        }
      } else if (role === 'seer') {
        if (a.mode === 'player') add(p.id, 'onuw.info.sawPlayer', { name: nameOf(g, a.target), role: roles[a.target] });
        else if (a.mode === 'centre') {
          add(p.id, 'onuw.info.sawTwoCentre', {
            a: a.centres[0] + 1, roleA: centre[a.centres[0]],
            b: a.centres[1] + 1, roleB: centre[a.centres[1]],
          });
        } else add(p.id, 'onuw.info.lookedAtNothing');
      } else if (role === 'robber') {
        if (a.target) {
          const taken = roles[a.target];
          roles[a.target] = roles[p.id];
          roles[p.id] = taken;
          add(p.id, 'onuw.info.robbed', { name: nameOf(g, a.target), role: taken });
          g.swaps.push({ key: 'onuw.swap.robber', params: { a: p.name, b: nameOf(g, a.target) } });
        } else add(p.id, 'onuw.info.robbedNobody');
      } else if (role === 'troublemaker') {
        if (a.targets) {
          const [x, y] = a.targets;
          [roles[x], roles[y]] = [roles[y], roles[x]];
          add(p.id, 'onuw.info.swapped', { a: nameOf(g, x), b: nameOf(g, y) });
          g.swaps.push({ key: 'onuw.swap.troublemaker', params: { a: nameOf(g, x), b: nameOf(g, y) } });
        } else add(p.id, 'onuw.info.swappedNobody');
      } else if (role === 'drunk') {
        const i = a.centre;
        [roles[p.id], centre[i]] = [centre[i], roles[p.id]];
        add(p.id, 'onuw.info.drunk', { index: i + 1 });
        g.swaps.push({ key: 'onuw.swap.drunk', params: { a: p.name, index: i + 1 } });
      } else if (role === 'insomniac') {
        add(p.id, 'onuw.info.insomniac', { role: roles[p.id] });
      }
    }
  }

  g.finalRoles = roles;
  g.centre = centre;
  g.info = info;
  g.phase = 'day';
  logEvent(g, 'log.dawn', {});
}

// ---------------------------------------------------------------- the day

export function startVote(g, playerId) {
  require_(g.phase === 'day', 'wrongPhase');
  require_(playerId === g.hostId, 'hostOnly');
  g.phase = 'vote';
  logEvent(g, 'log.voteStarted', {});
}

export function castVote(g, playerId, targetId) {
  require_(g.phase === 'vote', 'wrongPhase');
  require_(playerById(g, playerId), 'notInGame');
  require_(playerById(g, targetId), 'unknownMember');
  require_(targetId !== playerId, 'cannotVoteSelf');
  require_(!(playerId in g.votes), 'alreadyVoted');
  g.votes[playerId] = targetId;
  if (Object.keys(g.votes).length === g.players.length) resolveVote(g);
}

function resolveVote(g) {
  const ids = g.players.map((p) => p.id);
  const { dead } = tallyVotes(ids, g.votes);

  // The Hunter takes whoever they pointed at down with them.
  for (const id of [...dead]) {
    if (g.finalRoles[id] === 'hunter' && g.votes[id]) {
      if (!dead.has(g.votes[id])) {
        dead.add(g.votes[id]);
        logEvent(g, 'log.hunterFires', { name: nameOf(g, id), target: nameOf(g, g.votes[id]) });
      }
    }
  }

  g.dead = [...dead];
  g.winners = [...decideWinners(g.finalRoles, dead)];
  g.phase = 'over';
  logEvent(g, dead.size ? 'log.executed' : 'log.nobodyDied',
    { names: g.dead.map((id) => nameOf(g, id)) });
  logEvent(g, 'log.gameOver', { winner: g.winners[0] ?? 'nobody' });
}

export function resetToLobby(g, playerId) {
  require_(playerId === g.hostId, 'hostOnly');
  require_(g.phase === 'over', 'gameInProgress');
  const keep = {
    code: g.code, players: g.players, hostId: g.hostId,
    options: g.options, optionsTouched: g.optionsTouched,
  };
  const fresh = createGame(g.code);
  Object.assign(g, fresh, keep, { version: g.version });
  logEvent(g, 'log.newGame', {});
}

// ---------------------------------------------------------------- views

export function viewFor(g, viewerId) {
  const me = playerById(g, viewerId);
  const over = g.phase === 'over';
  const startRole = g.startRoles[viewerId] ?? null;
  const waiting = g.phase === 'night' ? pendingActors(g)
    : g.phase === 'vote' ? g.players.filter((p) => !(p.id in g.votes))
    : [];

  return {
    ...lobby.baseView(g, viewerId),
    you: me ? {
      id: me.id, name: me.name,
      role: startRole,
      team: startRole ? teamOf(startRole) : null,
      finalRole: over ? g.finalRoles[viewerId] : undefined,
      action: g.phase === 'night' ? actionFor(g, viewerId) : null,
      acted: viewerId in g.actions,
      voted: viewerId in g.votes,
    } : null,
    players: g.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      seat: i,
      acted: g.phase === 'night' ? p.id in g.actions || !actionFor(g, p.id) : undefined,
      voted: g.phase === 'vote' ? p.id in g.votes : undefined,
      votedFor: over ? g.votes[p.id] ?? null : undefined,
      dead: over ? g.dead.includes(p.id) : undefined,
      startRole: over ? g.startRoles[p.id] : undefined,
      finalRole: over ? g.finalRoles[p.id] : undefined,
    })),
    options: { ...liveOptions(g) },
    optionRoom: roomForOptions(g.players.length),
    deck: g.phase === 'lobby'
      ? safeDeck(g)
      : countRoles([...Object.values(g.startRoles), ...g.centreStart]),
    centreCount: g.centreStart.length || 3,
    // Never the contents — only how many face-down cards are on the table.
    centre: over ? g.centre : null,
    centreStart: over ? g.centreStart : null,
    knowledge: g.phase === 'night' && startRole ? staticKnowledge(g, viewerId) : [],
    info: g.phase === 'night' ? [] : (g.info[viewerId] ?? []),
    swaps: over ? g.swaps : [],
    votes: over ? { ...g.votes } : {},
    dead: over ? g.dead : [],
    winners: over ? g.winners : [],
    youWon: over && me ? g.winners.includes(teamOf(g.finalRoles[viewerId])) : undefined,
    waitingFor: waiting.map((p) => p.id),
  };
}

/** The lobby shows the deck; an impossible choice shows as no deck at all. */
function safeDeck(g) {
  try {
    return countRoles(buildDeck(g.players.length, liveOptions(g)));
  } catch {
    return null;
  }
}

function countRoles(list) {
  const counts = {};
  for (const role of list) counts[role] = (counts[role] ?? 0) + 1;
  return counts;
}
