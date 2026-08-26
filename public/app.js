import { LANGS, detectLang, t } from './i18n.js';
import { API_BASE } from './config.js';
import { el, h, toast } from './ui.js';
import { DEFAULT_GAME, GAME_IDS, gameFor } from './games/index.js';

const LOADED_VERSION = new URL(import.meta.url).searchParams.get('v') ?? 'dev';
const VERSION_URL = new URL('./version.json', import.meta.url);
const VERSION_CHECK_MS = 60_000;
const API_PROTOCOL = 1;
const PAGES_ORIGIN = 'https://shengjiex98.github.io';

// ---------------------------------------------------------------- state

const app = {
  lang: detectLang(),
  server: null,           // remote origin, or '' when Node serves this page
  serverStatus: 'checking',
  serverProtocol: null,
  code: null,
  playerId: null,
  view: null,        // latest server view, or null before the first event
  connected: false,
  gameId: localStorage.getItem('avalon.game') ?? DEFAULT_GAME,  // what Create would make
  selection: [],     // players the current prompt is collecting
  centres: [],       // centre cards the current prompt is collecting
  seerMode: 'player',
  muted: Boolean(localStorage.getItem('avalon.muted')),
  everConnected: false,   // distinguishes "connecting" from "dropped"
  testMode: Boolean(localStorage.getItem('avalon.test')),
  seats: [],              // every seat this device holds, for testing alone
  stepEndsAt: 0,
  clockStep: null,   // which night step stepEndsAt was anchored to
  infoPopup: null,   // shared overlay state; hidden until explicitly opened
  logOpen: false,    // the journal is a disclosure the user owns, not the renderer
  source: null,      // EventSource
  retry: 0,
  latestVersion: LOADED_VERSION,
  updateAvailable: false,
};

const T = (key, params) => t(app.lang, key, params);

const store = {
  get name() { return localStorage.getItem('avalon.name') ?? ''; },
  set name(v) { localStorage.setItem('avalon.name', v); },
  get server() { return localStorage.getItem('avalon.server'); },
  set server(v) { v ? localStorage.setItem('avalon.server', v) : localStorage.removeItem('avalon.server'); },
  seatsFor: (code) => {
    try { return JSON.parse(localStorage.getItem(`avalon.seats.${code}`)) ?? []; }
    catch { return []; }
  },
  nameFor: (code, playerId) =>
    store.seatsFor(code).find((seat) => seat.id === playerId)?.name ?? store.name,
  setSeats: (code, seats) => localStorage.setItem(`avalon.seats.${code}`, JSON.stringify(seats)),
  clearSeats: (code) => localStorage.removeItem(`avalon.seats.${code}`),
  playerFor: (code) => localStorage.getItem(`avalon.player.${code}`),
  setPlayer: (code, id) => localStorage.setItem(`avalon.player.${code}`, id),
  clearPlayer: (code) => localStorage.removeItem(`avalon.player.${code}`),
};

function resolveServer() {
  if (location.origin !== PAGES_ORIGIN) {
    store.server = null;
    return '';
  }
  const fromUrl = new URL(location.href).searchParams.get('server');
  if (fromUrl !== null) store.server = normaliseServer(fromUrl);
  return store.server ?? normaliseServer(API_BASE) ?? '';
}

/** Remote servers must use HTTPS; local Node deployments use same-origin ''. */
function normaliseServer(raw) {
  try {
    const url = new URL(String(raw ?? '').trim());
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

async function probeServer() {
  app.serverStatus = 'checking';
  app.serverProtocol = null;
  try {
    const res = await fetch(`${app.server}/api/health`, { cache: 'no-store' });
    const body = await res.json();
    if (!res.ok || body.service !== 'avalon') throw new Error('not avalon');
    app.serverProtocol = body.protocol;
    app.serverStatus = body.protocol === API_PROTOCOL ? 'ready' : 'incompatible';
  } catch {
    app.serverStatus = 'unreachable';
  }
  return app.serverStatus;
}

// ---------------------------------------------------------------- transport

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(app.server + path, {
      method: options.body ? 'POST' : 'GET',
      headers: options.body ? { 'content-type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError('network', {});
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? 'serverError', data.params ?? {});
  return data;
}

class ApiError extends Error {
  constructor(key, params) { super(key); this.key = key; this.params = params; }
}

function send(type, extra = {}) {
  return api(`/api/rooms/${app.code}/action`, {
    body: { type, playerId: app.playerId, ...extra },
  }).catch((err) => toast(T(`err.${err.key}`, err.params)));
}

function connect() {
  app.source?.close();
  const source = new EventSource(`${app.server}/api/rooms/${app.code}/events?playerId=${encodeURIComponent(app.playerId)}`);
  app.source = source;

  source.onmessage = (event) => {
    app.connected = true;
    app.everConnected = true;
    app.retry = 0;
    const next = JSON.parse(event.data);
    // Drop a stale team selection whenever the round or phase moves on.
    if (!app.view || next.phase !== app.view.phase || next.round !== app.view.round
        || next.gameId !== app.view.gameId) {
      app.selection = [];
      app.centres = [];
      app.infoPopup = null;
    }
    app.view = next;
    try {
      // Bind first: the hook reads the context that bindGame installs, and it
      // runs before the paint so the clock is anchored. A throw in here must
      // never cost us the redraw — that leaves the last screen frozen on
      // display, which is worse than whatever went wrong.
      bindGame(next.gameId).onView?.();
    } catch (err) {
      console.error(err);
    }
    render();
  };
  source.onerror = () => {
    app.connected = false;
    source.close();
    render();
    app.retry = Math.min(app.retry + 1, 6);
    setTimeout(connect, 500 * 2 ** (app.retry - 1));
  };
}

// ---------------------------------------------------------------- entry

async function createRoom() {
  const name = readName();
  if (!name) return;
  const { code } = await api('/api/rooms', { body: { game: app.gameId } });
  await joinRoom(code, name);
}

async function joinRoom(code, name) {
  code = code.toUpperCase();
  try {
    const res = await api(`/api/rooms/${code}/join`, {
      body: { name, playerId: store.playerFor(code) },
    });
    app.code = code;
    app.playerId = res.playerId;
    store.setPlayer(code, res.playerId);
    rememberSeat(code, res.playerId, name);
    location.hash = `#/${code}`;
    connect();
    render();
  } catch (err) {
    toast(T(`err.${err.key}`, err.params));
  }
}

/** Track the seats this browser controls, so test mode can switch between them. */
function rememberSeat(code, playerId, name) {
  app.seats = store.seatsFor(code).filter((seat) => seat.id !== playerId);
  app.seats.push({ id: playerId, name });
  store.setSeats(code, app.seats);
}

function readName() {
  const input = el('nameInput');
  const name = (input?.value ?? '').trim();
  if (!name) { toast(T('err.nameRequired')); input?.focus(); return null; }
  store.name = name;
  return name;
}

function leaveRoom() {
  send('leave').finally(() => {
    app.source?.close();
    store.clearPlayer(app.code);
    app.source = null; app.view = null; app.playerId = null;
    app.infoPopup = null;
    store.clearSeats(app.code);
    app.seats = [];
    location.hash = '';
    app.code = null;
    app.connected = false;
    app.everConnected = false;
    render();
  });
}

// ---------------------------------------------------------------- render

function render() {
  document.documentElement.lang = app.lang === 'zh' ? 'zh-CN' : 'en';
  el('langToggle').textContent = app.lang === 'en' ? LANGS.zh : LANGS.en;
  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = T(node.dataset.i18n);
  }
  el('rulesBody').textContent = T(gameFor(currentGameId()).rulesKey);
  renderGameSwitch();
  renderUpdateBanner();

  // A first connection is not a dropped one; saying "reconnecting" while
  // simply joining is alarming and wrong.
  const conn = el('conn');
  const state = app.code && !app.connected ? (app.everConnected ? 'lost' : 'connecting') : null;
  conn.hidden = !state;
  conn.className = `conn-banner ${state ?? ''}`;
  if (state) conn.textContent = T(state === 'lost' ? 'conn.lost' : 'conn.connecting');

  const view = el('view');
  scrollPanes = [];
  view.replaceChildren(...(app.code && app.view ? screenGame() : screenHome()), paneTestMode());
  restoreScroll();
}

// ---- scroll memory
//
// Every click re-renders the whole view, so a scrollable pane that is rebuilt
// from scratch snaps back to the top: the middle of a game screen jumps under
// the player's thumb on every tap. Remember where each pane sat and put it
// back before the browser paints, so the rebuild is invisible.

let scrollTops = new Map();
let scrollPanes = [];

/**
 * A scrollable pane whose position survives the next re-render. The key names
 * the content, not the element: change it and the pane deliberately starts at
 * the top again, which is what genuinely new content wants.
 */
function scrollPane(key, props, ...children) {
  const node = h('div', { ...props, onscroll: () => scrollTops.set(key, node.scrollTop) }, ...children);
  scrollPanes.push([key, node]);
  return node;
}

function restoreScroll() {
  const kept = new Map();
  for (const [key, node] of scrollPanes) {
    const top = scrollTops.get(key) ?? 0;
    if (top) node.scrollTop = top;
    kept.set(key, top);
  }
  scrollTops = kept;   // panes that are gone take their offsets with them
  scrollPanes = [];
}

function renderUpdateBanner() {
  const banner = el('update');
  banner.hidden = !app.updateAvailable;
  if (banner.hidden) return banner.replaceChildren();
  banner.replaceChildren(
    h('span', { class: 'grow', text: T('update.available') }),
    h('button', {
      class: 'btn primary', id: 'reloadVersion', type: 'button',
      onclick: () => location.reload(),
    }, T('update.reload')),
  );
}

/** Ask the front-end host directly so browser and CDN caches cannot hide a deploy. */
export async function checkForUpdate() {
  try {
    const url = new URL(VERSION_URL);
    url.searchParams.set('check', Date.now());
    const res = await fetch(url.href, { cache: 'no-store' });
    if (!res.ok) return false;
    const version = String((await res.json()).version ?? '');
    if (!version || version === LOADED_VERSION) return false;
    app.latestVersion = version;
    app.updateAvailable = true;
    renderUpdateBanner();
    return true;
  } catch {
    return false; // losing the update check must never interrupt the game
  }
}

function startUpdateChecks() {
  void checkForUpdate();
  const timer = setInterval(checkForUpdate, VERSION_CHECK_MS);
  timer.unref?.();
  window.addEventListener('focus', checkForUpdate);
}

/** In a room it is the room's game; on the home screen it is what Create makes. */
const currentGameId = () => app.view?.gameId ?? app.gameId;

/**
 * The switcher in the top bar. On the home screen it picks what you would
 * create; in a lobby the host uses it to change what the room is playing,
 * and everyone else sees which game they are in.
 */
function renderGameSwitch() {
  const inRoom = Boolean(app.code && app.view);
  const active = currentGameId();
  const canSwitch = !inRoom || (app.view.phase === 'lobby' && app.view.you?.id === app.view.hostId);

  const pick = (gameId) => {
    if (gameId === active) return;
    if (!inRoom) {
      app.gameId = gameId;
      localStorage.setItem('avalon.game', gameId);
      render();
      return;
    }
    send('setGame', { game: gameId });
  };

  el('gameSwitch').replaceChildren(...GAME_IDS.map((gameId) => h('button', {
    class: `seg-btn ${gameId === active ? 'on' : ''}`,
    type: 'button',
    id: `game-${gameId}`,
    disabled: !canSwitch && gameId !== active,
    title: canSwitch ? undefined : T('game.hostOnlySwitch'),
    onclick: () => pick(gameId),
  }, T(`game.${gameId}`))));
}

function screenHome() {
  if (app.serverStatus === 'checking') {
    return [h('div', { class: 'card' }, h('p', { class: 'muted', text: T('server.checking') }))];
  }
  if (app.serverStatus !== 'ready') return [paneServer()];

  // A shared link carries the room code, so someone arriving that way should
  // only have to give a name.
  const invited = ((location.hash.match(/^#\/([A-Za-z0-9]{4,8})$/) ?? [])[1] ?? '').toUpperCase();

  const doCreate = () => createRoom().catch((e) => toast(T(`err.${e.key ?? 'network'}`, e.params)));
  const doJoin = () => {
    const name = readName();
    const code = el('codeInput').value.trim().toUpperCase();
    if (!name) return;
    if (!code) { toast(T('err.noSuchRoom')); return; }
    joinRoom(code, name);
  };

  // One name field, above both actions and belonging to neither. It used to
  // sit inside the "create a room" card, which made joining look like it
  // needed no name at all.
  return [
    h('div', { class: 'card stack' },
      h('p', { class: 'muted', text: invited ? T('home.invited', { code: invited }) : T(gameFor(app.gameId).taglineKey) }),
      h('label', {}, T('home.name'),
        h('input', {
          type: 'text', id: 'nameInput', maxlength: '24', value: store.name,
          placeholder: T('home.namePlaceholder'), autocomplete: 'nickname',
          autofocus: store.name ? null : 'autofocus',
          onkeydown: (e) => { if (e.key === 'Enter') (invited ? doJoin() : doCreate()); },
        })),
      h('p', { class: 'muted', text: T('home.nameHint') }),

      h('button', { class: `btn wide ${invited ? '' : 'primary'}`, id: 'createBtn', onclick: doCreate },
        T('home.create')),

      h('div', { class: 'divider' }, h('span', { text: T('home.or') })),

      h('div', { class: 'row bottom' },
        h('label', { class: 'grow' }, T('home.code'),
          h('input', {
            type: 'text', id: 'codeInput', maxlength: '8', value: invited,
            placeholder: T('home.codePlaceholder'), autocapitalize: 'characters', autocomplete: 'off',
            onkeydown: (e) => { if (e.key === 'Enter') doJoin(); },
          })),
        h('button', { class: `btn ${invited ? 'primary' : ''}`, id: 'joinBtn', onclick: doJoin },
          invited ? T('home.joinRoom', { code: invited }) : T('home.go')),
      ),
    ),
    h('div', { class: 'row' },
      h('button', { class: 'btn ghost grow', onclick: () => el('rules').showModal() }, T('home.rulesLink')),
      app.server ? h('button', {
        class: 'btn ghost',
        onclick: () => { app.serverStatus = 'unreachable'; render(); },
      }, T('server.change')) : null,
    ),
    app.server ? h('p', { class: 'muted', text: T('server.connected', { server: app.server }) }) : null,
  ].filter(Boolean);
}

function paneServer() {
  const submit = async () => {
    const value = normaliseServer(el('serverInput').value);
    if (!value) return toast(T('server.httpsOnly'));
    app.server = value;
    store.server = value;
    render();
    await probeServer();
    render();
  };

  const message = app.serverStatus === 'incompatible'
    ? T('server.incompatible', { expected: API_PROTOCOL, actual: app.serverProtocol ?? '?' })
    : T('server.unreachable');

  return h('div', { class: 'card stack' },
    h('h2', { text: T('server.title') }),
    h('p', { class: 'muted', text: message }),
    h('label', {}, T('server.label'),
      h('input', {
        type: 'url', id: 'serverInput', value: app.server, spellcheck: 'false',
        placeholder: T('server.placeholder'), autocapitalize: 'off', autocomplete: 'url',
        onkeydown: (e) => { if (e.key === 'Enter') submit(); },
      })),
    h('button', { class: 'btn primary wide', onclick: submit }, T('server.connect')),
  );
}

function screenGame() {
  const v = app.view;
  const game = bindGame(v.gameId);
  const canReset = v.you?.id === v.hostId && v.phase !== 'lobby' && v.phase !== 'over';
  const paneKey = `${v.gameId}:${v.phase}:${game.paneKey?.() ?? ''}`;
  const reset = canReset ? h('div', { class: 'row game-utility' },
    h('button', {
      class: 'btn ghost grow', id: 'resetGame', type: 'button',
      onclick: () => {
        if (window.confirm(T('game.resetConfirm'))) send('reset');
      },
    }, T('game.reset')),
  ) : null;

  // One scroller holds the whole game: the info buttons, whatever the game
  // puts above its phase panel, the phase panel itself, and the reset row.
  // Splitting them meant a tall header — Avalon's board once it carries a
  // vote tally — squeezed the panel below it and spilled over the journal.
  const content = v.phase === 'lobby'
    ? scrollPane(`lobby:${paneKey}`, { class: 'lobby-scroll' }, ...paneLobby(game))
    : scrollPane(`phase:${paneKey}`, { class: 'phase-area' },
        ...game.header_(), ...game.panes(), reset);
  return [h('section', { class: `game-screen game-${v.gameId} phase-${v.phase}` },
    content,
    paneLog(),
  )];
}

/** Hand the current game module everything it needs to draw with. */
function bindGame(gameId) {
  const game = gameFor(gameId);
  game.bind({ T, send, app, render, nameOf, namesOf, waitingNames, joinNames, playerList });
  return game;
}

const nameOf = (id) => app.view.players.find((p) => p.id === id)?.name ?? '?';
const joinNames = (names) => names.join(app.lang === 'zh' ? '、' : ', ');
const namesOf = (ids) => joinNames(ids.map(nameOf));
const waitingNames = () => namesOf(app.view.waitingFor);

// ---- lobby

function paneLobby(game) {
  const v = app.view;
  const isHost = v.you?.id === v.hostId;
  const enough = v.players.length >= game.minPlayers;

  return [
    h('div', { class: 'card stack' },
      h('h2', { text: T('lobby.code') }),
      h('div', { class: 'code-pill', text: v.code }),
      h('p', { class: 'muted', text: T('lobby.share') }),
      h('button', { class: 'btn', onclick: copyLink }, T('lobby.copy')),
    ),
    h('div', { class: 'card stack' },
      h('h2', { text: T('lobby.players', { n: v.players.length }) }),
      h('div', { class: 'players' }, v.players.map((p) => h('div', { class: 'player' },
        h('span', { class: 'seat', text: p.seat + 1 }),
        h('span', { class: 'name', text: p.name }),
        p.id === v.hostId ? h('span', { class: 'tag', text: T('lobby.host') }) : null,
        p.id === v.you?.id ? h('span', { class: 'tag you', text: T('lobby.you') }) : null,
      ))),
    ),
    game.lobbyOptions(),
    h('div', { class: 'row' },
      isHost
        ? h('button', {
            class: 'btn primary grow', id: 'startBtn', disabled: !enough,
            onclick: () => send('start'),
          }, enough ? T('lobby.start') : T('lobby.needMore', { min: game.minPlayers, n: v.players.length }))
        : h('span', { class: 'muted grow', text: T('lobby.waitingHost') }),
      h('button', { class: 'btn ghost', onclick: leaveRoom }, T('lobby.leave')),
    ),
  ];
}

function copyLink() {
  const url = new URL(location.href);
  url.search = app.server ? `?server=${encodeURIComponent(app.server)}` : '';
  url.hash = `#/${app.code}`;
  const link = url.toString();
  const copied = navigator.clipboard?.writeText(link);
  if (copied) copied.then(() => toast(T('lobby.copied'), 'info')).catch(() => toast(link, 'info'));
  else toast(link, 'info');   // no clipboard API on a plain-http origin
}

// ---- shared bits

function playerList({ selectable = false, selected = [], onpick, tags, only, exclude = [] } = {}) {
  const v = app.view;
  const rows = v.players
    .filter((p) => !only || only.includes(p.id))
    .map((p) => {
      const picked = selected.includes(p.id);
      const blocked = exclude.includes(p.id);
      const inner = [
        h('span', { class: 'seat', text: p.seat + 1 }),
        h('span', { class: 'name', text: p.name }),
        p.id === v.you?.id ? h('span', { class: 'tag you', text: T('lobby.you') }) : null,
        p.isLeader ? h('span', { class: 'tag leader', text: '👑' }) : null,
        p.onTeam && v.phase !== 'quest' ? h('span', { class: 'tag team', text: '⚔' }) : null,
        ...(tags ? tags(p) : []),
      ];
      if (!selectable) return h('div', { class: 'player' }, inner);
      return h('button', {
        class: `player ${picked ? 'selected' : ''}`, type: 'button',
        disabled: blocked, onclick: () => onpick(p),
      }, inner);
    });
  return h('div', { class: 'players' }, rows);
}

function paneLog() {
  const entries = app.view.log.slice().reverse();
  return h('details', {
    class: 'card journal', open: app.logOpen,
    ontoggle: (event) => { app.logOpen = Boolean(event.target.open); },
  },
    h('summary', {},
      h('span', { 'aria-hidden': 'true', text: '▤' }),
      h('span', { text: T('log.title') }),
      h('span', { class: 'journal-count', text: entries.length }),
    ),
    scrollPane('log', { class: 'log' }, entries.map((e) => h('div', {
      text: T(e.key, formatParams(e.params)),
    }))),
  );
}

function formatParams(params) {
  const out = { ...params };
  for (const [key, value] of Object.entries(out)) if (Array.isArray(value)) out[key] = joinNames(value);
  if (out.game) out.game = T(`game.${out.game}`);
  const game = gameFor(app.view?.gameId);
  if (game.formatParams) return game.formatParams(out);
  if (out.winner) out.winner = T(`side.${out.winner}`);
  return out;
}

// ---------------------------------------------------------------- test mode

/**
 * Playing a five-handed game on your own. Every seat here is a real player on
 * the server, joined from this browser; switching seats reopens the stream as
 * that player, so what you see is the genuine per-player view rather than a
 * simulation of one.
 */
function paneTestMode() {
  const rows = [h('button', {
    class: 'btn ghost', id: 'testToggle',
    onclick: () => {
      app.testMode = !app.testMode;
      localStorage.setItem('avalon.test', app.testMode ? '1' : '');
      render();
    },
  }, `${T('test.mode')} · ${T(app.testMode ? 'test.on' : 'test.off')}`)];

  if (app.testMode) {
    rows.push(h('p', { class: 'muted', text: T('test.hint') }));
    if (app.code && app.view) {
      const lobby = app.view.phase === 'lobby';
      rows.push(h('div', { class: 'row' },
        h('button', { class: 'btn', id: 'testAdd', disabled: !lobby, onclick: addSeat },
          lobby ? T('test.add') : T('test.lobbyOnly')),
      ));
      rows.push(h('p', { class: 'muted', text: T('test.actingAs') }));
      rows.push(h('div', { class: 'row' }, app.seats.map((seat) => h('button', {
        class: `btn seat-chip ${seat.id === app.playerId ? 'primary' : ''}`,
        onclick: () => actAs(seat.id),
      }, seat.name))));
    } else {
      rows.push(h('p', { class: 'muted', text: T('test.needRoom') }));
    }
  }
  return h('div', { class: 'test-bar' }, rows);
}

/** Join the room again under a new name, from this same browser. */
async function addSeat() {
  const taken = new Set(app.view.players.map((p) => p.name.toLowerCase()));
  let n = app.view.players.length + 1;
  let name = T('test.player', { n });
  while (taken.has(name.toLowerCase())) name = T('test.player', { n: ++n });

  try {
    const res = await api(`/api/rooms/${app.code}/join`, { body: { name } });
    rememberSeat(app.code, res.playerId, name);
    render();
  } catch (err) {
    toast(T(`err.${err.key}`, err.params));
  }
}

/** Look through another seat's eyes, by reconnecting as them. */
function actAs(playerId) {
  if (playerId === app.playerId) return;
  app.playerId = playerId;
  store.setPlayer(app.code, playerId);
  app.selection = [];
  app.centres = [];
  app.infoPopup = null;
  connect();
  render();
}

// ---------------------------------------------------------------- boot

/**
 * Wire up the shell and reconnect if we still hold a seat. Exported and
 * awaited by the tests, which render into a DOM shim rather than a browser.
 */
export async function main() {
  el('langToggle').addEventListener('click', () => {
    app.lang = app.lang === 'en' ? 'zh' : 'en';
    localStorage.setItem('avalon.lang', app.lang);
    render();
  });

  window.addEventListener('hashchange', () => {
    if (!app.code) render();
  });
  startUpdateChecks();

  app.server = resolveServer();
  render();
  await probeServer();

  const code = (location.hash.match(/^#\/([A-Za-z0-9]{4,8})$/) ?? [])[1]?.toUpperCase();
  const playerId = code && store.playerFor(code);
  if (app.serverStatus === 'ready' && code && playerId) {
    app.code = code;
    app.playerId = playerId;
    app.seats = store.seatsFor(code);
    try {
      await api(`/api/rooms/${code}/join`, { body: { name: store.nameFor(code, playerId), playerId } });
      connect();
    } catch {
      store.clearPlayer(code);
      app.code = null;
      app.playerId = null;
    }
  }
  render();
}

export { app, render };

export const ready = main();
