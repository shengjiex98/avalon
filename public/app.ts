import { LANGS, detectLang, t } from './i18n.ts';
import { API_BASE } from './config.ts';
import { el, h, playerAvatar, toast } from './ui.ts';
import { DEFAULT_GAME, GAME_IDS, gameFor, knownGame } from './games/index.ts';
import { createStore } from './storage.ts';
import { ApiError, createTransport } from './transport.ts';
import { createSharedRendering } from './rendering.ts';
import { createTestSeats } from './test-seats.ts';
import { createRoomSession } from './room-session.ts';
import { resetAction, startAction, switchGameAction } from './client-actions.ts';
import type { ClientAction, GameId } from '../src/contracts/actions.ts';
import type { PublicView } from '../src/contracts/views.ts';
import type { PlayerListOptions } from '../types/browser-renderers.d.ts';
import type { StoredSeat } from './storage.ts';

type ServerStatus = 'checking' | 'ready' | 'incompatible' | 'unreachable';
type AppState = {
  lang: string;
  server: string | null;
  serverStatus: ServerStatus;
  serverProtocol: number | null;
  avatarGeneration: boolean;
  avatarUpload: string | null;
  code: string | null;
  playerId: string | null;
  view: PublicView | null;
  connected: boolean;
  gameId: GameId;
  selection: string[];
  centres: number[];
  seerMode: 'player' | 'centre';
  muted: boolean;
  everConnected: boolean;
  rejoining: boolean;
  testMode: boolean;
  seats: StoredSeat[];
  heldSeat: { code: string; playerId: string } | null;
  stepEndsAt: number;
  clockStep: number | null;
  infoPopup: string | null;
  logOpen: boolean;
  source: EventSource | null;
  retry: number;
  latestVersion: string;
  updateAvailable: boolean;
};
type GameRenderer = {
  id: GameId;
  paneKey?: () => string;
  header_: () => unknown[];
  panes: () => unknown[];
  lobbyOptions: () => HTMLElement;
  onView?: () => void;
  dispose?: () => void;
  formatParams?: (params: Record<string, unknown>, entryKey: string) => Record<string, unknown>;
};

const present = <T>(value: T | null | undefined | false): value is T => Boolean(value);
const unrefTimer = (timer: unknown): void => {
  if (timer && typeof timer === 'object' && 'unref' in timer && typeof timer.unref === 'function') {
    timer.unref();
  }
};

const LOADED_VERSION = new URL(import.meta.url).searchParams.get('v') ?? 'dev';
const VERSION_URL = new URL('./version.json', import.meta.url);
const VERSION_CHECK_MS = 60_000;
const PROBE_RETRY_MS = 15_000;
const API_PROTOCOL = 3;
const PAGES_ORIGIN = 'https://shengjiex98.github.io';

// ---------------------------------------------------------------- state

const store = createStore();

/** A remembered choice outlives the game it names; fall back rather than fail. */
function storedGameId(): GameId {
  const stored = store.game;
  return knownGame(stored) ? stored : DEFAULT_GAME;
}

const app: AppState = {
  lang: detectLang(),
  server: null,           // remote origin, or '' when Node serves this page
  serverStatus: 'checking',
  serverProtocol: null,
  avatarGeneration: false,
  avatarUpload: null,
  code: null,
  playerId: null,
  view: null,        // latest server view, or null before the first event
  connected: false,
  gameId: storedGameId(),  // what Create would make
  selection: [],     // players the current prompt is collecting
  centres: [],       // centre cards the current prompt is collecting
  seerMode: 'player',
  muted: store.muted,
  everConnected: false,   // distinguishes "connecting" from "dropped"
  rejoining: false,       // holding a seat from a previous page, not a fresh join
  testMode: store.testMode,
  seats: [],              // every seat this device holds, for testing alone
  heldSeat: null,         // { code, playerId } this device holds but is not sitting in
  stepEndsAt: 0,
  clockStep: null,   // which night step stepEndsAt was anchored to
  infoPopup: null,   // shared overlay state; hidden until explicitly opened
  logOpen: false,    // the journal is a disclosure the user owns, not the renderer
  source: null,      // EventSource
  retry: 0,
  latestVersion: LOADED_VERSION,
  updateAvailable: false,
};

const T = (key: string, params?: Record<string, unknown>) => t(app.lang, key, params);

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
function normaliseServer(raw: unknown): string | null {
  try {
    const url = new URL(String(raw ?? '').trim());
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

async function probeServer() {
  if (probeTimer) clearTimeout(probeTimer);
  probeTimer = null;
  app.serverStatus = 'checking';
  app.serverProtocol = null;
  try {
    const result = await transport.probeProtocol(API_PROTOCOL);
    app.avatarGeneration = result.avatarGeneration;
    if (result.kind === 'ready') {
      app.serverProtocol = API_PROTOCOL;
      app.serverStatus = 'ready';
    } else {
      app.serverProtocol = result.actual;
      app.serverStatus = 'incompatible';
    }
  } catch {
    app.avatarGeneration = false;
    app.serverStatus = 'unreachable';
  }
  return app.serverStatus;
}

let probeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * A server that is down during a deployment used to strand the client on the
 * "which server?" card until someone reloaded. Keep asking instead, quietly,
 * and pick the session back up the moment it answers.
 */
function watchServer() {
  if (probeTimer) clearTimeout(probeTimer);
  probeTimer = null;
  if (app.serverStatus !== 'unreachable') return;
  probeTimer = setTimeout(async () => {
    probeTimer = null;
    if (app.serverStatus !== 'unreachable') return;
    if (await probeServer() === 'ready') {
      if (app.code && !app.connected) void recover();
      else if (!app.code) await offerHeldSeat();
    }
    safeRender();
    watchServer();
  }, PROBE_RETRY_MS);
  unrefTimer(probeTimer);
}

// ---------------------------------------------------------------- transport

const transport = createTransport({ app });
let session: ReturnType<typeof createRoomSession>;
const send = (action: ClientAction) => session.send(action);
const connect = () => session.connect();
const recover = () => session.recover();
const wake = () => session.wake();
const dropRoom = (reason: string | null, options?: { keepSeat?: boolean }) => session.dropRoom(reason, options);
const createRoom = () => session.createRoom();
const joinRoom = (code: string, name: string) => session.joinRoom(code, name);
const leaveRoom = () => session.leaveRoom();
const roomFromHash = () => session.roomFromHash();
const enterRoom = (code: string, playerId: string) => session.enterRoom(code, playerId);
const offerHeldSeat = () => session.offerHeldSeat();
const dismissSeat = (code: string) => session.dismissSeat(code);

/** The redraw is best-effort everywhere reconnection depends on it. */
function safeRender() {
  try { render(); } catch (err) { console.error(err); }
}

const avatarInitial = (name: unknown) => [...String(name ?? '').trim()][0]?.toLocaleUpperCase() ?? '✦';

/** Strip metadata and turn a phone photo into the small square the API accepts. */
async function prepareAvatarUpload(file: File): Promise<string> {
  if (!file?.type?.startsWith('image/')) throw new ApiError('avatarImageOnly', {});
  if (file.size > 8 * 1024 * 1024) throw new ApiError('avatarTooLarge', {});

  const bitmap = await decodeAvatar(file);
  const width = bitmap instanceof HTMLImageElement ? bitmap.naturalWidth : bitmap.width;
  const height = bitmap instanceof HTMLImageElement ? bitmap.naturalHeight : bitmap.height;
  if (!width || !height) throw new ApiError('avatarImageOnly', {});
  const side = Math.min(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  if (!context) throw new ApiError('avatarImageOnly', {});
  context.drawImage(bitmap, (width - side) / 2, (height - side) / 2, side, side, 0, 0, 256, 256);
  if (bitmap instanceof ImageBitmap) bitmap.close();

  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
    (value) => value ? resolve(value) : reject(new ApiError('avatarImageOnly', {})),
    'image/webp', 0.78,
  ));
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new ApiError('avatarImageOnly', {}));
    reader.readAsDataURL(blob);
  });
}

async function decodeAvatar(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof globalThis.createImageBitmap === 'function') return createImageBitmap(file);
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new ApiError('avatarImageOnly', {}));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function chooseAvatar(event: Event) {
  const file = event.target instanceof HTMLInputElement ? event.target.files?.[0] : undefined;
  if (!file) return;
  try {
    app.avatarUpload = await prepareAvatarUpload(file);
    render();
  } catch (error) {
    toast(T(`err.${error instanceof ApiError ? error.key : 'avatarImageOnly'}`));
  }
}

function readName() {
  const input = el<HTMLInputElement>('nameInput');
  const name = (input?.value ?? '').trim();
  if (!name) { toast(T('err.nameRequired')); input?.focus(); return null; }
  store.name = name;
  return name;
}

// ---------------------------------------------------------------- render

function render() {
  document.documentElement.lang = app.lang === 'zh' ? 'zh-CN' : 'en';
  el('langToggle').textContent = app.lang === 'en' ? LANGS.zh : LANGS.en;
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    node.textContent = T(node.dataset.i18n ?? '');
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
  sharedRendering.begin();
  const screen = app.code ? (app.view ? screenGame() : screenRejoining()) : screenHome();
  view.replaceChildren(...screen, paneTestMode());
  sharedRendering.restoreScroll();
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
    url.searchParams.set('check', String(Date.now()));
    const version = await transport.latestVersion(url.href);
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
  unrefTimer(timer);
  window.addEventListener('focus', checkForUpdate);
}

/** In a room it is the room's game; on the home screen it is what Create makes. */
const currentGameId = (): GameId => app.view?.gameId ?? app.gameId;

/**
 * The switcher in the top bar. On the home screen it picks what you would
 * create; in a lobby the host uses it to change what the room is playing,
 * and everyone else sees which game they are in.
 */
function renderGameSwitch() {
  const view = app.view;
  const inRoom = Boolean(app.code && view);
  const active = currentGameId();
  const canSwitch = !inRoom || (view?.phase === 'lobby' && view.you?.id === view.hostId);

  const pick = (gameId: GameId) => {
    if (gameId === active) return;
    if (!inRoom) {
      app.gameId = gameId;
      store.game = gameId;
      render();
      return;
    }
    send(switchGameAction(gameId));
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
  if (app.serverStatus !== 'ready') {
    return [app.serverStatus === 'unreachable' && app.heldSeat ? paneHeldSeat() : null, paneServer()]
      .filter(present);
  }

  // A shared link carries the room code, so someone arriving that way should
  // only have to give a name.
  const invited = ((location.hash.match(/^#\/([A-Za-z0-9]{4,8})$/) ?? [])[1] ?? '').toUpperCase();

  const doCreate = () => createRoom().catch((error: unknown) => {
    const key = error instanceof ApiError ? error.key : 'network';
    const params = error instanceof ApiError ? error.params : {};
    toast(T(`err.${key}`, params));
  });
  const doJoin = () => {
    const name = readName();
    const code = el<HTMLInputElement>('codeInput').value.trim().toUpperCase();
    if (!name) return;
    if (!code) { toast(T('err.noSuchRoom')); return; }
    joinRoom(code, name);
  };

  // One name field, above both actions and belonging to neither. It used to
  // sit inside the "create a room" card, which made joining look like it
  // needed no name at all.
  return [
    app.heldSeat ? paneHeldSeat() : null,
    h('div', { class: 'card stack' },
      h('p', { class: 'muted', text: invited ? T('home.invited', { code: invited }) : T(gameFor(app.gameId).taglineKey) }),
      h('label', {}, T('home.name'),
        h('input', {
          type: 'text', id: 'nameInput', maxlength: '24', value: store.name,
          placeholder: T('home.namePlaceholder'), autocomplete: 'nickname',
          autofocus: store.name ? null : 'autofocus',
          oninput: (event: Event) => {
            const initial = el('avatarPreviewInitial');
            if (event.target instanceof HTMLInputElement) initial.textContent = avatarInitial(event.target.value);
          },
          onkeydown: (event: KeyboardEvent) => {
            if (event.key === 'Enter') (invited ? doJoin() : doCreate());
          },
        })),
      h('p', { class: 'muted', text: T('home.nameHint') }),

      h('div', { class: 'avatar-picker' },
        h('span', { class: 'avatar-preview', 'aria-hidden': 'true' },
          h('span', { id: 'avatarPreviewInitial', text: avatarInitial(store.name) }),
          app.avatarUpload ? h('img', { src: app.avatarUpload, alt: '' }) : null,
        ),
        h('div', { class: 'avatar-picker-copy' },
          h('span', { class: 'avatar-picker-title', text: T('home.avatar') }),
          h('span', { class: 'muted', text: T(app.avatarGeneration ? 'home.avatarAuto' : 'home.avatarInitials') }),
          h('div', { class: 'row avatar-actions' },
            h('label', { class: 'btn avatar-upload' },
              T(app.avatarUpload ? 'home.avatarReplace' : 'home.avatarUpload'),
              h('input', {
                type: 'file', id: 'avatarInput', class: 'avatar-file-input',
                accept: 'image/*', onchange: chooseAvatar,
              }),
            ),
            app.avatarUpload ? h('button', {
              class: 'btn ghost', type: 'button',
              onclick: () => { app.avatarUpload = null; render(); },
            }, T('home.avatarRemove')) : null,
          ),
        ),
      ),

      h('button', { class: `btn wide ${invited ? '' : 'primary'}`, id: 'createBtn', onclick: doCreate },
        T('home.create')),

      h('div', { class: 'divider' }, h('span', { text: T('home.or') })),

      h('div', { class: 'row bottom' },
        h('label', { class: 'grow' }, T('home.code'),
          h('input', {
            type: 'text', id: 'codeInput', maxlength: '8', value: invited,
            placeholder: T('home.codePlaceholder'), autocapitalize: 'characters', autocomplete: 'off',
            onkeydown: (event: KeyboardEvent) => { if (event.key === 'Enter') doJoin(); },
          })),
        h('button', { class: `btn ${invited ? 'primary' : ''}`, id: 'joinBtn', onclick: doJoin },
          invited ? T('home.joinRoom', { code: invited }) : T('home.go')),
      ),
    ),
    h('div', { class: 'row' },
      h('button', {
        class: 'btn ghost grow', onclick: () => el<HTMLDialogElement>('rules').showModal(),
      }, T('home.rulesLink')),
      app.server ? h('button', {
        class: 'btn ghost',
        onclick: () => { app.serverStatus = 'unreachable'; render(); },
      }, T('server.change')) : null,
    ),
    app.server ? h('p', { class: 'muted', text: T('server.connected', { server: app.server }) }) : null,
  ].filter(present);
}

/**
 * The way back into a room this browser is not on screen in: a reload that
 * arrived without the fragment, a home-screen shortcut that opens the bare URL,
 * or a game the player walked out of. It is an offer rather than a redirect,
 * which means it also has to be refusable — being able to say no is the whole
 * reason a bare URL is now a way out.
 */
function paneHeldSeat() {
  if (!app.heldSeat) throw new Error('held-seat panel requires a remembered seat');
  const { code, playerId } = app.heldSeat;
  return h('div', { class: 'card stack held-seat' },
    h('p', { text: T('home.heldSeat', { code }) }),
    h('div', { class: 'row' },
      h('button', {
        class: 'btn primary grow', id: 'rejoinSeat', type: 'button',
        onclick: () => { void enterRoom(code, playerId); },
      }, T('home.rejoin')),
      h('button', {
        class: 'btn ghost', id: 'forgetSeat', type: 'button',
        onclick: () => { dismissSeat(code); render(); },
      }, T('home.forget')),
    ),
  );
}

/**
 * We hold a seat but have no frame to draw yet -- a reload, or a server that is
 * still coming back. The join form used to sit here, which read as being thrown
 * out of the room; this says what is actually happening, and keeps the way out
 * for a player who would rather not wait.
 */
function screenRejoining() {
  return [h('div', { class: 'card stack' },
    h('h2', { text: T(app.rejoining ? 'room.rejoining' : 'room.joining', { code: app.code }) }),
    h('p', { class: 'muted', text: T('room.rejoiningHint') }),
    h('button', {
      class: 'btn ghost', id: 'forgetRoom', type: 'button',
      onclick: () => dropRoom(null, { keepSeat: true }),
    }, T('room.forget')),
  )];
}

function paneServer() {
  const submit = async () => {
    const value = normaliseServer(el<HTMLInputElement>('serverInput').value);
    if (!value) return toast(T('server.httpsOnly'));
    app.server = value;
    store.server = value;
    render();
    await probeServer();
    if (app.serverStatus === 'ready') {
      if (app.code && !app.connected) void recover();
      else if (!app.code) await offerHeldSeat();
    }
    watchServer();
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
        onkeydown: (event: KeyboardEvent) => { if (event.key === 'Enter') submit(); },
      })),
    h('button', { class: 'btn primary wide', onclick: submit }, T('server.connect')),
  );
}

function screenGame() {
  const v = app.view;
  if (!v) throw new Error('game screen requires a room view');
  const game = gameRenderer(v.gameId);
  const canReset = v.you?.id === v.hostId && v.phase !== 'lobby' && v.phase !== 'over';
  const paneKey = `${v.gameId}:${v.phase}:${game.paneKey?.() ?? ''}`;
  // The host can end the game for the table; anyone can walk away from it. The
  // second one used to exist only in the lobby, which left a player who had
  // given up on a game with nowhere to go but the browser's address bar.
  const utility = h('div', { class: 'row game-utility' },
    canReset ? h('button', {
      class: 'btn ghost grow', id: 'resetGame', type: 'button',
      onclick: () => {
        if (window.confirm(T('game.resetConfirm'))) send(resetAction());
      },
    }, T('game.reset')) : null,
    h('button', {
      class: 'btn ghost grow', id: 'leaveGame', type: 'button', onclick: leaveRoom,
    }, T('game.leave')),
  );

  // One scroller holds the whole game: the info buttons, whatever the game
  // puts above its phase panel, the phase panel itself, and the utility row.
  // Splitting them meant a tall header — Avalon's board once it carries a
  // vote tally — squeezed the panel below it and spilled over the journal.
  const content = v.phase === 'lobby'
    ? scrollPane(`lobby:${paneKey}`, { class: 'lobby-scroll' }, ...paneLobby(game))
    : scrollPane(`phase:${paneKey}`, { class: 'phase-area' },
        ...game.header_(), ...game.panes(), utility);
  return [h('section', { class: `game-screen game-${v.gameId} phase-${v.phase}` },
    content,
    paneLog(),
  )];
}

let activeGameRenderer: GameRenderer | null = null;

/** Construct a renderer when ownership moves to a different game. */
function gameRenderer(gameId: GameId): GameRenderer {
  if (activeGameRenderer?.id === gameId) return activeGameRenderer;
  disposeGameRenderer();
  const game = gameFor(gameId);
  const renderer: GameRenderer = game.createRenderer({
    T, send, app, render, nameOf, namesOf, waitingNames, joinNames, playerList,
    setMuted(value) { app.muted = value; store.muted = value; },
  });
  activeGameRenderer = renderer;
  return renderer;
}

function disposeGameRenderer() {
  activeGameRenderer?.dispose?.();
  activeGameRenderer = null;
}

/** Test compatibility without restoring mutable module bindings. */
export const gameRendererForTests = (gameId: GameId) => gameRenderer(gameId);

const nameOf = (id: string) => app.view?.players.find((player) => player.id === id)?.name ?? '?';
const joinNames = (names: string[]) => names.join(app.lang === 'zh' ? '、' : ', ');
const namesOf = (ids: string[]) => joinNames(ids.map(nameOf));
const waitingNames = () => {
  const view = app.view;
  return view && 'waitingFor' in view ? namesOf(view.waitingFor) : '';
};
const sharedRendering = createSharedRendering({
  app, T, joinNames, currentGame: () => gameRenderer(currentGameId()),
});
const scrollPane = sharedRendering.scrollPane;
const playerList = (options?: PlayerListOptions) => sharedRendering.playerList(options);
const paneLog = () => sharedRendering.paneLog();
session = createRoomSession({
  app, store, transport, T, render, readName, gameRenderer, disposeGameRenderer,
});
const testSeats = createTestSeats({
  app, store, T, transport, connect, render, rememberSeat: session.rememberSeat,
});
const paneTestMode = () => testSeats.pane();

// ---- lobby

function paneLobby(game: GameRenderer) {
  const v = app.view;
  if (!v || v.phase !== 'lobby') throw new Error('lobby panel requires a lobby view');
  const isHost = v.you?.id === v.hostId;
  const enough = v.players.length >= v.setup.minPlayers;

  return [
    h('div', { class: 'card stack' },
      h('h2', { text: T('lobby.code') }),
      h('div', { class: 'code-pill', text: v.code }),
      h('p', { class: 'muted', text: T('lobby.share') }),
      h('button', { class: 'btn', onclick: copyLink }, T('lobby.copy')),
    ),
    h('div', { class: 'card stack' },
      h('h2', { text: T('lobby.players', { n: v.players.length }) }),
      h('div', { class: 'players' }, v.players.map((p) => {
        const isYou = p.id === v.you?.id;
        return h('div', {
          class: `player ${isYou ? 'is-you' : ''}`, 'aria-current': isYou ? 'true' : null,
        },
          playerAvatar(p, app.server ?? ''),
          h('span', { class: 'name', text: p.name }),
          p.id === v.hostId ? h('span', { class: 'tag', text: T('lobby.host') }) : null,
          isYou ? h('span', { class: 'visually-hidden', text: T('lobby.you') }) : null,
        );
      })),
    ),
    game.lobbyOptions(),
    h('div', { class: 'row' },
      isHost
        ? h('button', {
            class: 'btn primary grow', id: 'startBtn', disabled: !enough,
            onclick: () => send(startAction()),
          }, enough ? T('lobby.start') : T('lobby.needMore', { min: v.setup.minPlayers, n: v.players.length }))
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

// ---------------------------------------------------------------- boot

/**
 * Wire up the shell and reconnect if we still hold a seat. Exported and
 * awaited by the tests, which render into a DOM shim rather than a browser.
 */
export async function main() {
  el('langToggle').addEventListener('click', () => {
    app.lang = app.lang === 'en' ? 'zh' : 'en';
    store.lang = app.lang;
    render();
  });

  window.addEventListener('hashchange', () => {
    if (!app.code) render();
  });
  // Anything that suggests the world came back: retry now rather than sitting
  // out the rest of a backoff the browser may have frozen anyway.
  window.addEventListener('online', wake);
  window.addEventListener('focus', wake);
  globalThis.document?.addEventListener?.('visibilitychange', wake);
  startUpdateChecks();

  app.server = resolveServer();
  render();
  await probeServer();
  watchServer();

  const code = roomFromHash();
  const playerId = code && store.playerFor(code);
  if (app.serverStatus !== 'incompatible' && code && playerId) await enterRoom(code, playerId);
  else await offerHeldSeat();
  render();
}

export { app, render };

export const ready = main();
