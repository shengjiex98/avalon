// @ts-check
// HTTP and EventSource ownership. Replacing or leaving a room always closes
// the stream owned here before another one can be installed.

/** @typedef {import('../src/contracts/actions.ts').ClientAction} ClientAction */
/** @typedef {import('../src/contracts/actions.ts').CreateRoomCommand} CreateRoomCommand */
/** @typedef {import('../src/contracts/actions.ts').JoinCommand} JoinCommand */
/** @typedef {import('../src/contracts/actions.ts').ValidatedAction} ValidatedAction */
/** @typedef {import('../src/contracts/views.ts').PublicView} PublicView */

/** @typedef {{ code: string }} CreateRoomResult */
/** @typedef {{ code: string, playerId: string }} JoinRoomResult */
/** @typedef {{ exists: boolean, seated: boolean }} RoomStatusResult */
/** @typedef {{ ok: true }} ActionResult */
/** @typedef {{ kind: 'ready', avatarGeneration: boolean } | { kind: 'protocolMismatch', expected: number, actual: number, avatarGeneration: boolean }} ProtocolResult */
/** @typedef {{ kind: 'reconnect' } | { kind: 'invalidResponse' }} StreamFailure */
/** @typedef {{ server: string | null, source: EventSource | null }} TransportApp */

export class ApiError extends Error {
  /** @param {string} key @param {Record<string, unknown>} params */
  constructor(key, params) {
    super(key);
    this.key = key;
    this.params = params;
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const hasString = (/** @type {Record<string, unknown>} */ value, /** @type {string} */ key) =>
  typeof value[key] === 'string';

/** @param {unknown} value @returns {CreateRoomResult} */
function createRoomResult(value) {
  if (!isRecord(value) || !hasString(value, 'code')) throw new ApiError('invalidResponse', {});
  return { code: String(value.code) };
}

/** @param {unknown} value @returns {JoinRoomResult} */
function joinRoomResult(value) {
  if (!isRecord(value) || !hasString(value, 'code') || !hasString(value, 'playerId')) {
    throw new ApiError('invalidResponse', {});
  }
  return { code: String(value.code), playerId: String(value.playerId) };
}

/** @param {unknown} value @returns {RoomStatusResult} */
function roomStatusResult(value) {
  if (!isRecord(value) || typeof value.exists !== 'boolean' || typeof value.seated !== 'boolean') {
    throw new ApiError('invalidResponse', {});
  }
  return { exists: value.exists, seated: value.seated };
}

/** @param {unknown} value @returns {ActionResult} */
function actionResult(value) {
  if (!isRecord(value) || value.ok !== true) throw new ApiError('invalidResponse', {});
  return { ok: true };
}

/**
 * This is the browser's single trust assertion for a server-built view. The
 * envelope and both discriminants are checked first; renderers own the exact
 * fields of the resulting shared union.
 * @param {unknown} value
 * @returns {PublicView}
 */
function publicViewResult(value) {
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
  return /** @type {PublicView} */ (response);
}

/**
 * @param {{
 *   app: TransportApp,
 *   onMessage?: (view: PublicView) => void,
 *   onError?: (failure: StreamFailure) => void,
 * }} deps
 */
export function createTransport({ app, onMessage, onError }) {
  /** @type {EventSource | null} */
  let source = null;
  let handlers = { onMessage, onError };

  /**
   * @template T
   * @param {string} path
   * @param {(value: unknown) => T} parse
   * @param {{ body?: CreateRoomCommand | JoinCommand | ValidatedAction }} [options]
   * @returns {Promise<T>}
   */
  async function request(path, parse, options = {}) {
    let response;
    try {
      /** @type {RequestInit} */
      const init = options.body
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
    /** @type {unknown} */
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (isRecord(data) && typeof data.error === 'string') {
        const params = isRecord(data.params) ? data.params : {};
        throw new ApiError(data.error, params);
      }
      throw new ApiError('serverError', {});
    }
    return parse(data);
  }

  /** @param {CreateRoomCommand} body */
  const createRoom = (body) => request('/api/rooms', createRoomResult, { body });
  /** @param {string} code @param {JoinCommand} body */
  const joinRoom = (code, body) => request(`/api/rooms/${code}/join`, joinRoomResult, { body });
  /** @param {string} code @param {string} playerId */
  const roomStatus = (code, playerId) => request(
    `/api/rooms/${code}?playerId=${encodeURIComponent(playerId)}`, roomStatusResult,
  );
  /** @param {string} code @param {string} playerId @param {ClientAction} action */
  const action = (code, playerId, action) => request(`/api/rooms/${code}/action`, actionResult, {
    body: { ...action, playerId },
  });

  /** @param {number} expected @returns {Promise<ProtocolResult>} */
  async function probeProtocol(expected) {
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

  /** @param {string} url @returns {Promise<string | null>} */
  async function latestVersion(url) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) return null;
      /** @type {unknown} */
      const value = await response.json();
      return isRecord(value) && typeof value.version === 'string' && value.version
        ? value.version
        : null;
    } catch {
      return null;
    }
  }

  /** @param {string} code @param {string} playerId */
  function open(code, playerId) {
    close();
    const next = new EventSource(`${app.server ?? ''}/api/rooms/${code}/events?playerId=${encodeURIComponent(playerId)}`);
    source = next;
    app.source = next; // compatibility surface used by the DOM-shim tests
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

  /** @param {Partial<typeof handlers>} next */
  function setHandlers(next) {
    handlers = { ...handlers, ...next };
  }

  return {
    createRoom, joinRoom, roomStatus, action, probeProtocol, latestVersion,
    open, close, setHandlers,
  };
}
