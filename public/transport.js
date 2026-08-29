// @ts-check
// HTTP and EventSource ownership. Replacing or leaving a room always closes
// the stream owned here before another one can be installed.

/** @typedef {import('../src/contracts/types.ts').CreateRoomCommand} CreateRoomCommand */
/** @typedef {import('../src/contracts/types.ts').JoinCommand} JoinCommand */
/** @typedef {import('../src/contracts/types.ts').ValidatedAction} ValidatedAction */

// Every body this client is allowed to put on the wire. Naming the union here
// is what makes a request the compiler can check against the server's own
// contract, rather than whatever object a caller happened to build.
/** @typedef {CreateRoomCommand | JoinCommand | ValidatedAction} RequestBody */

/** @typedef {{ server: string | null, source: EventSource | null }} TransportApp */

export class ApiError extends Error {
  /** @param {string} key @param {Record<string, unknown>} params */
  constructor(key, params) {
    super(key);
    this.key = key;
    this.params = params;
  }
}

/**
 * @param {{
 *   app: TransportApp,
 *   onMessage?: (view: any) => void,
 *   onError?: () => void,
 * }} deps
 */
export function createTransport({ app, onMessage, onError }) {
  /** @type {EventSource | null} */
  let source = null;
  let handlers = { onMessage, onError };

  /**
   * @param {string} path
   * @param {{ body?: RequestBody }} [options]
   * @returns {Promise<any>} whatever the endpoint answered, still unvalidated
   */
  async function request(path, options = {}) {
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
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(data.error ?? 'serverError', data.params ?? {});
    return data;
  }

  /** @param {string} code @param {string} playerId */
  function open(code, playerId) {
    close();
    const next = new EventSource(`${app.server ?? ''}/api/rooms/${code}/events?playerId=${encodeURIComponent(playerId)}`);
    source = next;
    app.source = next; // compatibility surface used by the DOM-shim tests
    next.onmessage = (event) => {
      if (source === next) handlers.onMessage?.(JSON.parse(event.data));
    };
    next.onerror = () => {
      if (source !== next) return;
      next.close();
      handlers.onError?.();
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

  return { request, open, close, setHandlers };
}