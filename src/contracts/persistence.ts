import { z } from 'zod';

import { persistedOnuwNightActionSchema } from './actions.ts';

const finiteNumber = z.number().finite();
const nonNegativeInteger = z.number().int().min(0);
const stringRecord = z.record(z.string(), z.string());
const booleanRecord = z.record(z.string(), z.boolean());
const paramsSchema = z.record(z.string(), z.unknown());

export const playerSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1).max(24),
  avatar: z.string().optional(),
});
export type Player = z.infer<typeof playerSchema>;

export const logEntrySchema = z.strictObject({
  key: z.string(), params: paramsSchema, at: finiteNumber,
});
export type LogEntry = z.infer<typeof logEntrySchema>;

export const journalEntrySchema = z.strictObject({
  t: z.string(), p: z.string(), b: paramsSchema, at: finiteNumber,
});
export type JournalEntry = z.infer<typeof journalEntrySchema>;

export const gameEventSchema = z.strictObject({ key: z.string(), params: paramsSchema });
export type GameEvent = z.infer<typeof gameEventSchema>;

const avalonRoleSchema = z.enum([
  'merlin', 'percival', 'servant', 'assassin', 'morgana', 'mordred', 'oberon', 'minion',
]);
const avalonOptionsSchema = z.strictObject({
  percival: z.boolean(), morgana: z.boolean(), mordred: z.boolean(), oberon: z.boolean(),
});
const avalonHouseRulesSchema = z.strictObject({
  randomLeader: z.boolean(), hiddenVotes: z.boolean(), resetRejects: z.boolean(),
});
const avalonVoteSchema = z.strictObject({
  round: nonNegativeInteger,
  attempt: z.number().int().min(1),
  team: z.array(z.string()),
  votes: booleanRecord,
  approved: z.boolean(),
});
const avalonQuestSchema = z.strictObject({
  round: nonNegativeInteger,
  team: z.array(z.string()),
  fails: nonNegativeInteger,
  success: z.boolean(),
});
const avalonStateShape = {
  options: avalonOptionsSchema,
  optionsTouched: z.boolean(),
  houseRules: avalonHouseRulesSchema,
  roles: z.record(z.string(), avalonRoleSchema),
  round: z.number().int().min(0).max(4),
  leaderIndex: nonNegativeInteger,
  rejects: nonNegativeInteger,
  team: z.array(z.string()),
  votes: booleanRecord,
  lastVote: avalonVoteSchema.nullable(),
  cards: booleanRecord,
  quests: z.array(avalonQuestSchema),
  assassinTarget: z.string().nullable(),
  winner: z.enum(['good', 'evil']).nullable(),
  winReason: z.string().nullable(),
  ready: booleanRecord.optional(),
};

export const avalonStateSchema = z.discriminatedUnion('phase', [
  z.strictObject({ phase: z.literal('lobby'), ...avalonStateShape }),
  z.strictObject({ phase: z.literal('reveal'), ...avalonStateShape }),
  z.strictObject({ phase: z.literal('team'), ...avalonStateShape }),
  z.strictObject({ phase: z.literal('vote'), ...avalonStateShape }),
  z.strictObject({ phase: z.literal('quest'), ...avalonStateShape }),
  z.strictObject({ phase: z.literal('assassin'), ...avalonStateShape }),
  z.strictObject({ phase: z.literal('over'), ...avalonStateShape }),
]);
export type AvalonState = z.infer<typeof avalonStateSchema>;

const onuwRoleSchema = z.enum([
  'werewolf', 'minion', 'mason', 'seer', 'robber', 'troublemaker',
  'drunk', 'insomniac', 'hunter', 'tanner', 'villager',
]);
const onuwOptionsSchema = z.strictObject({
  minion: z.boolean(), mason: z.boolean(), drunk: z.boolean(), insomniac: z.boolean(),
  hunter: z.boolean(), tanner: z.boolean(),
});
const onuwHouseRulesSchema = z.strictObject({ decisiveVote: z.boolean() });
const onuwScriptStepSchema = z.strictObject({
  key: z.string(), role: onuwRoleSchema.optional(), seconds: z.number().finite().positive(),
});
const onuwStateShape = {
  options: onuwOptionsSchema,
  optionsTouched: z.boolean(),
  houseRules: onuwHouseRulesSchema,
  pace: z.enum(['brisk', 'normal', 'relaxed']),
  script: z.array(onuwScriptStepSchema),
  step: z.number().int(),
  stepEndsAt: finiteNumber,
  ready: booleanRecord,
  startRoles: z.record(z.string(), onuwRoleSchema),
  centreStart: z.array(onuwRoleSchema),
  finalRoles: z.record(z.string(), onuwRoleSchema),
  centre: z.array(onuwRoleSchema),
  nightActions: z.record(z.string(), persistedOnuwNightActionSchema),
  info: z.record(z.string(), z.array(gameEventSchema)),
  swaps: z.array(gameEventSchema),
  votes: stringRecord,
  dead: z.array(z.string()),
  winners: z.array(z.enum(['village', 'werewolf', 'tanner'])),
};

export const onuwStateSchema = z.discriminatedUnion('phase', [
  z.strictObject({ phase: z.literal('lobby'), ...onuwStateShape }),
  z.strictObject({ phase: z.literal('reveal'), ...onuwStateShape }),
  z.strictObject({ phase: z.literal('night'), ...onuwStateShape }),
  z.strictObject({ phase: z.literal('day'), ...onuwStateShape }),
  z.strictObject({ phase: z.literal('vote'), ...onuwStateShape }),
  z.strictObject({ phase: z.literal('over'), ...onuwStateShape }),
]);
export type OnuwState = z.infer<typeof onuwStateSchema>;

const roomShape = {
  code: z.string().regex(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/),
  createdAt: finiteNumber,
  players: z.array(playerSchema),
  hostId: z.string().nullable(),
  log: z.array(logEntrySchema),
  seed: z.number().int().min(0).max(0xffffffff),
  rng: z.number().int().min(0).max(0xffffffff),
  revision: nonNegativeInteger,
  journal: z.array(journalEntrySchema),
  journalDropped: z.literal(true).optional(),
  touchedAt: finiteNumber,
};

const avalonRoomSchema = z.strictObject({
  ...roomShape,
  game: z.strictObject({ id: z.literal('avalon'), state: avalonStateSchema }),
});
export type AvalonPersistedRoom = z.infer<typeof avalonRoomSchema>;
const onuwRoomSchema = z.strictObject({
  ...roomShape,
  game: z.strictObject({ id: z.literal('onuw'), state: onuwStateSchema }),
});
export type OnuwPersistedRoom = z.infer<typeof onuwRoomSchema>;

export const persistedRoomSchema = z.union([avalonRoomSchema, onuwRoomSchema]);
export const persistedRoomsSchema = z.array(persistedRoomSchema);
export type PersistedRoom = z.infer<typeof persistedRoomSchema>;

export const snapshotFileSchema = z.strictObject({
  stateVersion: z.number().int().min(1),
  savedAt: finiteNumber,
  rooms: persistedRoomsSchema,
});
export type SnapshotFile = z.infer<typeof snapshotFileSchema>;
