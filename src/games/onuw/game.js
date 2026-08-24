// One Night Ultimate Werewolf.
//
// The night runs on a clock, exactly as the physical game's app does: a fixed
// script of role steps, each with a fixed duration, the same for everybody.
//
// Two properties matter and both come from that being *fixed*:
//
//  - Every waking role is called whether or not it is in the deck. Skipping
//    the absent ones would let the table read the deck off the announcements.
//  - A step never ends early, even once the acting player has chosen. Ending
//    early would broadcast that the role was in play and had finished.
//
// So no view ever says who is awake, who has acted, or who is being waited
// on. Everyone sees the same countdown and hears the same announcement; only
// the player whose card matches the current step gets any controls.
//
// The Doppelgänger is deliberately absent: it copies a role and then acts as
// it, a choice that genuinely depends on night information, and it is the one
// role this model cannot represent honestly.

import {
  DEFAULT_PACE, MAX_PLAYERS, MIN_PLAYERS, OPTIONAL_ROLES, PACES, ROLES,
  buildDeck, decideWinners, defaultOptions, nightLength, nightScript, roomForOptions,
  stepMillis, tallyVotes, teamOf,
} from './rules.js';
import * as lobby from '../../lobby.js';
import { defaultShuffle, logEvent, playerById, require_ } from '../../lobby.js';

export const PHASES = ['lobby', 'reveal', 'night', 'day', 'vote', 'over'];

export function createGame(code, { now = Date.now } = {}) {
  return {
    ...lobby.baseState(code, 'onuw', { now }),
    options: Object.fromEntries(OPTIONAL_ROLES.map((r) => [r, false])),
    optionsTouched: false,   // until the host picks, follow the table size
    pace: DEFAULT_PACE,
    script: [],              // this deck's night, decided when the cards are dealt
    step: -1,                // index into script
    stepEndsAt: 0,           // ms timestamp; the same deadline for everyone
    ready: {},               // playerId -> confirmed they have read their role
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
  if (options.pace !== undefined) {
    require_(options.pace in PACES, 'badPace');
    g.pace = options.pace;
  }
  const next = { ...liveOptions(g) };
  for (const role of OPTIONAL_ROLES) if (role in options) next[role] = Boolean(options[role]);
  buildDeck(g.players.length, next);   // throws before anything is committed
  g.options = next;
  g.optionsTouched = true;
}

export function startGame(g, playerId, { shuffle = defaultShuffle, now = Date.now } = {}) {
  require_(g.phase === 'lobby', 'gameAlreadyStarted');
  require_(playerId === g.hostId, 'hostOnly');
  require_(g.players.length >= MIN_PLAYERS, 'needMorePlayers', { min: MIN_PLAYERS });

  const deck = shuffle(buildDeck(g.players.length, liveOptions(g)));
  g.options = liveOptions(g);
  g.players = shuffle(g.players.slice());
  g.startRoles = Object.fromEntries(g.players.map((p, i) => [p.id, deck[i]]));
  g.centreStart = deck.slice(g.players.length);

  // The night mutates these as each step closes.
  g.finalRoles = { ...g.startRoles };
  g.centre = g.centreStart.slice();

  g.script = nightScript(deck);
  g.phase = 'reveal';
  g.ready = {};
  g.step = -1;
  g.stepEndsAt = 0;
  logEvent(g, 'log.gameStarted', { count: g.players.length });
}

/** Every player gets time to inspect their card before the shared clock begins. */
export function confirmRole(g, playerId, { now = Date.now } = {}) {
  require_(g.phase === 'reveal', 'wrongPhase');
  require_(playerById(g, playerId), 'notInGame');
  g.ready[playerId] = true;
  if (!g.players.every((p) => g.ready[p.id])) return;

  g.phase = 'night';
  g.step = 0;
  g.stepEndsAt = now() + stepMillis(g.script[0], g.pace);
  openStep(g);
}

// ---------------------------------------------------------------- the night

const wolvesAmongPlayers = (g) => g.players.filter((p) => g.startRoles[p.id] === 'werewolf');

export const currentStep = (g) => (g.phase === 'night' ? g.script[g.step] ?? null : null);

/** What this player must decide during their role's step, if anything. */
export function actionFor(g, playerId) {
  const role = g.startRoles[playerId];
  const kind = ROLES[role]?.acts;
  if (!kind) return null;
  if (kind === 'loneWolf') return wolvesAmongPlayers(g).length === 1 ? 'loneWolf' : null;
  return kind;
}

/** Is it this player's turn to be awake right now? */
export function isAwake(g, playerId) {
  const step = currentStep(g);
  return Boolean(step?.role && g.startRoles[playerId] === step.role);
}

/**
 * What a player learns simply by being woken — their packmates, the other
 * Mason, who the werewolves are. Shown during their own step, and repeated in
 * the morning.
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
  require_(isAwake(g, playerId), 'notYourTurn');
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

  // Resolve now, so the player sees what they looked at or took while they are
  // still awake. Order is safe: only this role acts during this step.
  resolve(g, playerId, g.actions[playerId]);
  // Deliberately no early advance: the clock is the same for everyone.
}

/** When the room layer should look in on this game again. */
export const nextDeadline = (g) => (g.phase === 'night' ? g.stepEndsAt : null);

/**
 * Advance the night if its clock has run out. Loops, so a server that was
 * busy for a while catches up rather than drifting.
 */
export function tick(g, now = Date.now()) {
  if (g.phase !== 'night') return false;
  let moved = false;
  while (g.phase === 'night' && now >= g.stepEndsAt) {
    closeStep(g);
    g.step += 1;
    moved = true;
    if (g.step >= g.script.length) { dawn(g); break; }
    g.stepEndsAt += stepMillis(g.script[g.step], g.pace);
    openStep(g);
  }
  return moved;
}

const addInfo = (g, id, key, params = {}) => { (g.info[id] ??= []).push({ key, params }); };

const actorsFor = (g, role) => g.players.filter((p) => g.startRoles[p.id] === role);

/**
 * Entering a step. Everything that needs no decision happens the moment the
 * role opens its eyes: who your packmates are, what the Insomniac is holding.
 */
function openStep(g) {
  const step = currentStep(g);
  if (!step?.role) return;
  for (const p of actorsFor(g, step.role)) {
    for (const k of staticKnowledge(g, p.id)) addInfo(g, p.id, k.key, k.params);
    if (step.role === 'insomniac') addInfo(g, p.id, 'onuw.info.insomniac', { role: g.finalRoles[p.id] });
  }
}

/** Tests deal their own cards, then re-open the opening step. */
export const openStepForTests = openStep;

/** Apply one player's choice. Called as soon as they make it. */
function resolve(g, playerId, a) {
  const roles = g.finalRoles;
  const centre = g.centre;
  const role = g.startRoles[playerId];
  const me = playerById(g, playerId);

  if (role === 'werewolf') {
    if (Number.isInteger(a.centre)) {
      addInfo(g, playerId, 'onuw.info.sawCentre', { index: a.centre + 1, role: centre[a.centre] });
    }
  } else if (role === 'seer') {
    if (a.mode === 'player') addInfo(g, playerId, 'onuw.info.sawPlayer', { name: nameOf(g, a.target), role: roles[a.target] });
    else if (a.mode === 'centre') {
      addInfo(g, playerId, 'onuw.info.sawTwoCentre', {
        a: a.centres[0] + 1, roleA: centre[a.centres[0]],
        b: a.centres[1] + 1, roleB: centre[a.centres[1]],
      });
    } else addInfo(g, playerId, 'onuw.info.lookedAtNothing');
  } else if (role === 'robber') {
    if (a.target) {
      const taken = roles[a.target];
      roles[a.target] = roles[playerId];
      roles[playerId] = taken;
      addInfo(g, playerId, 'onuw.info.robbed', { name: nameOf(g, a.target), role: taken });
      g.swaps.push({ key: 'onuw.swap.robber', params: { a: me.name, b: nameOf(g, a.target) } });
    } else addInfo(g, playerId, 'onuw.info.robbedNobody');
  } else if (role === 'troublemaker') {
    if (a.targets) {
      const [x, y] = a.targets;
      [roles[x], roles[y]] = [roles[y], roles[x]];
      addInfo(g, playerId, 'onuw.info.swapped', { a: nameOf(g, x), b: nameOf(g, y) });
      g.swaps.push({ key: 'onuw.swap.troublemaker', params: { a: nameOf(g, x), b: nameOf(g, y) } });
    } else addInfo(g, playerId, 'onuw.info.swappedNobody');
  } else if (role === 'drunk') {
    const i = a.centre;
    [roles[playerId], centre[i]] = [centre[i], roles[playerId]];
    addInfo(g, playerId, 'onuw.info.drunk', { index: i + 1 });
    g.swaps.push({ key: 'onuw.swap.drunk', params: { a: me.name, index: i + 1 } });
  }
}

/** Leaving a step: whoever let the clock run out gets the default outcome. */
function closeStep(g) {
  const step = currentStep(g);
  if (!step?.role) return;
  for (const p of actorsFor(g, step.role)) {
    if (p.id in g.actions) continue;
    if (!actionFor(g, p.id)) continue;
    // The Drunk always swaps, even asleep at the wheel — with a card nobody
    // could have predicted.
    const fallback = step.role === 'drunk'
      ? { centre: Math.floor(Math.random() * g.centre.length) }
      : { skip: true };
    g.actions[p.id] = fallback;
    resolve(g, p.id, fallback);
  }
}

function dawn(g) {
  g.phase = 'day';
  g.step = g.script.length;
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

function rebuildLobby(g) {
  const keep = {
    code: g.code, players: g.players, hostId: g.hostId,
    options: g.options, optionsTouched: g.optionsTouched, pace: g.pace,
  };
  const fresh = createGame(g.code);
  Object.assign(g, fresh, keep, { version: g.version });
  logEvent(g, 'log.newGame', {});
}

export function resetToLobby(g, playerId) {
  require_(playerId === g.hostId, 'hostOnly');
  require_(g.phase === 'over', 'gameInProgress');
  rebuildLobby(g);
}

/** Let the host abandon an active game and immediately return to its lobby. */
export function restartToLobby(g, playerId) {
  require_(playerId === g.hostId, 'hostOnly');
  require_(g.phase !== 'lobby' && g.phase !== 'over', 'wrongPhase');
  rebuildLobby(g);
}

// ---------------------------------------------------------------- views

export function viewFor(g, viewerId, now = Date.now()) {
  const me = playerById(g, viewerId);
  const over = g.phase === 'over';
  const night = g.phase === 'night';
  const startRole = g.startRoles[viewerId] ?? null;
  const step = currentStep(g);
  const awake = night && isAwake(g, viewerId);
  // Readiness is public before night begins. During the night, nobody is
  // waited on by name — see the note at the top of this file.
  const waiting = g.phase === 'reveal'
    ? g.players.filter((p) => !g.ready[p.id])
    : g.phase === 'vote' ? g.players.filter((p) => !(p.id in g.votes)) : [];

  return {
    ...lobby.baseView(g, viewerId),
    you: me ? {
      id: me.id, name: me.name,
      role: startRole,
      team: startRole ? teamOf(startRole) : null,
      finalRole: over ? g.finalRoles[viewerId] : undefined,
      awake,
      action: awake ? actionFor(g, viewerId) : null,
      acted: viewerId in g.actions,
      voted: viewerId in g.votes,
    } : null,
    players: g.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      seat: i,
      ready: g.phase === 'reveal' ? Boolean(g.ready[p.id]) : undefined,
      // No `acted` at night: it would be false only for players holding an
      // action role, which is the deck read straight off the screen.
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
    // The same clock for every player, so the countdown can never be read as
    // a signal about who is doing what.
    night: night && step ? {
      index: g.step,
      total: g.script.length,
      key: step.key,
      msLeft: Math.max(0, g.stepEndsAt - now),
      msTotal: stepMillis(step, g.pace),
    } : null,
    pace: g.pace,
    nightScript: (g.script.length ? g.script : lobbyScript(g)).map((entry) => entry.key),
    nightSeconds: nightLength(g.script.length ? scriptDeck(g) : lobbyDeck(g), g.pace) / 1000,
    // Only ever this player's own findings, and only once they have them.
    info: g.info[viewerId] ?? [],
    swaps: over ? g.swaps : [],
    votes: over ? { ...g.votes } : {},
    dead: over ? g.dead : [],
    winners: over ? g.winners : [],
    youWon: over && me ? g.winners.includes(teamOf(g.finalRoles[viewerId])) : undefined,
    waitingFor: waiting.map((p) => p.id),
  };
}

/** The deck this game was dealt from, for describing its night. */
const scriptDeck = (g) => [...Object.values(g.startRoles), ...g.centreStart];
const lobbyDeck = (g) => safeDeckList(g) ?? [];
const lobbyScript = (g) => nightScript(lobbyDeck(g));

function safeDeckList(g) {
  try {
    return buildDeck(g.players.length, liveOptions(g));
  } catch {
    return null;
  }
}

/** The lobby shows the deck; an impossible choice shows as no deck at all. */
function safeDeck(g) {
  const deck = safeDeckList(g);
  return deck ? countRoles(deck) : null;
}

function countRoles(list) {
  const counts = {};
  for (const role of list) counts[role] = (counts[role] ?? 0) + 1;
  return counts;
}
