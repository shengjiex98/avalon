import { z } from 'zod';

import {
  avalonActionSchema, createRoomSchema, joinSchema, onuwActionSchema,
} from '../contracts/actions.ts';
import type {
  AvalonAction, CreateRoomCommand, GameId, JoinCommand, OnuwAction, ValidatedAction,
} from '../contracts/actions.ts';
import { GameError } from './errors.ts';

const nonEmptyString = z.string().min(1);
const actionEnvelopeSchema = z.object({ type: nonEmptyString, playerId: nonEmptyString });
const actionTypes = {
  avalon: new Set(['setGame', 'leave', 'options', 'start', 'confirm', 'propose', 'vote', 'card', 'assassinate', 'reset', 'again']),
  onuw: new Set(['setGame', 'leave', 'options', 'start', 'confirm', 'night', 'startVote', 'vote', 'reset', 'again']),
};

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new GameError('badRequest');
  return result.data;
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
  return gameId === 'avalon'
    ? parse(avalonActionSchema, value)
    : parse(onuwActionSchema, value);
}

export const parseRoomCode = (value: unknown): string => parse(nonEmptyString, value).toUpperCase();
