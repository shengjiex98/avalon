// HTTP and EventSource ownership. Replacing or leaving a room always closes
// the stream owned here before another one can be installed.

import type {
  ClientAction, CreateRoomCommand, JoinCommand, ValidatedAction,
} from '../contracts/actions.ts';
import type { PublicView } from '../contracts/views.ts';

type CreateRoomResult = { code: string };
type JoinRoomResult = { code: string; playerId: string };
type RoomStatusResult = { exists: boolean; seated: boolean };
type ActionResult = { ok: true };
type ProtocolResult =
  | { kind: 'ready'; avatarGeneration: boolean }
  | { kind: 'protocolMismatch'; expected: number; actual: number; avatarGeneration: boolean };
type StreamFailure = { kind: 'reconnect' } | { kind: 'invalidResponse' };
type TransportApp = { server: string | null; source: EventSource | null };
type RequestBody = CreateRoomCommand | JoinCommand | ValidatedAction;
type Handlers = {
  onMessage?: (view: PublicView) => void;
  onError?: (failure: StreamFailure) => void;
};

export class ApiError extends Error {
  readonly key: string;
  readonly params: Record<string, unknown>;

  constructor(key: string, params: Record<string, unknown>) {
    super(key);
    this.key = key;
    this.params = params;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const hasString = (value: Record<string, unknown>, key: string) =>
  typeof value[key] === 'string';

function createRoomResult(value: unknown): CreateRoomResult {
  if (!isRecord(value) || !hasString(value, 'code')) throw new ApiError('invalidResponse', {});
  return { code: String(value.code) };
}

function joinRoomResult(value: unknown): JoinRoomResult {
  if (!isRecord(value) || !hasString(value, 'code') || !hasString(value, 'playerId')) {
    throw new ApiError('invalidResponse', {});
  }
  return { code: String(value.code), playerId: String(value.playerId) };
}

function roomStatusResult(value: unknown): RoomStatusResult {
  if (!isRecord(value) || typeof value.exists !== 'boolean' || typeof value.seated !== 'boolean') {
    throw new ApiError('invalidResponse', {});
  }
  return { exists: value.exists, seated: value.seated };
}

function actionResult(value: unknown): ActionResult {
  if (!isRecord(value) || value.ok !== true) throw new ApiError('invalidResponse', {});
  return { ok: true };
}

/**
 * This is the browser's single trust assertion for a server-built view. The
 * envelope and both discriminants are checked first; renderers own the exact
 * fields of the resulting shared union.
 */
function publicViewResult(value: unknown): PublicView {
  const response = value;
  if (!isRecord(value)
      || !hasString(value, 'code')
      || typeof value.version !== 'number'
      || !(value.hostId === null || typeof value.hostId === 'string')
      || !(value.me === null || isRecord(value.me))
      || !Array.isArray(value.players)
      || !Array.isArray(value.log)
      || !isRecord(value.setup)) {
    throw new ApiError('invalidResponse', {});
  }
  const phases = value.gameId === 'avalon'
    ? ['lobby', 'reveal', 'team', 'vote', 'quest', 'assassin', 'over']
    : value.gameId === 'onuw'
      ? ['lobby', 'reveal', 'night', 'day', 'vote', 'over']
      : null;
  if (!phases || typeof value.phase !== 'string' || !phases.includes(value.phase)) {
    throw new ApiError('invalidResponse', {});
  }
  return response as PublicView;
}

export function createTransport({ app, onMessage, onError }: { app: TransportApp } & Handlers) {
  let source: EventSource | null = null;
  let handlers: Handlers = {};
  if (onMessage) handlers.onMessage = onMessage;
  if (onError) handlers.onError = onError;

  async function request<T>(
    path: string,
    parse: (value: unknown) => T,
    options: { body?: RequestBody } = {},
  ): Promise<T> {
    let response;
    try {
      const init: RequestInit = options.body
        ? {
            method: 'POST',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(options.body),
          }
        : { method: 'GET', cache: 'no-store' };
      response = await fetch((app.server ?? '') + path, init);
    } catch {
      throw new ApiError('network', {});
    }
    const data: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (isRecord(data) && typeof data.error === 'string') {
        const params = isRecord(data.params) ? data.params : {};
        throw new ApiError(data.error, params);
      }
      throw new ApiError('serverError', {});
    }
    return parse(data);
  }

  const createRoom = (body: CreateRoomCommand) => request('/api/rooms', createRoomResult, { body });
  const joinRoom = (code: string, body: JoinCommand) =>
    request(`/api/rooms/${code}/join`, joinRoomResult, { body });
  const roomStatus = (code: string, playerId: string) => request(
    `/api/rooms/${code}?playerId=${encodeURIComponent(playerId)}`, roomStatusResult,
  );
  const action = (code: string, playerId: string, action: ClientAction) =>
    request(`/api/rooms/${code}/action`, actionResult, {
    body: { ...action, playerId },
  });

  async function probeProtocol(expected: number): Promise<ProtocolResult> {
    const result = await request('/api/health', (value) => {
      if (!isRecord(value) || value.service !== 'avalon' || typeof value.protocol !== 'number') {
        throw new ApiError('invalidResponse', {});
      }
      return {
        protocol: value.protocol,
        avatarGeneration: Boolean(value.avatarGeneration),
      };
    });
    return result.protocol === expected
      ? { kind: 'ready', avatarGeneration: result.avatarGeneration }
      : {
          kind: 'protocolMismatch', expected, actual: result.protocol,
          avatarGeneration: result.avatarGeneration,
        };
  }

  async function latestVersion(url: string): Promise<string | null> {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) return null;
      const value: unknown = await response.json();
      return isRecord(value) && typeof value.version === 'string' && value.version
        ? value.version
        : null;
    } catch {
      return null;
    }
  }

  function open(code: string, playerId: string) {
    close();
    const next = new EventSource(`${app.server ?? ''}/api/rooms/${code}/events?playerId=${encodeURIComponent(playerId)}`);
    source = next;
    app.source = next; // Exposed so the DOM-shim tests can drive stream events.
    next.onmessage = (event) => {
      if (source !== next) return;
      try {
        handlers.onMessage?.(publicViewResult(JSON.parse(event.data)));
      } catch {
        next.close();
        handlers.onError?.({ kind: 'invalidResponse' });
      }
    };
    next.onerror = () => {
      if (source !== next) return;
      next.close();
      handlers.onError?.({ kind: 'reconnect' });
    };
    return next;
  }

  function close() {
    source?.close();
    source = null;
    app.source = null;
  }

  function setHandlers(next: Partial<Handlers>) {
    handlers = { ...handlers, ...next };
  }

  return {
    createRoom, joinRoom, roomStatus, action, probeProtocol, latestVersion,
    open, close, setHandlers,
  };
}
