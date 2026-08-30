import { z } from 'zod';

import { GameError } from '../lobby.ts';

const nonEmptyString = z.string().min(1);
const playerAction = { playerId: nonEmptyString };

export const gameIdSchema = z.enum(['avalon', 'onuw']);
export type GameId = z.infer<typeof gameIdSchema>;

export const createRoomSchema = z.object({ game: nonEmptyString.optional() });
export type CreateRoomCommand = z.infer<typeof createRoomSchema>;

export const joinSchema = z.object({
  name: z.string(),
  playerId: z.preprocess((value) => value === null ? undefined : value, nonEmptyString.optional()),
  avatar: z.union([z.string(), z.literal(false)]).optional(),
});
export type JoinCommand = z.infer<typeof joinSchema>;

const avalonOptionsSchema = z.object({
  percival: z.boolean().optional(),
  morgana: z.boolean().optional(),
  mordred: z.boolean().optional(),
  oberon: z.boolean().optional(),
  houseRules: z.object({
    randomLeader: z.boolean().optional(),
    hiddenVotes: z.boolean().optional(),
    resetRejects: z.boolean().optional(),
  }).optional(),
});

const onuwOptionsSchema = z.object({
  minion: z.boolean().optional(),
  mason: z.boolean().optional(),
  drunk: z.boolean().optional(),
  insomniac: z.boolean().optional(),
  hunter: z.boolean().optional(),
  tanner: z.boolean().optional(),
  pace: z.enum(['brisk', 'normal', 'relaxed']).optional(),
  houseRules: z.object({ decisiveVote: z.boolean().optional() }).optional(),
});

const sharedActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('setGame'), ...playerAction, game: nonEmptyString }),
  z.object({ type: z.literal('leave'), ...playerAction }),
]);

const avalonGameActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('options'), ...playerAction, options: avalonOptionsSchema }),
  z.object({ type: z.literal('start'), ...playerAction }),
  z.object({ type: z.literal('confirm'), ...playerAction }),
  z.object({ type: z.literal('propose'), ...playerAction, team: z.array(nonEmptyString) }),
  z.object({ type: z.literal('vote'), ...playerAction, approve: z.boolean() }),
  z.object({ type: z.literal('card'), ...playerAction, success: z.boolean() }),
  z.object({ type: z.literal('assassinate'), ...playerAction, target: nonEmptyString }),
  z.object({ type: z.literal('reset'), ...playerAction }),
  z.object({ type: z.literal('again'), ...playerAction }),
]);

const modePlayerNightAction = { mode: z.literal('player'), target: nonEmptyString };
const modeCentreNightAction = {
  mode: z.literal('centre'), centres: z.tuple([z.number().int(), z.number().int()]),
};
const skipNightAction = { skip: z.literal(true) };
const centreNightAction = { centre: z.number().int() };
const targetNightAction = { target: nonEmptyString };
const targetsNightAction = { targets: z.tuple([nonEmptyString, nonEmptyString]) };
const noMode = { mode: z.never().optional() };
export const onuwNightActionSchema = z.union([
  z.object(modePlayerNightAction),
  z.object(modeCentreNightAction),
  z.object({ ...noMode, ...skipNightAction }),
  z.object({ ...noMode, ...centreNightAction }),
  z.object({ ...noMode, ...targetNightAction }),
  z.object({ ...noMode, ...targetsNightAction }),
]);
export const persistedOnuwNightActionSchema = z.union([
  z.strictObject(modePlayerNightAction),
  z.strictObject(modeCentreNightAction),
  z.strictObject(skipNightAction),
  z.strictObject(centreNightAction),
  z.strictObject(targetNightAction),
  z.strictObject(targetsNightAction),
]);
export type OnuwNightAction = z.infer<typeof persistedOnuwNightActionSchema>;

const onuwGameActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('options'), ...playerAction, options: onuwOptionsSchema }),
  z.object({ type: z.literal('start'), ...playerAction }),
  z.object({ type: z.literal('confirm'), ...playerAction }),
  z.object({ type: z.literal('night'), ...playerAction, action: onuwNightActionSchema }),
  z.object({ type: z.literal('startVote'), ...playerAction }),
  z.object({ type: z.literal('vote'), ...playerAction, target: nonEmptyString }),
  z.object({ type: z.literal('reset'), ...playerAction }),
  z.object({ type: z.literal('again'), ...playerAction }),
]);

export const avalonActionSchema = z.union([sharedActionSchema, avalonGameActionSchema]);
export const onuwActionSchema = z.union([sharedActionSchema, onuwGameActionSchema]);
export type AvalonAction = z.infer<typeof avalonActionSchema>;
export type OnuwAction = z.infer<typeof onuwActionSchema>;
export type ValidatedAction = AvalonAction | OnuwAction;
type WithoutActor<T> = T extends { playerId: string } ? Omit<T, 'playerId'> : never;
export type AvalonClientAction = WithoutActor<AvalonAction>;
export type OnuwClientAction = WithoutActor<OnuwAction>;
export type ClientAction = AvalonClientAction | OnuwClientAction;

const actionEnvelopeSchema = z.object({ type: nonEmptyString, playerId: nonEmptyString });
const actionTypes = {
  avalon: new Set(['setGame', 'leave', 'options', 'start', 'confirm', 'propose', 'vote', 'card', 'assassinate', 'reset', 'again']),
  onuw: new Set(['setGame', 'leave', 'options', 'start', 'confirm', 'night', 'startVote', 'vote', 'reset', 'again']),
};

const badRequest = (): never => { throw new GameError('badRequest'); };

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  return result.success ? result.data : badRequest();
}

export const parseCreateRoom = (value: unknown): CreateRoomCommand => parse(createRoomSchema, value);
export const parseJoin = (value: unknown): JoinCommand => parse(joinSchema, value);

export function parseAction(gameId: 'avalon', value: unknown): AvalonAction;
export function parseAction(gameId: 'onuw', value: unknown): OnuwAction;
export function parseAction(gameId: GameId, value: unknown): ValidatedAction;
export function parseAction(gameId: GameId, value: unknown): ValidatedAction {
  const envelope = parse(actionEnvelopeSchema, value);
  if (!actionTypes[gameId].has(envelope.type)) {
    throw new GameError('unknownAction', { type: envelope.type });
  }
  if (gameId === 'avalon') return parse(avalonActionSchema, value);
  return parse(onuwActionSchema, value);
}

export const parseRoomCode = (value: unknown): string => parse(z.string().min(1), value).toUpperCase();
