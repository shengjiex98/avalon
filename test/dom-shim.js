// A DOM small enough to render the client into, and no smaller. It exists so
// the interface is tested rather than shipped blind: there is no browser on
// the machine this runs on, and layout bugs are still bugs.

class TextNode {
  constructor(text) { this.nodeType = 3; this.data = String(text); }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

class Element {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.className = '';
    this.id = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.open = false;
    this.scrollTop = 0;
    this.parentNode = null;
  }

  append(...kids) {
    for (const kid of kids) { kid.parentNode = this; this.childNodes.push(kid); }
  }

  replaceChildren(...kids) {
    for (const kid of this.childNodes) kid.parentNode = null;
    this.childNodes = [];
    this.append(...kids);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'class') this.className = String(value);
    if (name === 'id') this.id = String(value);
    if (name === 'value') this.value = String(value);
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase());
      this.dataset[key] = String(value);
    }
  }

  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  /** Scroll the way a user would, so listeners see the new offset. */
  scrollTo_(top) { this.scrollTop = top; this.dispatch('scroll'); }

  /** Fire a listener the way a user would. Returns false if nothing is bound. */
  dispatch(type, event = {}) {
    const bound = this.listeners.get(type) ?? [];
    for (const fn of bound) fn({ type, target: this, preventDefault() {}, ...event });
    return bound.length > 0;
  }

  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { this.focused = true; }

  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) {
    this.childNodes = [];
    if (v !== '' && v !== null && v !== undefined) this.append(new TextNode(v));
  }

  /** Depth-first walk over this element and its descendants. */
  *walk() {
    yield this;
    for (const kid of this.childNodes) if (kid.nodeType === 1) yield* kid.walk();
  }

  find(predicate) { for (const node of this.walk()) if (predicate(node)) return node; return null; }
  findAll(predicate) { return [...this.walk()].filter(predicate); }
  byId(id) { return this.find((n) => n.id === id); }
  /** Every element carrying this CSS class. */
  byClass(name) { return this.findAll((n) => n.className.split(/\s+/).includes(name)); }
  get text() { return this.textContent; }
}

/**
 * Install a document matching public/index.html, plus the browser globals the
 * client touches. Returns handles the tests drive.
 */
export function installDom({ hash = '', href = 'http://localhost:8420/', lang = 'en' } = {}) {
  const root = new Element('body');
  const make = (tag, id) => { const e = new Element(tag); e.id = id; root.append(e); return e; };

  const fixtures = {
    langToggle: make('button', 'langToggle'),
    conn: make('span', 'conn'),
    update: make('div', 'update'),
    view: make('main', 'view'),
    gameSwitch: make('div', 'gameSwitch'),
    rules: make('dialog', 'rules'),
    rulesBody: make('p', 'rulesBody'),
    toast: make('div', 'toast'),
  };
  // The two shell nodes index.html translates in place.
  const title = new Element('h1');
  title.setAttribute('data-i18n', 'app.title');
  root.append(title);

  const document = {
    documentElement: new Element('html'),
    body: root,
    createElement: (tag) => new Element(tag),
    createTextNode: (text) => new TextNode(text),
    getElementById: (id) => root.byId(id),
    querySelectorAll: (selector) => {
      const m = selector.match(/^\[([\w-]+)\]$/);
      return m ? root.findAll((n) => n.hasAttribute(m[1])) : [];
    },
  };

  const storage = new Map([['avalon.lang', lang]]);
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };

  const location = {
    href: href + hash,
    hash,
    origin: new URL(href).origin,
    pathname: new URL(href).pathname,
    protocol: new URL(href).protocol,
    reloadCalls: 0,
    reload() { this.reloadCalls += 1; },
    toString() { return this.href; },
  };

  const calls = [];
  const state = {
    health: true,
    offline: false,        // when true every request fails the way a dead server does
    protocol: 3,
    frontendVersion: 'dev',
    confirmResult: true,
    confirmations: [],
    responses: new Map(),  // path -> body, for anything else
  };

  const fetchStub = async (url, options = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    calls.push({ path, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (state.offline) throw new TypeError('fetch failed');   // the server is down
    if (path === '/api/health') {
      if (!state.health) throw new TypeError('fetch failed');
      return jsonResponse({ ok: true, service: 'avalon', protocol: state.protocol });
    }
    if (/\/version\.json(?:\?|$)/.test(path)) return jsonResponse({ version: state.frontendVersion });
    if (state.responses.has(path)) return jsonResponse(state.responses.get(path));
    return jsonResponse({ error: 'noSuchRoom', params: {} }, 400);
  };

  const jsonResponse = (body, status = 200) => ({
    ok: status < 400, status, json: async () => body,
  });

  class EventSourceStub {
    constructor(url) { this.url = url; EventSourceStub.last = this; }
    close() { this.closed = true; }
  }

  class AudioStub {
    static instances = [];
    static playError = null;

    constructor(src = '') {
      this.src = src;
      this.paused = true;
      this.muted = false;
      this.currentTime = 0;
      this.playCalls = 0;
      AudioStub.instances.push(this);
    }

    play() {
      this.playCalls += 1;
      this.paused = false;
      return AudioStub.playError ? Promise.reject(AudioStub.playError) : Promise.resolve();
    }

    pause() { this.paused = true; }
    load() {}
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    finish() { this.paused = true; this.onended?.({ type: 'ended', target: this }); }
  }

  // Page-level listeners, so a test can raise the events a phone raises when it
  // comes back: 'online', 'focus', 'visibilitychange'.
  const pageListeners = new Map();
  const addPageListener = (type, fn) => {
    if (!pageListeners.has(type)) pageListeners.set(type, []);
    pageListeners.get(type).push(fn);
  };
  const fire = (type, event = {}) => {
    for (const fn of pageListeners.get(type) ?? []) fn({ type, ...event });
  };

  document.addEventListener = addPageListener;
  document.visibilityState = 'visible';

  Object.assign(globalThis, {
    document,
    window: {
      addEventListener: addPageListener,
      confirm(message) {
        state.confirmations.push(String(message));
        return state.confirmResult;
      },
    },
    localStorage,
    location,
    fetch: fetchStub,
    EventSource: EventSourceStub,
    Audio: AudioStub,
  });

  return {
    root, fixtures, document, localStorage, location, calls, state,
    EventSourceStub, AudioStub, storage, fire,
  };
}

export { Element, TextNode };
