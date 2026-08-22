// One Night Ultimate Werewolf: the static rules. No state, no I/O.

import { GameError } from '../../lobby.js';

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 10;
export const CENTRE_CARDS = 3;   // the deck is always players + 3

/**
 * `wake` is the night order; a role with no `wake` sleeps through it.
 * `acts` means the player has a choice to make and the night waits for them.
 */
export const ROLES = {
  werewolf:     { team: 'werewolf', wake: 10, acts: 'loneWolf', copies: 2, core: true },
  minion:       { team: 'werewolf', wake: 20, optional: true },
  mason:        { team: 'village',  wake: 30, copies: 2, optional: true },
  seer:         { team: 'village',  wake: 40, acts: 'seer', core: true },
  robber:       { team: 'village',  wake: 50, acts: 'robber', core: true },
  troublemaker: { team: 'village',  wake: 60, acts: 'troublemaker', core: true },
  drunk:        { team: 'village',  wake: 70, acts: 'drunk', optional: true },
  insomniac:    { team: 'village',  wake: 80, optional: true },
  hunter:       { team: 'village',  optional: true },
  tanner:       { team: 'tanner',   optional: true },
  villager:     { team: 'village' },
};

export const OPTIONAL_ROLES = Object.keys(ROLES).filter((r) => ROLES[r].optional);
export const NIGHT_ORDER = Object.keys(ROLES)
  .filter((r) => ROLES[r].wake)
  .sort((a, b) => ROLES[a].wake - ROLES[b].wake);

export const teamOf = (role) => ROLES[role].team;
export const copiesOf = (role) => ROLES[role].copies ?? 1;

/** The cards that are always in the deck, whatever the host picks. */
export const CORE_ROLES = Object.keys(ROLES).filter((r) => ROLES[r].core);

/**
 * Build the deck: the core roles, the optional ones the host switched on, and
 * villagers for whatever is left. Throws if the choices do not fit.
 */
export function buildDeck(playerCount, options = {}) {
  if (playerCount < MIN_PLAYERS || playerCount > MAX_PLAYERS) {
    throw new GameError('badPlayerCount', { min: MIN_PLAYERS, max: MAX_PLAYERS });
  }
  const size = playerCount + CENTRE_CARDS;
  const deck = [];
  for (const role of CORE_ROLES) for (let i = 0; i < copiesOf(role); i++) deck.push(role);
  for (const role of OPTIONAL_ROLES) {
    if (!options[role]) continue;
    for (let i = 0; i < copiesOf(role); i++) deck.push(role);
  }
  if (deck.length > size) throw new GameError('tooManyRoles', { max: size - CORE_TOTAL, size });
  while (deck.length < size) deck.push('villager');
  return deck;
}

const CORE_TOTAL = CORE_ROLES.reduce((n, r) => n + copiesOf(r), 0);
export { CORE_TOTAL };

/** How many optional cards still fit at this player count. */
export function roomForOptions(playerCount) {
  return playerCount + CENTRE_CARDS - CORE_TOTAL;
}

/** A sensible deck for each table size, used as the lobby default. */
export function defaultOptions(playerCount) {
  const wanted = ['minion', 'drunk', 'insomniac', 'mason', 'tanner', 'hunter'];
  const options = {};
  let left = roomForOptions(playerCount);
  for (const role of wanted) {
    const cost = copiesOf(role);
    if (cost <= left) { options[role] = true; left -= cost; }
  }
  return { ...Object.fromEntries(OPTIONAL_ROLES.map((r) => [r, false])), ...options };
}

/**
 * Who wins, given the final cards and who died.
 *
 * The rulebook conditions this implements, in order:
 *  - the Tanner wins if the Tanner dies;
 *  - the village wins if at least one werewolf dies;
 *  - with no werewolf among the players, the village wins if nobody dies;
 *  - otherwise the werewolf team wins, unless the Tanner died.
 */
export function decideWinners(finalRoles, dead) {
  const roleOf = (id) => finalRoles[id];
  const wolvesInPlay = Object.keys(finalRoles).filter((id) => roleOf(id) === 'werewolf');
  const wolfDied = [...dead].some((id) => roleOf(id) === 'werewolf');
  const tannerDied = [...dead].some((id) => roleOf(id) === 'tanner');

  const winners = new Set();
  if (tannerDied) winners.add('tanner');
  if (wolfDied) winners.add('village');
  else if (wolvesInPlay.length === 0 && dead.size === 0) winners.add('village');
  else if (wolvesInPlay.length > 0 && !tannerDied) winners.add('werewolf');
  return winners;
}

/**
 * Tally a round of voting. Everyone points at someone; the most-pointed-at
 * die. If every player collects exactly one vote, the table cannot agree and
 * nobody dies.
 */
export function tallyVotes(playerIds, votes) {
  const counts = new Map(playerIds.map((id) => [id, 0]));
  for (const target of Object.values(votes)) {
    if (counts.has(target)) counts.set(target, counts.get(target) + 1);
  }
  const top = Math.max(0, ...counts.values());
  const everyoneOnce = [...counts.values()].every((n) => n === 1);
  const dead = new Set(
    top === 0 || everyoneOnce ? [] : playerIds.filter((id) => counts.get(id) === top),
  );
  return { counts: Object.fromEntries(counts), dead, noDeaths: dead.size === 0 };
}
