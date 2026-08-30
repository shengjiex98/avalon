// One Night Ultimate Werewolf: the static rules. No state, no I/O.

import { GameError } from '../../lobby.ts';

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
} as const;

export type OnuwRole = keyof typeof ROLES;
export type OnuwTeam = (typeof ROLES)[OnuwRole]['team'];
export type OptionalOnuwRole = {
  [Role in OnuwRole]: (typeof ROLES)[Role] extends { optional: true } ? Role : never
}[OnuwRole];
export type OnuwOptions = Record<OptionalOnuwRole, boolean>;
const ROLE_KEYS = Object.keys(ROLES) as OnuwRole[];
type RoleSpec = {
  team: OnuwTeam; wake?: number; acts?: string; copies?: number; optional?: boolean; core?: boolean;
};
const roleSpec = (role: OnuwRole): RoleSpec => ROLES[role];

export const OPTIONAL_ROLES = ROLE_KEYS.filter(
  (role): role is OptionalOnuwRole => roleSpec(role).optional === true,
);

/**
 * House rules: printed rules some tables prefer to play differently. Each maps
 * to how a new table plays unless the host says otherwise. They change how the
 * vote is scored, never what is dealt — so a house rule can never make a deck
 * impossible.
 *
 * `decisiveVote` is the common table fix for the game's flattest ending. By
 * the book, a table holding no werewolf card at all must kill nobody: hang the
 * Minion and nobody wins, hang anyone else with no Minion in play and nobody
 * wins either. This rule promotes the Minion to head of an absent pack, so
 * catching him is the village's win and hanging an innocent is the werewolf
 * side's. It is on by default because those two endings reward nobody for the
 * argument that produced them.
 */
export const HOUSE_RULES = { decisiveVote: true };
export const HOUSE_RULE_KEYS = Object.keys(HOUSE_RULES);

export const NIGHT_ORDER = ROLE_KEYS
  .filter((role) => roleSpec(role).wake !== undefined)
  .sort((a, b) => (roleSpec(a).wake ?? 0) - (roleSpec(b).wake ?? 0));

/** Seconds each waking role gets: long enough to read the table and decide. */
const STEP_SECONDS: Partial<Record<OnuwRole, number>> = {
  werewolf: 15, minion: 12, mason: 12, seer: 22,
  robber: 20, troublemaker: 22, drunk: 15, insomniac: 12,
};
const NIGHTFALL_SECONDS = 8;
const DAWN_SECONDS = 8;

/**
 * The night, as the table hears it.
 *
 * A step is included when its role is **in the deck** — which is public, since
 * the lobby shows it. Calling a role nobody agreed to play hides nothing and
 * only costs everyone time.
 *
 * A role in the deck is always called even if its card happens to be in the
 * centre, because *that* is secret. And no step ever ends early, since ending
 * early would announce that the role was in play and had finished. Between
 * them those two rules mean the clock reveals nothing the lobby did not.
 */
export type NightStep = { key: string; role?: OnuwRole | undefined; seconds: number };

export function nightScript(deck: OnuwRole[]): NightStep[] {
  const present = new Set(deck);
  return [
    { key: 'nightfall', seconds: NIGHTFALL_SECONDS },
    ...NIGHT_ORDER.filter((role) => present.has(role))
      .map((role) => ({ key: role, role, seconds: STEP_SECONDS[role] ?? 0 })),
    { key: 'dawn', seconds: DAWN_SECONDS },
  ];
}

export const PACES = { brisk: 0.6, normal: 1, relaxed: 1.6 };
export const DEFAULT_PACE = 'normal';
export type Pace = keyof typeof PACES;
const isPace = (pace: string): pace is Pace => pace === 'brisk' || pace === 'normal' || pace === 'relaxed';

/** How long a step lasts at this table's pace, in milliseconds. */
export function stepMillis(step: NightStep, pace: string = DEFAULT_PACE): number {
  const multiplier = isPace(pace) ? PACES[pace] : 1;
  return Math.round(step.seconds * multiplier) * 1000;
}

export const nightLength = (deck: OnuwRole[], pace: string): number =>
  nightScript(deck).reduce((ms, step) => ms + stepMillis(step, pace), 0);

export const teamOf = (role: OnuwRole): OnuwTeam => ROLES[role].team;
export const copiesOf = (role: OnuwRole): number => roleSpec(role).copies ?? 1;

/** The cards that are always in the deck, whatever the host picks. */
export const CORE_ROLES = ROLE_KEYS.filter((role) => roleSpec(role).core === true);

/**
 * Build the deck: the core roles, the optional ones the host switched on, and
 * villagers for whatever is left. Throws if the choices do not fit.
 */
export function buildDeck(
  playerCount: number,
  options: Partial<Record<OnuwRole, boolean>> = {},
): OnuwRole[] {
  if (playerCount < MIN_PLAYERS || playerCount > MAX_PLAYERS) {
    throw new GameError('badPlayerCount', { min: MIN_PLAYERS, max: MAX_PLAYERS });
  }
  const size = playerCount + CENTRE_CARDS;
  const deck: OnuwRole[] = [];
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
export function roomForOptions(playerCount: number): number {
  return playerCount + CENTRE_CARDS - CORE_TOTAL;
}

/** A sensible deck for each table size, used as the lobby default. */
export function defaultOptions(playerCount: number): OnuwOptions {
  const wanted: OptionalOnuwRole[] = ['minion', 'drunk', 'insomniac', 'mason', 'tanner', 'hunter'];
  const options: Partial<OnuwOptions> = {};
  let left = roomForOptions(playerCount);
  for (const role of wanted) {
    const cost = copiesOf(role);
    if (cost <= left) { options[role] = true; left -= cost; }
  }
  return {
    minion: false, mason: false, drunk: false, insomniac: false, hunter: false, tanner: false,
    ...options,
  };
}

/**
 * Who wins, given the final cards, who died, and the house rules in force.
 *
 * The rulebook conditions this implements, in order:
 *  - the Tanner wins if the Tanner dies;
 *  - the village wins if at least one werewolf dies;
 *  - with no werewolf among the players, the village wins if nobody dies;
 *  - otherwise the werewolf team wins, unless the Tanner died — and with every
 *    werewolf card in the centre that falls to the Minion, who takes it only if
 *    the table lynched somebody other than him.
 *
 * Every other ending has no winner at all: a table that hangs an innocent with
 * no werewolf and no Minion in play has simply lost together.
 *
 * Under `decisiveVote` the third and fourth conditions change: with every
 * werewolf card in the centre the Minion *is* the pack, so his death is the
 * village's win however many die with him, and any other death hands the
 * werewolf side the win whether or not a Minion was dealt. Nothing else moves
 * — the Tanner still outranks both, and a table with a werewolf in it scores
 * exactly as it does by the book.
 */
export function decideWinners(
  finalRoles: Record<string, OnuwRole>,
  dead: Set<string>,
  house: { decisiveVote?: boolean } = {},
): Set<OnuwTeam> {
  const roleOf = (id: string) => finalRoles[id];
  const inPlay = (role: OnuwRole) => Object.keys(finalRoles).filter((id) => roleOf(id) === role);
  const died = (role: OnuwRole) => [...dead].some((id) => roleOf(id) === role);
  const wolvesInPlay = inPlay('werewolf');
  const tannerDied = died('tanner');
  // Who the village has to catch. Only a decisive vote ever promotes anybody.
  const pack = house.decisiveVote && wolvesInPlay.length === 0 ? 'minion' : 'werewolf';

  const winners = new Set<OnuwTeam>();
  if (tannerDied) winners.add('tanner');
  if (died(pack)) winners.add('village');
  else if (wolvesInPlay.length === 0 && dead.size === 0) winners.add('village');
  else if (tannerDied) { /* the Tanner's death costs the werewolf team the win */ }
  else if (wolvesInPlay.length > 0) winners.add('werewolf');
  else if (house.decisiveVote) winners.add('werewolf');   // an innocent hanged: the village lost
  else if (inPlay('minion').length && [...dead].some((id) => roleOf(id) !== 'minion')) {
    winners.add('werewolf');
  }
  return winners;
}

/**
 * Tally a round of voting. Everyone points at someone; the most-pointed-at
 * die. If every player collects exactly one vote, the table cannot agree and
 * nobody dies.
 */
export function tallyVotes(playerIds: string[], votes: Record<string, string>) {
  const counts = new Map(playerIds.map((id) => [id, 0]));
  for (const target of Object.values(votes)) {
    if (counts.has(target)) counts.set(target, (counts.get(target) ?? 0) + 1);
  }
  const top = Math.max(0, ...counts.values());
  const everyoneOnce = [...counts.values()].every((n) => n === 1);
  const dead = new Set(
    top === 0 || everyoneOnce ? [] : playerIds.filter((id) => counts.get(id) === top),
  );
  return { counts: Object.fromEntries(counts), dead, noDeaths: dead.size === 0 };
}
