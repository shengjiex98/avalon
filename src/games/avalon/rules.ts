import { GameError } from '../../lobby.ts';

// Static rules of The Resistance: Avalon. No state, no I/O.

/**
 * Per player-count setup: evil count and the team size of each of the 5 quests.
 * Quest 4 needs two fail cards in games of 7 or more players.
 */
type Setup = { evil: number; teamSizes: number[] };
export const SETUPS: Record<number, Setup> = {
  5:  { evil: 2, teamSizes: [2, 3, 2, 3, 3] },
  6:  { evil: 2, teamSizes: [2, 3, 4, 3, 4] },
  7:  { evil: 3, teamSizes: [2, 3, 3, 4, 4] },
  8:  { evil: 3, teamSizes: [3, 4, 4, 5, 5] },
  9:  { evil: 3, teamSizes: [3, 4, 4, 5, 5] },
  10: { evil: 4, teamSizes: [3, 4, 4, 5, 5] },
};

export const MIN_PLAYERS = 5;
export const MAX_PLAYERS = 10;
export const MAX_REJECTS = 5; // fifth rejection hands the game to evil

/** Roles. `optional` roles are chosen in the lobby; the rest fill the remaining seats. */
export const ROLES = {
  merlin:     { side: 'good', optional: false, unique: true },
  percival:   { side: 'good', optional: true,  unique: true },
  servant:    { side: 'good', optional: false, unique: false },
  assassin:   { side: 'evil', optional: false, unique: true },
  morgana:    { side: 'evil', optional: true,  unique: true },
  mordred:    { side: 'evil', optional: true,  unique: true },
  oberon:     { side: 'evil', optional: true,  unique: true },
  minion:     { side: 'evil', optional: false, unique: false },
} as const;

export type AvalonRole = keyof typeof ROLES;
export type AvalonSide = (typeof ROLES)[AvalonRole]['side'];
export type OptionalAvalonRole = {
  [Role in AvalonRole]: (typeof ROLES)[Role]['optional'] extends true ? Role : never
}[AvalonRole];
export type AvalonOptions = Record<OptionalAvalonRole, boolean>;
const ROLE_KEYS = Object.keys(ROLES) as AvalonRole[];

export const OPTIONAL_ROLES = ROLE_KEYS.filter(
  (role): role is OptionalAvalonRole => ROLES[role].optional,
);

export const sideOf = (role: AvalonRole): AvalonSide => ROLES[role].side;

/**
 * The deck a table of this size plays unless the host says otherwise: the
 * standard setup, Percival opposite Morgana at every count, with Oberon and
 * Mordred joining as the evil side gains seats. Nothing here is a rule — it is
 * what a table would have picked anyway, so nobody has to pick it.
 */
const DEFAULT_OPTIONS: Record<number, AvalonRole[]> = {
  5:  ['percival', 'morgana'],
  6:  ['percival', 'morgana'],
  7:  ['percival', 'morgana', 'oberon'],
  8:  ['percival', 'morgana'],
  9:  ['percival', 'morgana', 'mordred'],
  10: ['percival', 'morgana', 'mordred', 'oberon'],
};

/** The optional roles a table of this size starts with. */
export function defaultOptions(playerCount: number): AvalonOptions {
  const wanted = DEFAULT_OPTIONS[playerCount] ?? [];
  return Object.fromEntries(OPTIONAL_ROLES.map((r) => [r, wanted.includes(r)])) as AvalonOptions;
}

/**
 * House rules: variants a table may agree to before the cards come out. Each
 * value is how a new table plays unless the host says otherwise, and all three
 * start off — the printed game is the default, and a variant has to be chosen.
 *
 * `randomLeader` shuffles the seating and drops the leader token anywhere in
 * it. Off, seats keep the order people joined in and the host leads first,
 * which is what a table around a real table does. Either way the roles are
 * dealt from a shuffled deck, so seating never says anything about who is who.
 *
 * `hiddenVotes` publishes the tally and nothing else. The table still learns
 * how many approved and how many rejected — that is what decides the mission —
 * but never who voted which way, which is the read most of the game's talking
 * is built on.
 *
 * `resetRejects` clears the rejection count whenever a team is approved. With
 * it off, rejected proposals accumulate across the whole game and the fifth
 * hands evil the match. With it on, evil needs five rejections without an
 * approved team in between.
 */
export const HOUSE_RULES = { randomLeader: false, hiddenVotes: false, resetRejects: false };
export const HOUSE_RULE_KEYS = Object.keys(HOUSE_RULES);

/** How many fail cards this quest needs to fail. */
export function failsRequired(playerCount: number, round: number): number {
  return playerCount >= 7 && round === 3 ? 2 : 1;
}

export function teamSize(playerCount: number, round: number): number | undefined {
  return SETUPS[playerCount]?.teamSizes[round];
}

/**
 * Which other players a role sees, and what it learns about them.
 * Returns [{ playerId, hint }] where `hint` is an i18n key suffix, so the
 * server never has to know what language a client renders in.
 */
export function knowledgeFor(viewerId: string, roles: Record<string, AvalonRole>) {
  const role = roles[viewerId];
  const entries = Object.entries(roles).filter(([id]) => id !== viewerId);
  const out: Array<{ playerId: string; hint: string }> = [];

  if (role === 'merlin') {
    // Merlin sees evil, but Mordred hides from him.
    for (const [id, r] of entries) {
      if (sideOf(r) === 'evil' && r !== 'mordred') out.push({ playerId: id, hint: 'evil' });
    }
  } else if (role === 'percival') {
    // Merlin and Morgana look identical to Percival.
    for (const [id, r] of entries) {
      if (r === 'merlin' || r === 'morgana') out.push({ playerId: id, hint: 'merlinOrMorgana' });
    }
  } else if (role && sideOf(role) === 'evil' && role !== 'oberon') {
    // Evil recognise each other; Oberon is alone on both sides of that.
    for (const [id, r] of entries) {
      if (sideOf(r) === 'evil' && r !== 'oberon') out.push({ playerId: id, hint: 'evil' });
    }
  }
  return out.sort((a, b) => a.playerId.localeCompare(b.playerId));
}

/**
 * Build the role list for a game. Throws if the requested optional roles do
 * not fit the player count.
 */
export function buildRoleList(
  playerCount: number,
  options: Partial<Record<AvalonRole, boolean>> = {},
): AvalonRole[] {
  const setup = SETUPS[playerCount];
  if (!setup) throw new GameError('badPlayerCount', { min: MIN_PLAYERS, max: MAX_PLAYERS });

  const evilCount = setup.evil;
  const goodCount = playerCount - evilCount;

  const good: AvalonRole[] = ['merlin'];
  if (options.percival) good.push('percival');

  const evil: AvalonRole[] = ['assassin'];
  for (const role of ['morgana', 'mordred', 'oberon'] as const) if (options[role]) evil.push(role);

  if (good.length > goodCount) throw new GameError('tooManyGoodRoles', { max: goodCount });
  if (evil.length > evilCount) throw new GameError('tooManyEvilRoles', { max: evilCount });

  while (good.length < goodCount) good.push('servant');
  while (evil.length < evilCount) evil.push('minion');

  return [...good, ...evil];
}

export { GameError };
