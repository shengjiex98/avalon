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

// @ts-check

import {
  DEFAULT_PACE, HOUSE_RULES, HOUSE_RULE_KEYS, MAX_PLAYERS, MIN_PLAYERS, OPTIONAL_ROLES,
  PACES, ROLES, buildDeck, decideWinners, defaultOptions, nightLength, nightScript,
  roomForOptions, stepMillis, tallyVotes, teamOf,
} from './rules.js';
import * as lobby from '../../lobby.js';
import { logEvent, playerById, randInt, require_, shuffleWith } from '../../lobby.js';

/** @typedef {import('../../../types/contracts.js').OnuwContext} OnuwContext */
/** @typedef {import('../../../types/contracts.js').OnuwNightAction} OnuwNightAction */
/** @typedef {import('../../../types/contracts.js').OnuwView} OnuwView */

/** @param {string} code @param {{ now?: () => number, seed?: number }} [options] @returns {OnuwContext} */
export function createGame(code, { now = Date.now, seed } = {}) {
  return /** @type {OnuwContext} */ ({
    ...lobby.baseState(code, 'onuw', { now, ...(seed === undefined ? {} : { seed }) }),
    options: Object.fromEntries(OPTIONAL_ROLES.map((r) => [r, false])),
    optionsTouched: false,   // until the host picks, follow the table size
    houseRules: { ...HOUSE_RULES },    // variants, as a new table plays them
    pace: DEFAULT_PACE,
    script: [],              // this deck's night, decided when the cards are dealt
    step: -1,                // index into script
    stepEndsAt: 0,           // ms timestamp; the same deadline for everyone
    ready: {},               // playerId -> confirmed they have read their role
    startRoles: {},          // playerId -> the card dealt to them
    centreStart: [],         // the three cards nobody was dealt
    finalRoles: {},          // after the night's swaps
    centre: [],
    nightActions: {},        // playerId -> what they chose to do
    info: {},                // playerId -> private results, as i18n keys
    swaps: [],               // public at the end: what moved, not who saw what
    votes: {},               // playerId -> who they pointed at
    dead: [],
    winners: [],
  });
}

/** @param {OnuwContext} g @param {{ id: string, name?: string, avatar?: string }} player */
export const addPlayer = (g, player) => lobby.addPlayer(g, player, { maxPlayers: MAX_PLAYERS });
/** @param {OnuwContext} g @param {string} playerId */
export const removePlayer = (g, playerId) => lobby.removePlayer(g, playerId);

/** @param {OnuwContext} g @param {string} id */
const nameOf = (g, id) => playerById(g, id)?.name ?? '?';
/** The deck the lobby is currently describing. */
/** @param {OnuwContext} g */
const liveOptions = (g) => (g.optionsTouched ? g.options : defaultOptions(g.players.length));

/** @param {OnuwContext} g */
const houseRulesOf = (g) => lobby.houseRulesInForce(g, HOUSE_RULE_KEYS);

/** @param {OnuwContext} g @param {string} playerId @param {Record<string, any>} options */
export function setOptions(g, playerId, options) {
  require_(g.phase === 'lobby', 'gameAlreadyStarted');
  require_(playerId === g.hostId, 'hostOnly');
  if (options.pace !== undefined) {
    require_(options.pace in PACES, 'badPace');
    g.pace = options.pace;
  }
  if (options.houseRules) lobby.setHouseRules(g, options.houseRules, HOUSE_RULE_KEYS);
  /** @type {Record<string, boolean>} */
  const next = { ...liveOptions(g) };
  for (const role of OPTIONAL_ROLES) if (role in options) next[role] = Boolean(options[role]);
  buildDeck(g.players.length, next);   // throws before anything is committed
  g.options = next;
  g.optionsTouched = true;
}

/** @param {OnuwContext} g @param {string} playerId @param {{ shuffle?: <T>(list: T[]) => T[], now?: () => number }} [options] */
export function startGame(g, playerId, { shuffle = (list) => shuffleWith(g, list), now = Date.now } = {}) {
  require_(g.phase === 'lobby', 'gameAlreadyStarted');
  require_(playerId === g.hostId, 'hostOnly');
  require_(g.players.length >= MIN_PLAYERS, 'needMorePlayers', { min: MIN_PLAYERS });

  const deck = shuffle(buildDeck(g.players.length, liveOptions(g)));
  g.options = liveOptions(g);
  g.players = shuffle(g.players.slice());
  g.startRoles = Object.fromEntries(g.players.map((p, i) => [p.id, /** @type {string} */ (deck[i])]));
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
/** @param {OnuwContext} g @param {string} playerId @param {{ now?: () => number }} [options] */
export function confirmRole(g, playerId, { now = Date.now } = {}) {
  require_(g.phase === 'reveal', 'wrongPhase');
  require_(playerById(g, playerId), 'notInGame');
  g.ready[playerId] = true;
  if (!g.players.every((p) => g.ready[p.id])) return;

  g.phase = 'night';
  g.step = 0;
  g.stepEndsAt = now() + stepMillis(/** @type {import('../../../types/contracts.js').OnuwScriptStep} */ (g.script[0]), g.pace);
  openStep(g);
}

// ---------------------------------------------------------------- the night

/** @param {OnuwContext} g */
const wolvesAmongPlayers = (g) => g.players.filter((p) => g.startRoles[p.id] === 'werewolf');

/** @param {OnuwContext} g */
export const currentStep = (g) => (g.phase === 'night' ? g.script[g.step] ?? null : null);

/** What this player must decide during their role's step, if anything. */
/** @param {OnuwContext} g @param {string} playerId */
export function actionFor(g, playerId) {
  const role = /** @type {string} */ (g.startRoles[playerId]);
  const kind = /** @type {Record<string, { acts?: string }>} */ (ROLES)[role]?.acts;
  if (!kind) return null;
  if (kind === 'loneWolf') return wolvesAmongPlayers(g).length === 1 ? 'loneWolf' : null;
  return kind;
}

/** Is it this player's turn to be awake right now? */
/** @param {OnuwContext} g @param {string} playerId */
export function isAwake(g, playerId) {
  const step = currentStep(g);
  return Boolean(step?.role && g.startRoles[playerId] === step.role);
}

/**
 * What a player learns simply by being woken — their packmates, the other
 * Mason, who the werewolves are. Shown during their own step, and repeated in
 * the morning.
 * @param {OnuwContext} g
 * @param {string} playerId
 */
export function staticKnowledge(g, playerId) {
  const role = g.startRoles[playerId];
  /** @param {(player: import('../../../types/contracts.js').Player) => boolean} test */
  const others = (test) => g.players.filter((p) => p.id !== playerId && test(p)).map((p) => p.name);
  const out = [];

  if (role === 'werewolf') {
    const pack = others((p) => g.startRoles[p.id] === 'werewolf');
    out.push(pack.length
      ? { key: 'onuw.info.packmates', params: { names: pack } }
      : { key: 'onuw.info.loneWolf', params: {} });
  } else if (role === 'minion') {
    const wolves = g.players.filter((p) => g.startRoles[p.id] === 'werewolf').map((p) => p.name);
    // A decisive vote makes a pack of one out of a Minion with nobody to serve,
    // so he is told: the hunt is for him now.
    const alone = houseRulesOf(g).decisiveVote ? 'onuw.info.minionIsPack' : 'onuw.info.minionAlone';
    out.push(wolves.length
      ? { key: 'onuw.info.minionSees', params: { names: wolves } }
      : { key: alone, params: {} });
  } else if (role === 'mason') {
    const masons = others((p) => g.startRoles[p.id] === 'mason');
    out.push(masons.length
      ? { key: 'onuw.info.masons', params: { names: masons } }
      : { key: 'onuw.info.masonAlone', params: {} });
  }
  return out;
}

/** @param {OnuwContext} g @param {string} playerId @param {OnuwNightAction} [action] */
export function submitNight(g, playerId, action = {}) {
  require_(g.phase === 'night', 'wrongPhase');
  require_(playerById(g, playerId), 'notInGame');
  require_(isAwake(g, playerId), 'notYourTurn');
  const kind = actionFor(g, playerId);
  require_(kind, 'noNightAction');
  require_(!(playerId in g.nightActions), 'alreadyActed');

  /** @param {unknown} id */
  const known = (id) => typeof id === 'string' && Boolean(playerById(g, id));
  /** @param {unknown} i */
  const centreIndex = (i) => Number.isInteger(i) && /** @type {number} */ (i) >= 0
    && /** @type {number} */ (i) < g.centreStart.length;

  if (action.skip) {
    require_(kind !== 'drunk', 'drunkMustSwap');   // the Drunk has no choice
    g.nightActions[playerId] = { skip: true };
  } else if (kind === 'loneWolf') {
    require_(centreIndex(action.centre), 'badCentreCard');
    g.nightActions[playerId] = { centre: /** @type {number} */ (action.centre) };
  } else if (kind === 'seer') {
    if (action.mode === 'player') {
      require_(known(action.target) && action.target !== playerId, 'badTarget');
      g.nightActions[playerId] = { mode: 'player', target: /** @type {string} */ (action.target) };
    } else {
      const [a, b] = action.centres ?? [];
      require_(centreIndex(a) && centreIndex(b) && a !== b, 'badCentreCard');
      g.nightActions[playerId] = {
        mode: 'centre',
        centres: [/** @type {number} */ (a), /** @type {number} */ (b)],
      };
    }
  } else if (kind === 'robber') {
    require_(known(action.target) && action.target !== playerId, 'badTarget');
    g.nightActions[playerId] = { target: /** @type {string} */ (action.target) };
  } else if (kind === 'troublemaker') {
    const [a, b] = action.targets ?? [];
    require_(known(a) && known(b) && a !== b, 'badTarget');
    require_(a !== playerId && b !== playerId, 'troublemakerNotSelf');
    g.nightActions[playerId] = {
      targets: [/** @type {string} */ (a), /** @type {string} */ (b)],
    };
  } else if (kind === 'drunk') {
    require_(centreIndex(action.centre), 'badCentreCard');
    g.nightActions[playerId] = { centre: /** @type {number} */ (action.centre) };
  }

  // Resolve now, so the player sees what they looked at or took while they are
  // still awake. Order is safe: only this role acts during this step.
  resolve(g, playerId, /** @type {OnuwNightAction} */ (g.nightActions[playerId]));
  // Deliberately no early advance: the clock is the same for everyone.
}

/** When the room layer should look in on this game again. */
/** @param {OnuwContext} g */
export const nextDeadline = (g) => (g.phase === 'night' ? g.stepEndsAt : null);

/**
 * Advance the night if its clock has run out. Loops, so a server that was
 * busy for a while catches up rather than drifting.
 * @param {OnuwContext} g
 * @param {number} [now]
 */
export function tick(g, now = Date.now()) {
  if (g.phase !== 'night') return false;
  let moved = false;
  while (g.phase === 'night' && now >= g.stepEndsAt) {
    closeStep(g);
    g.step += 1;
    moved = true;
    if (g.step >= g.script.length) { dawn(g); break; }
    g.stepEndsAt += stepMillis(/** @type {import('../../../types/contracts.js').OnuwScriptStep} */ (g.script[g.step]), g.pace);
    openStep(g);
  }
  return moved;
}

/** @param {OnuwContext} g @param {string} id @param {string} key @param {Record<string, unknown>} [params] */
const addInfo = (g, id, key, params = {}) => { (g.info[id] ??= []).push({ key, params }); };

/** @param {OnuwContext} g @param {string} role */
const actorsFor = (g, role) => g.players.filter((p) => g.startRoles[p.id] === role);

/**
 * Entering a step. Everything that needs no decision happens the moment the
 * role opens its eyes: who your packmates are, what the Insomniac is holding.
 */
/** @param {OnuwContext} g */
function openStep(g) {
  const step = currentStep(g);
  if (!step?.role) return;
  for (const p of actorsFor(g, step.role)) {
    for (const k of staticKnowledge(g, p.id)) addInfo(g, p.id, k.key, k.params);
    if (step.role === 'insomniac') addInfo(g, p.id, 'onuw.info.insomniac', { role: g.finalRoles[p.id] });
  }
}

/** Apply one player's choice. Called as soon as they make it. */
/** @param {OnuwContext} g @param {string} playerId @param {OnuwNightAction} a */
function resolve(g, playerId, a) {
  const roles = g.finalRoles;
  const centre = g.centre;
  const role = g.startRoles[playerId];
  const me = /** @type {import('../../../types/contracts.js').Player} */ (playerById(g, playerId));

  if (role === 'werewolf') {
    if (Number.isInteger(a.centre)) {
      const i = /** @type {number} */ (a.centre);
      addInfo(g, playerId, 'onuw.info.sawCentre', { index: i + 1, role: centre[i] });
    }
  } else if (role === 'seer') {
    if (a.mode === 'player') {
      const target = /** @type {string} */ (a.target);
      addInfo(g, playerId, 'onuw.info.sawPlayer', { name: nameOf(g, target), role: roles[target] });
    }
    else if (a.mode === 'centre') {
      const [first, second] = /** @type {[number, number]} */ (a.centres);
      addInfo(g, playerId, 'onuw.info.sawTwoCentre', {
        a: first + 1, roleA: centre[first],
        b: second + 1, roleB: centre[second],
      });
    } else addInfo(g, playerId, 'onuw.info.lookedAtNothing');
  } else if (role === 'robber') {
    if (a.target) {
      const taken = /** @type {string} */ (roles[a.target]);
      roles[a.target] = /** @type {string} */ (roles[playerId]);
      roles[playerId] = taken;
      addInfo(g, playerId, 'onuw.info.robbed', { name: nameOf(g, a.target), role: taken });
      g.swaps.push({ key: 'onuw.swap.robber', params: { a: me.name, b: nameOf(g, a.target) } });
    } else addInfo(g, playerId, 'onuw.info.robbedNobody');
  } else if (role === 'troublemaker') {
    if (a.targets) {
      const [x, y] = /** @type {[string, string]} */ (a.targets);
      const first = /** @type {string} */ (roles[x]);
      roles[x] = /** @type {string} */ (roles[y]);
      roles[y] = first;
      addInfo(g, playerId, 'onuw.info.swapped', { a: nameOf(g, x), b: nameOf(g, y) });
      g.swaps.push({ key: 'onuw.swap.troublemaker', params: { a: nameOf(g, x), b: nameOf(g, y) } });
    } else addInfo(g, playerId, 'onuw.info.swappedNobody');
  } else if (role === 'drunk') {
    const i = /** @type {number} */ (a.centre);
    const playerRole = /** @type {string} */ (roles[playerId]);
    roles[playerId] = /** @type {string} */ (centre[i]);
    centre[i] = playerRole;
    addInfo(g, playerId, 'onuw.info.drunk', { index: i + 1 });
    g.swaps.push({ key: 'onuw.swap.drunk', params: { a: me.name, index: i + 1 } });
  }
}

/** Leaving a step: whoever let the clock run out gets the default outcome. */
/** @param {OnuwContext} g */
function closeStep(g) {
  const step = currentStep(g);
  if (!step?.role) return;
  for (const p of actorsFor(g, step.role)) {
    if (p.id in g.nightActions) continue;
    if (!actionFor(g, p.id)) continue;
    // The Drunk always swaps, even asleep at the wheel — with a card nobody
    // could have predicted.
    /** @type {OnuwNightAction} */
    const fallback = step.role === 'drunk'
      ? { centre: randInt(g, g.centre.length) }
      : { skip: true };
    g.nightActions[p.id] = fallback;
    resolve(g, p.id, fallback);
  }
}

/** @param {OnuwContext} g */
function dawn(g) {
  g.phase = 'day';
  g.step = g.script.length;
  logEvent(g, 'log.dawn', {});
}

// ---------------------------------------------------------------- the day

/** @param {OnuwContext} g @param {string} playerId */
export function startVote(g, playerId) {
  require_(g.phase === 'day', 'wrongPhase');
  require_(playerId === g.hostId, 'hostOnly');
  g.phase = 'vote';
  logEvent(g, 'log.voteStarted', {});
}

/** @param {OnuwContext} g @param {string} playerId @param {string} targetId */
export function castVote(g, playerId, targetId) {
  require_(g.phase === 'vote', 'wrongPhase');
  require_(playerById(g, playerId), 'notInGame');
  require_(playerById(g, targetId), 'unknownMember');
  require_(targetId !== playerId, 'cannotVoteSelf');
  require_(!(playerId in g.votes), 'alreadyVoted');
  g.votes[playerId] = targetId;
  if (Object.keys(g.votes).length === g.players.length) resolveVote(g);
}

/** @param {OnuwContext} g */
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
  g.winners = [...decideWinners(g.finalRoles, dead, houseRulesOf(g))];
  g.phase = 'over';
  logEvent(g, dead.size ? 'log.executed' : 'log.nobodyDied',
    { names: g.dead.map((id) => nameOf(g, id)) });
  logEvent(g, 'log.gameOver', { winner: g.winners[0] ?? 'nobody' });
}

/** What this table agreed to before the cards came out, and keeps. */
/** @param {OnuwContext} g */
const lobbyKeeps = (g) => ({
  options: g.options,
  optionsTouched: g.optionsTouched,
  houseRules: houseRulesOf(g),
  pace: g.pace,
});

/** @param {OnuwContext} g @param {string} playerId @param {{ now?: () => number }} [options] */
export function resetToLobby(g, playerId, { now = Date.now } = {}) {
  lobby.resetToLobby(g, playerId, () => ({
    fresh: createGame(g.code, { now, seed: g.seed }),
    keep: lobbyKeeps(g),
  }));
}

/** @param {OnuwContext} g @param {string} playerId @param {{ now?: () => number }} [options] */
export function restartToLobby(g, playerId, { now = Date.now } = {}) {
  lobby.restartToLobby(g, playerId, () => ({
    fresh: createGame(g.code, { now, seed: g.seed }),
    keep: lobbyKeeps(g),
  }));
}

// ---------------------------------------------------------------- views

/** @param {OnuwContext} g @param {string} viewerId @param {number} [now] @returns {OnuwView} */
export function viewFor(g, viewerId, now = Date.now()) {
  const me = playerById(g, viewerId);
  const over = g.phase === 'over';
  const night = g.phase === 'night';
  const startRole = g.startRoles[viewerId] ?? null;
  const step = currentStep(g);
  const awake = night && isAwake(g, viewerId);
  const action = awake ? actionFor(g, viewerId) : null;
  // Readiness is public before night begins. During the night, nobody is
  // waited on by name — see the note at the top of this file.
  const waiting = g.phase === 'reveal'
    ? g.players.filter((p) => !g.ready[p.id])
    : g.phase === 'vote' ? g.players.filter((p) => !(p.id in g.votes)) : [];

  const common = {
    ...lobby.baseView(g, viewerId),
    setup: {
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      options: OPTIONAL_ROLES.slice(),
      houseRules: HOUSE_RULE_KEYS.slice(),
      paces: Object.keys(PACES),
    },
    you: me ? {
      id: me.id, name: me.name, avatar: me.avatar ?? null,
      ...(g.phase === 'lobby' ? {} : {
        role: startRole,
        team: startRole ? teamOf(startRole) : null,
      }),
      ...(over ? { finalRole: g.finalRoles[viewerId] } : {}),
      ...(night ? {
        awake,
        ...(action ? { action } : {}),
        acted: viewerId in g.nightActions,
      } : {}),
      ...(g.phase === 'vote' ? { voted: viewerId in g.votes } : {}),
    } : null,
    players: g.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar ?? null,
      seat: i,
      ...(g.phase === 'reveal' ? { ready: Boolean(g.ready[p.id]) } : {}),
      // No `acted` at night: it would be false only for players holding an
      // action role, which is the deck read straight off the screen.
      ...(g.phase === 'vote' ? { voted: p.id in g.votes } : {}),
      ...(over ? {
        votedFor: g.votes[p.id] ?? null,
        dead: g.dead.includes(p.id),
        startRole: g.startRoles[p.id],
        finalRole: g.finalRoles[p.id],
      } : {}),
    })),
  };

  if (g.phase === 'lobby') return {
    ...common,
    options: { ...liveOptions(g) },
    houseRules: houseRulesOf(g),
    optionRoom: roomForOptions(g.players.length),
    deck: safeDeck(g),
    pace: g.pace,
    nightScript: lobbyScript(g).map((entry) => entry.key),
    nightSeconds: nightLength(lobbyDeck(g), g.pace) / 1000,
  };

  const inGame = {
    ...common,
    houseRules: houseRulesOf(g),
    deck: countRoles([...Object.values(g.startRoles), ...g.centreStart]),
    centreCount: g.centreStart.length,
    nightScript: g.script.map((entry) => entry.key),
    info: g.info[viewerId] ?? [],
  };

  if (g.phase === 'reveal') return { ...inGame, waitingFor: waiting.map((p) => p.id) };
  if (g.phase === 'night') return {
    ...inGame,
    // The same clock for every player, so the countdown can never be read as
    // a signal about who is doing what.
    night: step ? {
      index: g.step,
      total: g.script.length,
      key: step.key,
      msLeft: Math.max(0, g.stepEndsAt - now),
      msTotal: stepMillis(step, g.pace),
    } : null,
  };
  if (g.phase === 'day') return inGame;
  if (g.phase === 'vote') return { ...inGame, waitingFor: waiting.map((p) => p.id) };
  if (g.phase === 'over') return {
    ...inGame,
    centre: g.centre,
    swaps: g.swaps,
    dead: g.dead,
    winners: g.winners,
    ...(me ? { youWon: g.winners.includes(teamOf(g.finalRoles[viewerId])) } : {}),
  };
  throw new Error(`unknown One Night phase: ${g.phase}`);
}

/** @param {OnuwContext} g */
const lobbyDeck = (g) => safeDeckList(g) ?? [];
/** @param {OnuwContext} g */
const lobbyScript = (g) => nightScript(lobbyDeck(g));

/** @param {OnuwContext} g */
function safeDeckList(g) {
  try {
    return buildDeck(g.players.length, liveOptions(g));
  } catch {
    return null;
  }
}

/** The lobby shows the deck; an impossible choice shows as no deck at all. */
/** @param {OnuwContext} g */
function safeDeck(g) {
  const deck = safeDeckList(g);
  return deck ? countRoles(deck) : null;
}

/** @param {string[]} list */
function countRoles(list) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const role of list) counts[role] = (counts[role] ?? 0) + 1;
  return counts;
}
