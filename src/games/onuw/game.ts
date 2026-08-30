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
  DEFAULT_PACE, HOUSE_RULES, HOUSE_RULE_KEYS, MAX_PLAYERS, MIN_PLAYERS, OPTIONAL_ROLES,
  PACES, ROLES, buildDeck, decideWinners, defaultOptions, nightLength, nightScript,
  roomForOptions, stepMillis, tallyVotes, teamOf,
} from './rules.ts';
import type { NightStep, OnuwOptions, OnuwRole } from './rules.ts';
import * as lobby from '../../lobby.ts';
import { logEvent, playerById, randInt, require_, shuffleWith } from '../../lobby.ts';
import type { OnuwNightAction } from '../../contracts/actions.ts';
import type { GameEvent, OnuwState, Player } from '../../contracts/persistence.ts';
import type { OnuwCommand, OnuwContext } from '../../contracts/runtime.ts';
import type { OnuwView } from '../../contracts/views.ts';

type CreateOptions = { now?: () => number; seed?: number };
type SetOptions = Extract<OnuwCommand, { type: 'options' }>['options'];
type StartOptions = { shuffle?: <T>(list: T[]) => T[]; now?: () => number };
type OnuwActionKind = 'loneWolf' | 'seer' | 'robber' | 'troublemaker' | 'drunk';
interface NightSubmission {
  skip?: true | undefined;
  centre?: number | undefined;
  target?: string | undefined;
  targets?: [string, string] | undefined;
  mode?: 'player' | 'centre' | undefined;
  centres?: [number, number] | undefined;
}

export function createGame(code: string, { now = Date.now, seed }: CreateOptions = {}): OnuwContext {
  const state: OnuwState = {
    phase: 'lobby',
    options: {
      minion: false, mason: false, drunk: false, insomniac: false, hunter: false, tanner: false,
    },
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
  };
  const room = lobby.baseRoom(code, 'onuw', state, { now, ...(seed === undefined ? {} : { seed }) });
  return { room, state };
}

export const addPlayer = (
  g: OnuwContext,
  player: { id: string; name?: string; avatar?: string },
): Player => lobby.addPlayer(g, player, { maxPlayers: MAX_PLAYERS });
export const removePlayer = (g: OnuwContext, playerId: string): void => lobby.removePlayer(g, playerId);

/** @param {OnuwContext} g @param {string} id */
const nameOf = (g: OnuwContext, id: string): string => playerById(g, id)?.name ?? '?';
/** The deck the lobby is currently describing. */
/** @param {OnuwContext} g */
const liveOptions = (g: OnuwContext): OnuwOptions =>
  (g.state.optionsTouched ? g.state.options : defaultOptions(g.room.players.length));

/** @param {OnuwContext} g */
const houseRulesOf = (g: OnuwContext): OnuwState['houseRules'] =>
  lobby.houseRulesInForce(g, HOUSE_RULE_KEYS);

export function setOptions(g: OnuwContext, playerId: string, options: SetOptions): void {
  require_(g.state.phase === 'lobby', 'gameAlreadyStarted');
  require_(playerId === g.room.hostId, 'hostOnly');
  if (options.pace !== undefined) {
    require_(options.pace in PACES, 'badPace');
    g.state.pace = options.pace;
  }
  if (options.houseRules) lobby.setHouseRules(g, options.houseRules, HOUSE_RULE_KEYS);
  /** @type {Record<string, boolean>} */
  const next = { ...liveOptions(g) };
  for (const role of OPTIONAL_ROLES) if (role in options) next[role] = Boolean(options[role]);
  buildDeck(g.room.players.length, next);   // throws before anything is committed
  g.state.options = next;
  g.state.optionsTouched = true;
}

/** @param {OnuwContext} g @param {string} playerId @param {{ shuffle?: <T>(list: T[]) => T[], now?: () => number }} [options] */
export function startGame(
  g: OnuwContext,
  playerId: string,
  { shuffle = <T>(list: T[]) => shuffleWith(g, list), now = Date.now }: StartOptions = {},
): void {
  require_(g.state.phase === 'lobby', 'gameAlreadyStarted');
  require_(playerId === g.room.hostId, 'hostOnly');
  require_(g.room.players.length >= MIN_PLAYERS, 'needMorePlayers', { min: MIN_PLAYERS });

  const deck = shuffle(buildDeck(g.room.players.length, liveOptions(g)));
  g.state.options = liveOptions(g);
  g.room.players = shuffle(g.room.players.slice());
  g.state.startRoles = Object.fromEntries(g.room.players.map((player, index) => [player.id, deck[index]!]));
  g.state.centreStart = deck.slice(g.room.players.length);

  // The night mutates these as each step closes.
  g.state.finalRoles = { ...g.state.startRoles };
  g.state.centre = g.state.centreStart.slice();

  g.state.script = nightScript(deck);
  g.state.phase = 'reveal';
  g.state.ready = {};
  g.state.step = -1;
  g.state.stepEndsAt = 0;
  logEvent(g, 'log.gameStarted', { count: g.room.players.length });
}

/** Every player gets time to inspect their card before the shared clock begins. */
/** @param {OnuwContext} g @param {string} playerId @param {{ now?: () => number }} [options] */
export function confirmRole(
  g: OnuwContext,
  playerId: string,
  { now = Date.now }: { now?: () => number } = {},
): void {
  require_(g.state.phase === 'reveal', 'wrongPhase');
  require_(playerById(g, playerId), 'notInGame');
  g.state.ready[playerId] = true;
  if (!g.room.players.every((p) => g.state.ready[p.id])) return;

  g.state.phase = 'night';
  g.state.step = 0;
  g.state.stepEndsAt = now() + stepMillis(g.state.script[0]!, g.state.pace);
  openStep(g);
}

// ---------------------------------------------------------------- the night

/** @param {OnuwContext} g */
const wolvesAmongPlayers = (g: OnuwContext): Player[] =>
  g.room.players.filter((player) => g.state.startRoles[player.id] === 'werewolf');

/** @param {OnuwContext} g */
export const currentStep = (g: OnuwContext): NightStep | null =>
  (g.state.phase === 'night' ? g.state.script[g.state.step] ?? null : null);

/** What this player must decide during their role's step, if anything. */
/** @param {OnuwContext} g @param {string} playerId */
export function actionFor(g: OnuwContext, playerId: string): OnuwActionKind | null {
  const role = g.state.startRoles[playerId];
  if (!role) return null;
  const definition = ROLES[role];
  const kind = 'acts' in definition ? definition.acts : undefined;
  if (!kind) return null;
  if (kind === 'loneWolf') return wolvesAmongPlayers(g).length === 1 ? 'loneWolf' : null;
  return kind;
}

/** Is it this player's turn to be awake right now? */
/** @param {OnuwContext} g @param {string} playerId */
export function isAwake(g: OnuwContext, playerId: string): boolean {
  const step = currentStep(g);
  return Boolean(step?.role && g.state.startRoles[playerId] === step.role);
}

/**
 * What a player learns simply by being woken — their packmates, the other
 * Mason, who the werewolves are. Shown during their own step, and repeated in
 * the morning.
 * @param {OnuwContext} g
 * @param {string} playerId
 */
export function staticKnowledge(g: OnuwContext, playerId: string): GameEvent[] {
  const role = g.state.startRoles[playerId];
  const others = (test: (player: Player) => boolean) =>
    g.room.players.filter((player) => player.id !== playerId && test(player)).map((player) => player.name);
  const out: GameEvent[] = [];

  if (role === 'werewolf') {
    const pack = others((p) => g.state.startRoles[p.id] === 'werewolf');
    out.push(pack.length
      ? { key: 'onuw.info.packmates', params: { names: pack } }
      : { key: 'onuw.info.loneWolf', params: {} });
  } else if (role === 'minion') {
    const wolves = g.room.players.filter((p) => g.state.startRoles[p.id] === 'werewolf').map((p) => p.name);
    // A decisive vote makes a pack of one out of a Minion with nobody to serve,
    // so he is told: the hunt is for him now.
    const alone = houseRulesOf(g).decisiveVote ? 'onuw.info.minionIsPack' : 'onuw.info.minionAlone';
    out.push(wolves.length
      ? { key: 'onuw.info.minionSees', params: { names: wolves } }
      : { key: alone, params: {} });
  } else if (role === 'mason') {
    const masons = others((p) => g.state.startRoles[p.id] === 'mason');
    out.push(masons.length
      ? { key: 'onuw.info.masons', params: { names: masons } }
      : { key: 'onuw.info.masonAlone', params: {} });
  }
  return out;
}

/** @param {OnuwContext} g @param {string} playerId @param {OnuwNightAction} [action] */
export function submitNight(
  g: OnuwContext,
  playerId: string,
  action: NightSubmission = {},
): void {
  require_(g.state.phase === 'night', 'wrongPhase');
  require_(playerById(g, playerId), 'notInGame');
  require_(isAwake(g, playerId), 'notYourTurn');
  const kind = actionFor(g, playerId);
  require_(kind, 'noNightAction');
  require_(!(playerId in g.state.nightActions), 'alreadyActed');

  /** @param {unknown} id */
  const known = (id: unknown): id is string => typeof id === 'string' && Boolean(playerById(g, id));
  /** @param {unknown} i */
  const centreIndex = (i: unknown): i is number => typeof i === 'number' && Number.isInteger(i)
    && i >= 0 && i < g.state.centreStart.length;

  if (action.skip) {
    require_(kind !== 'drunk', 'drunkMustSwap');   // the Drunk has no choice
    g.state.nightActions[playerId] = { skip: true };
  } else if (kind === 'loneWolf') {
    require_(centreIndex(action.centre), 'badCentreCard');
    g.state.nightActions[playerId] = { centre: action.centre };
  } else if (kind === 'seer') {
    if (action.mode === 'player') {
      require_(known(action.target) && action.target !== playerId, 'badTarget');
      g.state.nightActions[playerId] = { mode: 'player', target: action.target };
    } else {
      const [a, b] = action.centres ?? [];
      require_(centreIndex(a) && centreIndex(b) && a !== b, 'badCentreCard');
      g.state.nightActions[playerId] = {
        mode: 'centre',
        centres: [a, b],
      };
    }
  } else if (kind === 'robber') {
    require_(known(action.target) && action.target !== playerId, 'badTarget');
    g.state.nightActions[playerId] = { target: action.target };
  } else if (kind === 'troublemaker') {
    const [a, b] = action.targets ?? [];
    require_(known(a) && known(b) && a !== b, 'badTarget');
    require_(a !== playerId && b !== playerId, 'troublemakerNotSelf');
    g.state.nightActions[playerId] = {
      targets: [a, b],
    };
  } else if (kind === 'drunk') {
    require_(centreIndex(action.centre), 'badCentreCard');
    g.state.nightActions[playerId] = { centre: action.centre };
  }

  // Resolve now, so the player sees what they looked at or took while they are
  // still awake. Order is safe: only this role acts during this step.
  resolve(g, playerId, g.state.nightActions[playerId]!);
  // Deliberately no early advance: the clock is the same for everyone.
}

/** When the room layer should look in on this game again. */
/** @param {OnuwContext} g */
export const nextDeadline = (g: OnuwContext): number | null =>
  (g.state.phase === 'night' ? g.state.stepEndsAt : null);

/**
 * Advance the night if its clock has run out. Loops, so a server that was
 * busy for a while catches up rather than drifting.
 * @param {OnuwContext} g
 * @param {number} [now]
 */
export function tick(g: OnuwContext, now = Date.now()): boolean {
  if (g.state.phase !== 'night') return false;
  let moved = false;
  while (g.state.phase === 'night' && now >= g.state.stepEndsAt) {
    closeStep(g);
    g.state.step += 1;
    moved = true;
    if (g.state.step >= g.state.script.length) { dawn(g); break; }
    g.state.stepEndsAt += stepMillis(g.state.script[g.state.step]!, g.state.pace);
    openStep(g);
  }
  return moved;
}

/** @param {OnuwContext} g @param {string} id @param {string} key @param {Record<string, unknown>} [params] */
const addInfo = (
  g: OnuwContext,
  id: string,
  key: string,
  params: Record<string, unknown> = {},
): void => { (g.state.info[id] ??= []).push({ key, params }); };

/** @param {OnuwContext} g @param {string} role */
const actorsFor = (g: OnuwContext, role: OnuwRole): Player[] =>
  g.room.players.filter((player) => g.state.startRoles[player.id] === role);

/**
 * Entering a step. Everything that needs no decision happens the moment the
 * role opens its eyes: who your packmates are, what the Insomniac is holding.
 */
/** @param {OnuwContext} g */
function openStep(g: OnuwContext): void {
  const step = currentStep(g);
  if (!step?.role) return;
  for (const p of actorsFor(g, step.role)) {
    for (const k of staticKnowledge(g, p.id)) addInfo(g, p.id, k.key, k.params);
    if (step.role === 'insomniac') addInfo(g, p.id, 'onuw.info.insomniac', { role: g.state.finalRoles[p.id] });
  }
}

/** Apply one player's choice. Called as soon as they make it. */
/** @param {OnuwContext} g @param {string} playerId @param {OnuwNightAction} a */
function resolve(g: OnuwContext, playerId: string, a: OnuwNightAction): void {
  const roles = g.state.finalRoles;
  const centre = g.state.centre;
  const role = g.state.startRoles[playerId];
  const me = playerById(g, playerId)!;

  if (role === 'werewolf') {
    if ('centre' in a && Number.isInteger(a.centre)) {
      const i = a.centre;
      addInfo(g, playerId, 'onuw.info.sawCentre', { index: i + 1, role: centre[i] });
    }
  } else if (role === 'seer') {
    if ('mode' in a && a.mode === 'player') {
      const target = a.target;
      addInfo(g, playerId, 'onuw.info.sawPlayer', { name: nameOf(g, target), role: roles[target] });
    }
    else if ('mode' in a && a.mode === 'centre') {
      const [first, second] = a.centres;
      addInfo(g, playerId, 'onuw.info.sawTwoCentre', {
        a: first + 1, roleA: centre[first],
        b: second + 1, roleB: centre[second],
      });
    } else addInfo(g, playerId, 'onuw.info.lookedAtNothing');
  } else if (role === 'robber') {
    if ('target' in a && a.target) {
      const taken = roles[a.target]!;
      roles[a.target] = roles[playerId]!;
      roles[playerId] = taken;
      addInfo(g, playerId, 'onuw.info.robbed', { name: nameOf(g, a.target), role: taken });
      g.state.swaps.push({ key: 'onuw.swap.robber', params: { a: me.name, b: nameOf(g, a.target) } });
    } else addInfo(g, playerId, 'onuw.info.robbedNobody');
  } else if (role === 'troublemaker') {
    if ('targets' in a && a.targets) {
      const [x, y] = a.targets;
      const first = roles[x]!;
      roles[x] = roles[y]!;
      roles[y] = first;
      addInfo(g, playerId, 'onuw.info.swapped', { a: nameOf(g, x), b: nameOf(g, y) });
      g.state.swaps.push({ key: 'onuw.swap.troublemaker', params: { a: nameOf(g, x), b: nameOf(g, y) } });
    } else addInfo(g, playerId, 'onuw.info.swappedNobody');
  } else if (role === 'drunk') {
    require_('centre' in a, 'badCentreCard');
    const i = a.centre;
    const playerRole = roles[playerId]!;
    roles[playerId] = centre[i]!;
    centre[i] = playerRole;
    addInfo(g, playerId, 'onuw.info.drunk', { index: i + 1 });
    g.state.swaps.push({ key: 'onuw.swap.drunk', params: { a: me.name, index: i + 1 } });
  }
}

/** Leaving a step: whoever let the clock run out gets the default outcome. */
/** @param {OnuwContext} g */
function closeStep(g: OnuwContext): void {
  const step = currentStep(g);
  if (!step?.role) return;
  for (const p of actorsFor(g, step.role)) {
    if (p.id in g.state.nightActions) continue;
    if (!actionFor(g, p.id)) continue;
    // The Drunk always swaps, even asleep at the wheel — with a card nobody
    // could have predicted.
    const fallback: OnuwNightAction = step.role === 'drunk'
      ? { centre: randInt(g, g.state.centre.length) }
      : { skip: true };
    g.state.nightActions[p.id] = fallback;
    resolve(g, p.id, fallback);
  }
}

/** @param {OnuwContext} g */
function dawn(g: OnuwContext): void {
  g.state.phase = 'day';
  g.state.step = g.state.script.length;
  logEvent(g, 'log.dawn', {});
}

// ---------------------------------------------------------------- the day

/** @param {OnuwContext} g @param {string} playerId */
export function startVote(g: OnuwContext, playerId: string): void {
  require_(g.state.phase === 'day', 'wrongPhase');
  require_(playerId === g.room.hostId, 'hostOnly');
  g.state.phase = 'vote';
  logEvent(g, 'log.voteStarted', {});
}

/** @param {OnuwContext} g @param {string} playerId @param {string} targetId */
export function castVote(g: OnuwContext, playerId: string, targetId: string): void {
  require_(g.state.phase === 'vote', 'wrongPhase');
  require_(playerById(g, playerId), 'notInGame');
  require_(playerById(g, targetId), 'unknownMember');
  require_(targetId !== playerId, 'cannotVoteSelf');
  require_(!(playerId in g.state.votes), 'alreadyVoted');
  g.state.votes[playerId] = targetId;
  if (Object.keys(g.state.votes).length === g.room.players.length) resolveVote(g);
}

/** @param {OnuwContext} g */
function resolveVote(g: OnuwContext): void {
  const ids = g.room.players.map((p) => p.id);
  const { dead } = tallyVotes(ids, g.state.votes);

  // The Hunter takes whoever they pointed at down with them.
  for (const id of [...dead]) {
    if (g.state.finalRoles[id] === 'hunter' && g.state.votes[id]) {
      if (!dead.has(g.state.votes[id])) {
        dead.add(g.state.votes[id]);
        logEvent(g, 'log.hunterFires', { name: nameOf(g, id), target: nameOf(g, g.state.votes[id]) });
      }
    }
  }

  g.state.dead = [...dead];
  g.state.winners = [...decideWinners(g.state.finalRoles, dead, houseRulesOf(g))];
  g.state.phase = 'over';
  logEvent(g, dead.size ? 'log.executed' : 'log.nobodyDied',
    { names: g.state.dead.map((id) => nameOf(g, id)) });
  logEvent(g, 'log.gameOver', { winner: g.state.winners[0] ?? 'nobody' });
}

/** What this table agreed to before the cards came out, and keeps. */
/** @param {OnuwContext} g */
const lobbyKeeps = (g: OnuwContext): Partial<OnuwState> => ({
  options: g.state.options,
  optionsTouched: g.state.optionsTouched,
  houseRules: houseRulesOf(g),
  pace: g.state.pace,
});

/** @param {OnuwContext} g @param {string} playerId @param {{ now?: () => number }} [options] */
export function resetToLobby(
  g: OnuwContext,
  playerId: string,
  { now = Date.now }: { now?: () => number } = {},
): void {
  lobby.resetToLobby(g, playerId, () => ({
    fresh: createGame(g.room.code, { now, seed: g.room.seed }),
    keep: lobbyKeeps(g),
  }));
}

/** @param {OnuwContext} g @param {string} playerId @param {{ now?: () => number }} [options] */
export function restartToLobby(
  g: OnuwContext,
  playerId: string,
  { now = Date.now }: { now?: () => number } = {},
): void {
  lobby.restartToLobby(g, playerId, () => ({
    fresh: createGame(g.room.code, { now, seed: g.room.seed }),
    keep: lobbyKeeps(g),
  }));
}

// ---------------------------------------------------------------- views

/** @param {OnuwContext} g @param {string} viewerId @param {number} [now] @returns {OnuwView} */
export function viewFor(g: OnuwContext, viewerId: string, now = Date.now()): OnuwView {
  const me = playerById(g, viewerId);
  const night = g.state.phase === 'night';
  const startRole = g.state.startRoles[viewerId] ?? null;
  const step = currentStep(g);
  const awake = night && isAwake(g, viewerId);
  const action = awake ? actionFor(g, viewerId) : null;
  // Readiness is public before night begins. During the night, nobody is
  // waited on by name — see the note at the top of this file.
  const waiting = g.state.phase === 'reveal'
    ? g.room.players.filter((p) => !g.state.ready[p.id])
    : g.state.phase === 'vote' ? g.room.players.filter((p) => !(p.id in g.state.votes)) : [];

  const common = {
    ...lobby.baseView(g, viewerId),
    setup: {
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      options: OPTIONAL_ROLES.slice(),
      houseRules: HOUSE_RULE_KEYS.slice(),
      paces: Object.keys(PACES),
    },
  };
  const you = me ? {
    id: me.id, name: me.name, avatar: me.avatar ?? null,
    role: startRole,
    team: startRole ? teamOf(startRole) : null,
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
    optionRoom: roomForOptions(g.room.players.length),
    deck: safeDeck(g),
    pace: g.state.pace,
    nightScript: lobbyScript(g).map((entry) => entry.key),
    nightSeconds: nightLength(lobbyDeck(g), g.state.pace) / 1000,
  };

  const inGame = {
    ...common, you,
    houseRules: houseRulesOf(g),
    deck: countRoles([...Object.values(g.state.startRoles), ...g.state.centreStart]),
    centreCount: g.state.centreStart.length,
    nightScript: g.state.script.map((entry) => entry.key),
    info: g.state.info[viewerId] ?? [],
  };

  if (g.state.phase === 'reveal') return {
    ...inGame, phase: 'reveal',
    players: players.map((p) => ({ ...p, ready: Boolean(g.state.ready[p.id]) })),
    waitingFor: waiting.map((p) => p.id),
  };
  if (g.state.phase === 'night') return {
    ...inGame, phase: 'night',
    you: you ? {
      ...you, awake, ...(action ? { action } : {}), acted: viewerId in g.state.nightActions,
    } : null,
    // No `acted` on other seats: it would identify the players holding action roles.
    players,
    // The same clock for every player, so the countdown can never be read as
    // a signal about who is doing what.
    night: step ? {
      index: g.state.step,
      total: g.state.script.length,
      key: step.key,
      msLeft: Math.max(0, g.state.stepEndsAt - now),
      msTotal: stepMillis(step, g.state.pace),
    } : null,
  };
  if (g.state.phase === 'day') return { ...inGame, phase: 'day', players };
  if (g.state.phase === 'vote') return {
    ...inGame, phase: 'vote',
    you: you ? { ...you, voted: viewerId in g.state.votes } : null,
    players: players.map((p) => ({ ...p, voted: p.id in g.state.votes })),
    waitingFor: waiting.map((p) => p.id),
  };
  if (g.state.phase === 'over') return {
    ...inGame, phase: 'over',
    you: you ? { ...you, finalRole: g.state.finalRoles[viewerId] } : null,
    players: players.map((p) => ({
      ...p,
      votedFor: g.state.votes[p.id] ?? null,
      dead: g.state.dead.includes(p.id),
      startRole: g.state.startRoles[p.id],
      finalRole: g.state.finalRoles[p.id],
    })),
    centre: g.state.centre,
    swaps: g.state.swaps,
    dead: g.state.dead,
    winners: g.state.winners,
    ...(me && g.state.finalRoles[viewerId]
      ? { youWon: g.state.winners.includes(teamOf(g.state.finalRoles[viewerId])) }
      : {}),
  };
  throw new Error(`unknown One Night phase: ${g.state.phase}`);
}

/** @param {OnuwContext} g */
const lobbyDeck = (g: OnuwContext): OnuwRole[] => safeDeckList(g) ?? [];
/** @param {OnuwContext} g */
const lobbyScript = (g: OnuwContext): NightStep[] => nightScript(lobbyDeck(g));

/** @param {OnuwContext} g */
function safeDeckList(g: OnuwContext): OnuwRole[] | null {
  try {
    return buildDeck(g.room.players.length, liveOptions(g));
  } catch {
    return null;
  }
}

/** The lobby shows the deck; an impossible choice shows as no deck at all. */
/** @param {OnuwContext} g */
function safeDeck(g: OnuwContext): Record<string, number> | null {
  const deck = safeDeckList(g);
  return deck ? countRoles(deck) : null;
}

/** @param {string[]} list */
function countRoles(list: OnuwRole[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const role of list) counts[role] = (counts[role] ?? 0) + 1;
  return counts;
}
