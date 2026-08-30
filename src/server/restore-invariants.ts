import type { AvalonPersistedRoom, OnuwPersistedRoom, PersistedRoom } from '../contracts/persistence.ts';

const unique = <T>(values: T[]): boolean => new Set(values).size === values.length;
const keysIn = (value: object, ids: Set<string>): boolean => Object.keys(value).every((id) => ids.has(id));
const idsIn = (values: string[], ids: Set<string>): boolean => values.every((id) => ids.has(id));

function validEnvelope(room: PersistedRoom, ids: Set<string>): boolean {
  const names = room.players.map((player) => player.name.toLowerCase());
  return unique([...ids])
    && unique(names)
    && (room.hostId === null || ids.has(room.hostId))
    && ((room.players.length === 0) === (room.hostId === null));
}

function validAvalon(room: AvalonPersistedRoom, ids: Set<string>): boolean {
  const state = room.game.state;
  if (room.players.length > 10 || (state.phase !== 'lobby' && room.players.length < 5)) return false;
  if (room.players.length && state.leaderIndex >= room.players.length) return false;
  if (!idsIn(state.team, ids) || !unique(state.team)) return false;
  if (!keysIn(state.roles, ids) || !keysIn(state.votes, ids) || !keysIn(state.cards, ids)) return false;
  if (!keysIn(state.ready ?? {}, ids)) return false;
  if (state.lastVote && (!idsIn(state.lastVote.team, ids) || !unique(state.lastVote.team)
      || !keysIn(state.lastVote.votes, ids))) return false;
  for (const quest of state.quests) {
    if (!idsIn(quest.team, ids) || !unique(quest.team)) return false;
  }
  if (state.assassinTarget !== null && !ids.has(state.assassinTarget)) return false;
  if ((state.phase === 'over') !== (state.winner !== null && state.winReason !== null)) return false;
  if (state.phase === 'lobby' && Object.keys(state.roles).length) return false;
  return state.phase === 'lobby' || Object.keys(state.roles).length === ids.size;
}

function validOnuw(room: OnuwPersistedRoom, ids: Set<string>): boolean {
  const state = room.game.state;
  if (room.players.length > 10 || (state.phase !== 'lobby' && room.players.length < 3)) return false;
  if (!keysIn(state.ready, ids) || !keysIn(state.startRoles, ids) || !keysIn(state.finalRoles, ids)) return false;
  if (!keysIn(state.nightActions, ids) || !keysIn(state.info, ids) || !keysIn(state.votes, ids)) return false;
  if (!Object.values(state.votes).every((id) => ids.has(id))) return false;
  if (!idsIn(state.dead, ids) || !unique(state.dead)) return false;
  if (state.phase === 'lobby' && (Object.keys(state.startRoles).length || state.centreStart.length)) return false;
  if (state.phase !== 'lobby' && Object.keys(state.startRoles).length !== ids.size) return false;
  if (state.phase !== 'lobby' && (state.centreStart.length !== 3 || state.centre.length !== 3)) return false;
  return state.phase !== 'night' || (state.step >= 0 && state.step < state.script.length);
}

export function validateRestoreInvariants(room: PersistedRoom): boolean {
  const ids = new Set(room.players.map((player) => player.id));
  if (!validEnvelope(room, ids)) return false;
  if (isAvalonRoom(room)) return validAvalon(room, ids);
  return validOnuw(room, ids);
}

function isAvalonRoom(room: PersistedRoom): room is AvalonPersistedRoom {
  return room.game.id === 'avalon';
}
