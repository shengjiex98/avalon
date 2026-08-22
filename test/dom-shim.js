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
export function installDom({ hash = '', href = 'https://someone.github.io/avalon/', lang = 'en' } = {}) {
  const root = new Element('body');
  const make = (tag, id) => { const e = new Element(tag); e.id = id; root.append(e); return e; };

  const fixtures = {
    langToggle: make('button', 'langToggle'),
    conn: make('span', 'conn'),
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
    toString() { return this.href; },
  };

  const calls = [];
  const state = {
    health: true,          // does the backend answer the probe?
    responses: new Map(),  // path -> body, for anything else
  };

  const fetchStub = async (url, options = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    calls.push({ path, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (path === '/api/health') {
      if (!state.health) throw new TypeError('fetch failed');
      return jsonResponse({ ok: true, service: 'avalon' });
    }
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

  Object.assign(globalThis, {
    document,
    window: { addEventListener() {} },
    localStorage,
    location,
    fetch: fetchStub,
    EventSource: EventSourceStub,
  });

  return { root, fixtures, document, localStorage, location, calls, state, EventSourceStub, storage };
}

export { Element, TextNode };
