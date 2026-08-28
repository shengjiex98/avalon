// HTTP and EventSource ownership. Replacing or leaving a room always closes
// the stream owned here before another one can be installed.

export class ApiError extends Error {
  constructor(key, params) {
    super(key);
    this.key = key;
    this.params = params;
  }
}

export function createTransport({ app, onMessage, onError }) {
  let source = null;
  let handlers = { onMessage, onError };

  async function request(path, options = {}) {
    let response;
    try {
      response = await fetch(app.server + path, {
        method: options.body ? 'POST' : 'GET',
        cache: 'no-store',
        headers: options.body ? { 'content-type': 'application/json' } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
    } catch {
      throw new ApiError('network', {});
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(data.error ?? 'serverError', data.params ?? {});
    return data;
  }

  function open(code, playerId) {
    close();
    const next = new EventSource(`${app.server}/api/rooms/${code}/events?playerId=${encodeURIComponent(playerId)}`);
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

  function setHandlers(next) {
    handlers = { ...handlers, ...next };
  }

  return { request, open, close, setHandlers };
}
