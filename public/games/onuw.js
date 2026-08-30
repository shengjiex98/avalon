// @ts-check
// One Night Werewolf's screens.

import { h, infoPopup, playerAvatar, rolePortrait } from '../ui.js';
import { assertNever } from '../assert-never.js';

/** @typedef {import('../../src/contracts/actions.ts').OnuwNightAction} OnuwNightAction */
/** @typedef {import('../../src/contracts/persistence.ts').GameEvent} GameEvent */
/** @typedef {import('../../src/contracts/views.ts').OnuwNightView} OnuwNightView */
/** @typedef {import('../../src/contracts/views.ts').OnuwView} OnuwView */
/** @typedef {OnuwView['players'][number]} OnuwPlayer */
/** @typedef {import('../../types/browser-renderers.d.ts').OnuwRendererContext} OnuwRendererContext */

export const id = 'onuw';
export const rulesKey = 'onuw.rules.body';
export const taglineKey = 'onuw.tagline';

/** Audio, clocks, and rendering belong to this renderer instance. */
/** @param {OnuwRendererContext} ctx */
export function createRenderer(ctx) {
const { T, send, app, joinNames, render } = ctx;
const setMuted = ctx.setMuted ?? ((value) => { app.muted = value; });
/** @param {{ name: string, avatar: string | null, seat?: number } | undefined} player */
const avatarOf = (player) => playerAvatar(player, app.server ?? undefined);

/** @returns {OnuwView} */
function view() {
  const current = app.view;
  if (!current || current.gameId !== 'onuw') throw new Error('One Night renderer received another game');
  return current;
}

// ---------------------------------------------------------------- the clock

/**
 * The server sends how long is left at the moment it broadcasts; we count down
 * locally from there and re-sync on the next message. That keeps everyone on
 * the same clock without trusting any two devices to agree on the time.
 */
/** @type {ReturnType<typeof setInterval> | null} */
let clockTimer = null;
/** @type {number | null} */
let spokenStep = null;
/** @type {HTMLAudioElement | null} */
let announcementAudio = null;
/** @type {string[]} */
let announcementQueue = [];
let announcementGeneration = 0;

const AUDIO_ROOT = new URL('../audio/onuw/', import.meta.url);

function audioPlayer() {
  if (announcementAudio || typeof Audio === 'undefined') return announcementAudio;
  announcementAudio = new Audio();
  announcementAudio.preload = 'auto';
  // Event handlers receive an Event argument. Keep it out of the queue runner,
  // whose optional argument is the generation this playback belongs to.
  announcementAudio.onended = () => playNextAnnouncement();
  announcementAudio.onerror = () => playNextAnnouncement();
  return announcementAudio;
}

function stopAnnouncements() {
  announcementGeneration += 1;
  announcementQueue = [];
  if (!announcementAudio) return;
  announcementAudio.pause();
  announcementAudio.removeAttribute?.('src');
  announcementAudio.load?.();
}

function playNextAnnouncement(generation = announcementGeneration) {
  if (generation !== announcementGeneration) return;
  const audio = audioPlayer();
  if (!audio || app?.muted || !announcementQueue.length) return stopAnnouncements();
  const next = announcementQueue.shift();
  if (!next) return stopAnnouncements();
  audio.src = next;
  const started = audio.play();
  // Autoplay policies can still refuse playback when a player has not touched
  // the page. The written call remains visible, and a rejection must never
  // interrupt the game frame that delivered it.
  started?.catch?.(() => {
    if (generation === announcementGeneration) stopAnnouncements();
  });
}

const announcementUrl = (/** @type {string} */ lang, /** @type {string} */ phase, /** @type {string} */ key) =>
  new URL(`${lang}/${phase}-${key}.mp3`, AUDIO_ROOT).href;

/**
 * Prime media playback during the player's first gesture. Mobile browsers
 * otherwise refuse an announcement that begins later from an SSE frame.
 */
function unlockAnnouncements() {
  const audio = audioPlayer();
  if (!audio || announcementQueue.length || !audio.paused) return;
  const generation = announcementGeneration;
  const unlockUrl = new URL('unlock.wav', AUDIO_ROOT).href;
  audio.src = unlockUrl;
  const started = audio.play();
  started?.then?.(() => {
    if (generation !== announcementGeneration || audio !== announcementAudio || audio.src !== unlockUrl) return;
    audio.pause();
    audio.currentTime = 0;
  }).catch?.(() => {});
}

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', unlockAnnouncements, { once: true });
  window.addEventListener('keydown', unlockAnnouncements, { once: true });
}

function stopClock() {
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = null;
}

function paintClock() {
  const current = view();
  if (current.phase !== 'night' || !current.night) return stopClock();
  const num = document.getElementById('nightClock');
  if (num) num.textContent = clockText();
  const bar = document.getElementById('nightBar');
  if (bar) bar.setAttribute('style', `width:${clockFraction() * 100}%`);
}

/**
 * Prefer the local countdown, but fall back to the server's figure until this
 * step has been anchored — otherwise the first paint after a reconnect, or any
 * draw that beats the anchor, shows zero.
 */
function msLeft() {
  const current = view();
  const night = current.phase === 'night' ? current.night : null;
  if (!night) return 0;
  if (app.clockStep !== night.index) return night.msLeft;
  return Math.max(0, (app.stepEndsAt ?? 0) - Date.now());
}
const clockText = () => String(Math.ceil(msLeft() / 1000));
const clockFraction = () => {
  const current = view();
  const total = current.phase === 'night' ? current.night?.msTotal ?? 1 : 1;
  return Math.max(0, Math.min(1, msLeft() / total));
};

/**
 * Play the pre-generated announcement. Every player hears the same line,
 * including the roles nobody was dealt — that is what stops the table reading
 * the deck off what does and does not get called.
 */
/** @param {NonNullable<OnuwNightView['night']>} night */
function announce(night) {
  if (spokenStep === night.index) return;
  const previous = spokenStep;
  spokenStep = night.index;
  if (app.muted) return stopAnnouncements();

  const clips = [];
  const script = view().nightScript;
  const prevKey = previous !== null ? script[previous] : null;
  const lang = app.lang === 'zh' ? 'zh' : 'en';
  if (prevKey && prevKey !== 'nightfall') clips.push(announcementUrl(lang, 'sleep', prevKey));
  clips.push(announcementUrl(lang, 'wake', night.key));
  stopAnnouncements();
  announcementQueue = clips;
  playNextAnnouncement();
}

/**
 * A new frame from the server. Re-anchor the countdown before anything is
 * drawn, so a redraw for an unrelated reason — tapping the mute button, say —
 * paints the time that is actually left rather than the step's full length.
 */
function onView() {
  const current = view();
  const night = current.phase === 'night' ? current.night : null;
  if (!night) { stopClock(); stopAnnouncements(); spokenStep = null; return; }
  app.stepEndsAt = Date.now() + night.msLeft;
  app.clockStep = night.index;
  if (!clockTimer) clockTimer = setInterval(paintClock, 200);
  announce(night);
}

/**
 * House rules are variants, not cards, so they sit under their own heading and
 * keep their description on screen: the table has to be able to read what it is
 * playing with, whether or not anybody touched the switch. Rendered only when
 * the server offers them, so a newer client against an older server shows no
 * switch it cannot actually throw.
 */
const roleName = (/** @type {unknown} */ role) => T(`onuw.role.${String(role)}`);
const nightStepName = (/** @type {string} */ key) => key === 'nightfall'
  ? T('onuw.ref.nightfall')
  : key === 'dawn' ? T('onuw.wake.dawn') : roleName(key);
const houseRuleName = (/** @type {string} */ rule) => T(`onuw.house.${rule}`);

/**
 * How a card is coloured: red for the werewolf side, gold for the tanner, blue
 * for the village. The server owns the rules; this is only the palette, the
 * same way Avalon's client knows which of its own roles are evil.
 */
const WOLF_ROLES = new Set(['werewolf', 'minion']);
const teamTag = (/** @type {string} */ role) => (WOLF_ROLES.has(role) ? 'evil' : role === 'tanner' ? 'gold' : 'good');

/**
 * Centre cards are lettered rather than numbered, so "centre card 2" can never
 * be read as a seat. The server keeps counting them 1, 2, 3: the label is
 * presentation, exactly like role names, so a game already in flight — and a
 * snapshot restored from before this — reads as A, B, C too.
 */
const centreLabel = (/** @type {unknown} */ n) => (
  typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 26 ? String.fromCharCode(64 + n) : String(n)
);

/** Which of an entry's params hold a centre card rather than a player name. */
/** @type {Record<string, string[]>} */
const CENTRE_PARAMS = {
  'onuw.info.sawCentre': ['index'],
  'onuw.info.sawTwoCentre': ['a', 'b'],
  'onuw.info.drunk': ['index'],
  'onuw.swap.drunk': ['index'],
};

/** Role keys arrive raw from the server so each client can name them itself. */
/** @param {Record<string, unknown>} params @param {string} key */
function formatParams(params, key) {
  const out = { ...params };
  for (const k of ['role', 'roleA', 'roleB']) if (out[k]) out[k] = roleName(out[k]);
  for (const k of CENTRE_PARAMS[key] ?? []) out[k] = centreLabel(out[k]);
  if (out.winner) out.winner = out.winner === 'nobody' ? T('onuw.over.nobodyWins') : T(`onuw.team.${out.winner}`);
  return out;
}

const line = (/** @type {GameEvent} */ entry) => T(entry.key, formatParams(entry.params, entry.key));

/** A role shown as an actual card, rather than reducing the reveal to prose. */
/** @param {unknown} role @param {unknown} [caption] */
function cardFront(role, caption) {
  return h('span', { class: 'role-card-front' },
    caption ? h('span', { class: 'role-card-caption', text: caption }) : null,
    rolePortrait(role),
    h('span', { class: 'role-card-name', text: roleName(role) }),
  );
}

/** Turn knowledge gained by looking at a card into the card(s) that were seen. */
/** @param {GameEvent} entry */
function finding(entry) {
  const p = entry.params;
  /** @type {HTMLElement[]} */
  let cards = [];
  if (entry.key === 'onuw.info.sawCentre') {
    cards = [cardFront(p.role, T('onuw.centreCard', { n: centreLabel(p.index) }))];
  } else if (entry.key === 'onuw.info.sawPlayer') {
    cards = [cardFront(p.role, p.name)];
  } else if (entry.key === 'onuw.info.sawTwoCentre') {
    cards = [
      cardFront(p.roleA, T('onuw.centreCard', { n: centreLabel(p.a) })),
      cardFront(p.roleB, T('onuw.centreCard', { n: centreLabel(p.b) })),
    ];
  } else if (entry.key === 'onuw.info.robbed' || entry.key === 'onuw.info.insomniac') {
    cards = [cardFront(p.role)];
  }
  if (!cards.length) return h('p', { class: 'finding', text: line(entry) });
  return h('div', { class: 'finding inspected-finding' },
    h('div', { class: 'inspected-cards' }, cards),
    h('p', { text: line(entry) }),
  );
}

// ---------------------------------------------------------------- lobby

/** @param {Event} event */
function checked(event) {
  const target = event.target;
  return Boolean(target && 'checked' in target && target.checked);
}

function lobbyOptions() {
  const v = view();
  if (v.phase !== 'lobby') throw new Error('expected lobby view');
  const isHost = v.you?.id === v.hostId;

  const toggle = (/** @type {string} */ key) => h('label', { class: `role-option ${v.options[key] ? 'selected' : ''}` },
    h('input', {
      type: 'checkbox', checked: v.options[key], disabled: !isHost,
      onchange: (/** @type {Event} */ e) => send({ type: 'options', options: { [key]: checked(e) } }),
    }),
    rolePortrait(key, { small: true }),
    h('span', { class: 'role-option-copy' },
      h('span', { class: 'role-option-name', text: roleName(key) }),
      h('span', { class: 'role-option-description', text: T(`onuw.roleDesc.${key}`) }),
    ),
  );

  const houseToggle = (/** @type {string} */ rule) => h('label', { class: `house-rule ${v.houseRules[rule] ? 'selected' : ''}` },
    h('input', {
      type: 'checkbox', checked: v.houseRules[rule], disabled: !isHost,
      onchange: (/** @type {Event} */ e) => send({ type: 'options', options: { houseRules: { [rule]: checked(e) } } }),
    }),
    h('span', { class: 'house-rule-copy' },
      h('span', { class: 'house-rule-name', text: houseRuleName(rule) }),
      h('span', { class: 'house-rule-description', text: T(`onuw.houseDesc.${rule}`) }),
    ),
  );

  return h('div', { class: 'card stack' },
    h('h2', { text: T('lobby.roles') }),
    isHost ? null : h('p', { class: 'muted', text: T('lobby.hostOnlyRoles') }),
    h('p', { class: 'option-room', text: T('onuw.optionRoom', { n: v.optionRoom }) }),
    h('div', { class: 'role-options' }, v.setup.options.map(toggle)),
    ...(v.houseRules ? [
      h('h3', { text: T('onuw.houseRules') }),
      h('div', { class: 'house-rules' }, v.setup.houseRules.map(houseToggle)),
    ] : []),
    h('h3', { text: T('onuw.pace') }),
    h('div', { class: 'row pace-picker' }, v.setup.paces.map((pace) => h('button', {
      class: `btn grow ${v.pace === pace ? 'primary' : ''}`, id: `pace-${pace}`, disabled: !isHost,
      onclick: () => {
        if (pace === 'brisk' || pace === 'normal' || pace === 'relaxed') {
          send({ type: 'options', options: { pace } });
        }
      },
    }, T(`onuw.pace.${pace}`)))),
    h('p', { class: 'muted', text: T('onuw.pace.length', { n: Math.round((v.nightSeconds ?? 0)) }) }),
    h('h3', { text: T('onuw.deck') }),
    v.deck
      ? h('div', { class: 'deck' }, Object.entries(v.deck).map(([role, n]) =>
          h('span', { class: `tag ${teamTag(role)}`, text: n > 1 ? `${roleName(role)} ×${n}` : roleName(role) })))
      : h('p', { class: 'muted', text: T('onuw.deckTooBig', { n: v.players.length }) }),
    h('p', { class: 'muted', text: T('onuw.deckHint') }),
    h('h3', { text: T('onuw.ref.order') }),
    h('ol', { class: 'order' }, (v.nightScript ?? []).map((key) => h('li', {
      text: nightStepName(key),
    }))),
  );
}

// ---------------------------------------------------------------- shared bits

/** The card you were dealt. It may not be the card you end up with. */
function cardContent() {
  const v = view();
  if (v.phase === 'lobby') return null;
  if (!v.you?.role) return null;
  const evil = v.you.team === 'werewolf';
  return h('div', { class: 'reveal-card stack' },
    h('div', { class: 'role-hero' },
      rolePortrait(v.you.role),
      h('div', { class: 'role-hero-copy' },
        h('p', { class: 'eyebrow', text: T('onuw.night.yourCard') }),
        h('p', { class: 'role-name', text: roleName(v.you.role) }),
        h('span', {
          class: `faction-sigil ${evil ? 'evil' : 'good'}`,
          title: T(`onuw.team.${v.you.team}`), 'aria-label': T(`onuw.team.${v.you.team}`),
          text: evil ? '☾' : '☀',
        }),
        h('span', { class: 'visually-hidden', text: T(`onuw.team.${v.you.team}`) }),
      ),
    ),
    h('p', { class: 'muted', text: T(`onuw.roleDesc.${v.you.role}`) }),
    // What the night taught you lives here too, behind the same button. On
    // the screens everyone can see over your shoulder, nothing gives you away.
    v.info.length ? h('h3', { text: T('onuw.info.title') }) : null,
    ...v.info.map(finding),
  );
}

/**
 * Three face-down cards, or their faces once the game is over.
 * @param {{ pickable?: boolean, picked?: number[], onpick?: (index: number) => void }} [options]
 */
function centreRow({ pickable = false, picked = [], onpick } = {}) {
  const v = view();
  if (v.phase === 'lobby') throw new Error('centre cards are not available in the lobby');
  const count = v.centreCount ?? 3;
  return h('div', { class: 'centre' }, [...Array(count).keys()].map((i) => {
    const role = v.phase === 'over' ? v.centre[i] : undefined;
    const props = {
      class: `centre-card ${role ? 'card-front' : 'card-back'} ${picked.includes(i) ? 'selected' : ''}`,
      title: T('onuw.centreCard', { n: centreLabel(i + 1) }),
    };
    const inner = [h('span', { class: 'centre-n', text: centreLabel(i + 1) }), role ? cardFront(role) : null];
    return pickable
      ? h('button', { ...props, type: 'button', onclick: () => onpick?.(i) }, inner)
      : h('div', props, inner);
  }));
}

/** @param {{ picked?: string[], onpick?: ((player: OnuwPlayer) => void) | null, exclude?: string[], tags?: (player: OnuwPlayer) => HTMLElement[] }} [options] */
function pickList({ picked = [], onpick, exclude = [], tags } = {}) {
  const v = view();
  return h('div', { class: 'players' }, v.players.map((p) => {
    const isYou = p.id === v.you?.id;
    const inner = [
      avatarOf(p),
      h('span', { class: 'name', text: p.name }),
      isYou ? h('span', { class: 'visually-hidden', text: T('lobby.you') }) : null,
      ...(tags ? tags(p) : []),
    ];
    if (!onpick) return h('div', {
      class: `player ${isYou ? 'is-you' : ''}`, 'aria-current': isYou ? 'true' : null,
    }, inner);
    return h('button', {
      class: `player ${isYou ? 'is-you' : ''} ${picked.includes(p.id) ? 'selected' : ''}`, type: 'button',
      'aria-current': isYou ? 'true' : null,
      disabled: exclude.includes(p.id), onclick: () => onpick(p),
    }, inner);
  }));
}

const waitingNames = () => {
  const current = view();
  if (!('waitingFor' in current)) return '';
  return joinNames(current.waitingFor.map(
    (id) => current.players.find((p) => p.id === id)?.name ?? '?'));
};

// ---------------------------------------------------------------- phases

function header_() {
  const popup = app.infoPopup === 'onuw-card'
    ? infoPopup({
        title: T('onuw.night.yourCard'), closeLabel: T('reveal.hide'), onClose: closeInfoPopup,
      }, cardContent())
    : app.infoPopup === 'onuw-reference'
      ? infoPopup({
          title: T('onuw.ref.title'), closeLabel: T('reveal.hide'), onClose: closeInfoPopup,
        }, referenceContent())
      : null;

  return [
    h('div', { class: 'row info-buttons' },
      h('button', {
        class: 'btn grow info-btn', id: 'cardToggle', type: 'button',
        'aria-haspopup': 'dialog', 'aria-expanded': app.infoPopup === 'onuw-card',
        onclick: () => { app.infoPopup = 'onuw-card'; render(); },
      }, T('onuw.night.yourCard')),
      h('button', {
        class: 'btn grow info-btn', id: 'refToggle', type: 'button',
        'aria-haspopup': 'dialog', 'aria-expanded': app.infoPopup === 'onuw-reference',
        onclick: () => { app.infoPopup = 'onuw-reference'; render(); },
      }, T('onuw.ref.title')),
    ),
    popup,
  ].filter(Boolean);
}

function closeInfoPopup() {
  app.infoPopup = null;
  render();
}

/** The variants this table switched on, in the order they are listed. */
const houseRulesInForce = () => view().setup.houseRules.filter((rule) => view().houseRules?.[rule]);

/**
 * Which roles are in this game, what each of them does, and the order the
 * night runs in. All of it is public — the lobby agreed the deck — so having
 * it on hand just saves asking.
 */
function referenceContent() {
  const v = view();
  const deck = v.deck ?? {};
  const script = v.nightScript ?? [];
  const inForce = houseRulesInForce();

  return h('div', { class: 'stack' },
      h('h3', { text: T('onuw.ref.inPlay', { n: Object.values(deck).reduce((a, b) => a + b, 0) }) }),
      h('div', { class: 'stack tight' }, Object.keys(deck).map((role) => h('div', { class: 'ref-role' },
        rolePortrait(role, { small: true }),
        h('span', { class: `tag ${teamTag(role)}`, text: (deck[role] ?? 0) > 1 ? `${roleName(role)} ×${deck[role]}` : roleName(role) }),
        h('span', { class: 'muted', text: T(`onuw.roleDesc.${role}`) }),
      ))),
      h('h3', { text: T('onuw.ref.order') }),
      h('ol', { class: 'order' }, script.map((key, i) => h('li', {
        class: v.phase === 'night' && v.night?.index === i ? 'now' : '',
        text: nightStepName(key),
      }))),
      h('p', { class: 'muted', text: T('onuw.ref.note') }),
      // The lobby agreed these too, and they decide the vote — so they stay
      // within reach of the argument they are going to come up in.
      ...(inForce.length ? [
        h('h3', { text: T('onuw.houseRules') }),
        h('div', { class: 'stack tight' }, inForce.map((rule) => h('div', { class: 'stack tight' },
          h('div', { class: 'deck' }, h('span', { class: 'tag gold', text: houseRuleName(rule) })),
          h('p', { class: 'muted', text: T(`onuw.houseDesc.${rule}`) }),
        ))),
      ] : []),
  );
}

/** Each night step is a fresh screen, so the middle pane starts at the top again. */
function paneKey() {
  const current = view();
  return String(current.phase === 'night' ? current.night?.index ?? '' : '');
}

function panes() {
  const current = view();
  switch (current.phase) {
    case 'lobby': return [lobbyOptions()];
    case 'reveal': return paneReveal();
    case 'night': return paneNight();
    case 'day': return paneDay();
    case 'vote': return paneVote();
    case 'over': return paneOver();
    default: return assertNever(current);
  }
}

function paneReveal() {
  const v = view();
  if (v.phase !== 'reveal') throw new Error('expected reveal view');
  if (!v.you) throw new Error('expected seated viewer');
  const youId = v.you.id;
  const done = v.players.find((p) => p.id === youId)?.ready;
  return [h('div', { class: 'card stack' },
    h('h2', { text: T('onuw.reveal.title') }),
    pickList({ tags: (p) => ('ready' in p && p.ready ? [h('span', { class: 'tag ok status-glyph', title: T('onuw.reveal.ready'), text: '◆' })] : []) }),
    done
      ? h('p', { class: 'muted', text: T('onuw.reveal.waiting', { names: waitingNames() }) })
      : h('button', { class: 'btn primary wide', onclick: () => send({ type: 'confirm' }) }, T('onuw.reveal.ready')),
  )];
}

function paneNight() {
  const v = view();
  if (v.phase !== 'night') throw new Error('expected night view');
  if (!v.you || !v.night) throw new Error('expected seated viewer and active night step');
  const night = v.night;
  const awake = v.you.awake;

  return [h('div', { class: 'card stack night' },
    h('div', { class: 'row' },
      h('span', { class: 'muted grow', text: T('onuw.night.step', { n: night.index + 1, total: night.total }) }),
      h('button', {
        class: 'btn ghost', id: 'voiceToggle',
        onclick: () => {
          setMuted(!app.muted);
          if (app.muted) stopAnnouncements();
          else unlockAnnouncements();
          render();
        },
      }, `${T('onuw.voice')}: ${app.muted ? '✕' : '🔊'}`),
    ),

    // The announcement and the clock are identical on every screen in the room.
    h('p', { class: 'announce', text: T(`onuw.wake.${night.key}`) }),
    h('div', { class: 'clock' },
      h('span', { class: 'clock-num', id: 'nightClock', text: clockText() }),
    ),
    h('div', { class: 'bar' },
      h('div', { class: 'bar-fill', id: 'nightBar', style: `width:${clockFraction() * 100}%` })),

    night.key === 'dawn'
      ? null
      : awake
      ? h('div', { class: 'stack' },
          h('p', { class: 'yourturn', text: T('onuw.night.yourTurn') }),
          ...v.info.map(finding),
          ...(v.you.action ? actionBody(v.you.action) : []),
        )
      : h('p', { class: 'muted', text: T('onuw.night.keepEyesShut') }),

    h('p', { class: 'muted', text: T('onuw.night.everyoneSameClock') }),
  )];
}

/** @param {NonNullable<NonNullable<OnuwNightView['you']>['action']>} kind */
function actionBody(kind) {
  const current = view();
  if (current.phase !== 'night' || current.you?.acted) {
    return [h('p', { class: 'muted', text: T('onuw.night.hint') })];
  }
  const body = { loneWolf: actLoneWolf, seer: actSeer, robber: actRobber,
                 troublemaker: actTroublemaker, drunk: actDrunk }[kind];
  return [h('p', { text: T(`onuw.act.${kind}`) }), ...body(), h('p', { class: 'muted', text: T('onuw.night.hint') })];
}

const submit = (/** @type {OnuwNightAction} */ action) => send({ type: 'night', action });

function actLoneWolf() {
  return [
    centreRow({ pickable: true, picked: app.centres, onpick: (i) => { app.centres = [i]; render(); } }),
    h('div', { class: 'row' },
      h('button', {
        class: 'btn primary grow', disabled: !app.centres.length,
        onclick: () => submit({ centre: selectedCentre() }),
      }, T('onuw.night.confirm')),
      h('button', { class: 'btn ghost', onclick: () => submit({ skip: true }) }, T('onuw.night.skip')),
    ),
  ];
}

function actSeer() {
  const mode = app.seerMode ?? 'player';
  const setMode = (/** @type {'player' | 'centre'} */ m) => { app.seerMode = m; app.selection = []; app.centres = []; render(); };

  return [
    h('div', { class: 'row' },
      h('button', { class: `btn grow ${mode === 'player' ? 'primary' : ''}`, onclick: () => setMode('player') },
        T('onuw.act.seerPlayer')),
      h('button', { class: `btn grow ${mode === 'centre' ? 'primary' : ''}`, onclick: () => setMode('centre') },
        T('onuw.act.seerCentre')),
    ),
    mode === 'player'
      ? pickList({
          picked: app.selection, exclude: [view().you?.id ?? ''],
          onpick: (p) => { app.selection = [p.id]; render(); },
        })
      : centreRow({
          pickable: true, picked: app.centres,
          onpick: (i) => {
            const at = app.centres.indexOf(i);
            if (at >= 0) app.centres.splice(at, 1);
            else if (app.centres.length < 2) app.centres.push(i);
            render();
          },
        }),
    mode === 'centre' ? h('p', { class: 'muted', text: T('onuw.act.pick', { n: app.centres.length, max: 2 }) }) : null,
    h('div', { class: 'row' },
      h('button', {
        class: 'btn primary grow',
        disabled: mode === 'player' ? !app.selection.length : app.centres.length !== 2,
        onclick: () => submit(mode === 'player'
          ? { mode: 'player', target: selectedPlayer() }
          : { mode: 'centre', centres: selectedCentres() }),
      }, T('onuw.night.confirm')),
      h('button', { class: 'btn ghost', onclick: () => submit({ skip: true }) }, T('onuw.night.skip')),
    ),
  ];
}

function actRobber() {
  return [
    pickList({ picked: app.selection, exclude: [view().you?.id ?? ''],
               onpick: (p) => { app.selection = [p.id]; render(); } }),
    h('div', { class: 'row' },
      h('button', {
        class: 'btn primary grow', disabled: !app.selection.length,
        onclick: () => submit({ target: selectedPlayer() }),
      }, T('onuw.night.confirm')),
      h('button', { class: 'btn ghost', onclick: () => submit({ skip: true }) }, T('onuw.night.skip')),
    ),
  ];
}

function actTroublemaker() {
  return [
    pickList({
      picked: app.selection, exclude: [view().you?.id ?? ''],
      onpick: (p) => {
        const at = app.selection.indexOf(p.id);
        if (at >= 0) app.selection.splice(at, 1);
        else if (app.selection.length < 2) app.selection.push(p.id);
        render();
      },
    }),
    h('p', { class: 'muted', text: T('onuw.act.pick', { n: app.selection.length, max: 2 }) }),
    h('div', { class: 'row' },
      h('button', {
        class: 'btn primary grow', disabled: app.selection.length !== 2,
        onclick: () => submit({ targets: selectedPlayers() }),
      }, T('onuw.night.confirm')),
      h('button', { class: 'btn ghost', onclick: () => submit({ skip: true }) }, T('onuw.night.skip')),
    ),
  ];
}

function actDrunk() {
  return [
    centreRow({ pickable: true, picked: app.centres, onpick: (i) => { app.centres = [i]; render(); } }),
    h('button', {
      class: 'btn primary wide', disabled: !app.centres.length,
      onclick: () => submit({ centre: selectedCentre() }),
    }, T('onuw.night.confirm')),
  ];
}

function selectedPlayer() {
  const selected = app.selection[0];
  if (!selected) throw new Error('expected a selected player');
  return selected;
}

/** @returns {[string, string]} */
function selectedPlayers() {
  const first = app.selection[0];
  const second = app.selection[1];
  if (!first || !second) throw new Error('expected two selected players');
  return [first, second];
}

function selectedCentre() {
  const selected = app.centres[0];
  if (selected === undefined) throw new Error('expected a selected centre card');
  return selected;
}

/** @returns {[number, number]} */
function selectedCentres() {
  const first = app.centres[0];
  const second = app.centres[1];
  if (first === undefined || second === undefined) throw new Error('expected two selected centre cards');
  return [first, second];
}

function paneDay() {
  const v = view();
  if (v.phase !== 'day') throw new Error('expected day view');
  const isHost = v.you?.id === v.hostId;
  return [
    h('div', { class: 'card stack' },
      h('h2', { text: T('onuw.day.title') }),
      h('p', { class: 'muted', text: T('onuw.day.hint') }),
      centreRow(),
      pickList(),
      isHost
        ? h('button', { class: 'btn primary wide', onclick: () => send({ type: 'startVote' }) }, T('onuw.day.startVote'))
        : h('p', { class: 'muted', text: T('onuw.day.waitingHost') }),
    ),
  ];
}

function paneVote() {
  const v = view();
  if (v.phase !== 'vote') throw new Error('expected vote view');
  if (!v.you) throw new Error('expected seated viewer');
  const youId = v.you.id;
  const me = v.players.find((p) => p.id === youId);
  return [
    h('div', { class: 'card stack' },
      h('h2', { text: T('onuw.phase.vote') }),
      me?.voted
        ? h('p', { class: 'muted', text: T('onuw.vote.cast', { name: '—', names: waitingNames() }) })
        : h('p', { text: T('onuw.vote.prompt') }),
      pickList({
        picked: app.selection,
        exclude: me?.voted ? v.players.map((p) => p.id) : [youId],
        onpick: me?.voted ? null : (p) => { app.selection = [p.id]; render(); },
        tags: (p) => ('voted' in p && p.voted ? [h('span', { class: 'tag ok status-glyph', title: T('onuw.vote.cast', { name: '', names: '' }), text: '◆' })] : []),
      }),
      me?.voted ? null : h('button', {
        class: 'btn danger wide', disabled: !app.selection.length,
        onclick: () => send({ type: 'vote', target: selectedPlayer() }),
      }, T('onuw.night.confirm')),
    ),
  ];
}

function paneOver() {
  const v = view();
  if (v.phase !== 'over') throw new Error('expected over view');
  const won = v.youWon;
  const votesReceived = new Map(v.players.map((p) => [p.id, 0]));
  for (const p of v.players) {
    const count = p.votedFor ? votesReceived.get(p.votedFor) : undefined;
    if (p.votedFor && count !== undefined) {
      votesReceived.set(p.votedFor, count + 1);
    }
  }
  const winners = v.winners.length
    ? T('onuw.over.winners', { names: joinNames(v.winners.map((w) => T(`onuw.team.${w}`))) })
    : T('onuw.over.nobodyWins');

  return [
    h('div', { class: 'card stack' },
      h('div', { class: `banner ${won ? 'good' : 'evil'}`, text: won ? T('onuw.over.youWon') : T('onuw.over.youLost') }),
      h('p', { text: winners }),
      h('p', { text: v.dead.length
        ? T('onuw.over.dead', { names: joinNames(v.dead.map((id) => v.players.find((p) => p.id === id)?.name ?? '?')) })
        : T('onuw.over.nobodyDied') }),

      h('h3', { text: T('onuw.over.night') }),
      v.swaps.length
        // Not the journal: this list is the whole point of the screen, so it
        // sizes to its lines instead of scrolling inside a fixed frame.
        ? h('div', { class: 'log night-log' }, v.swaps.map((s) => h('div', { text: line(s) })))
        : h('p', { class: 'muted', text: T('onuw.info.swappedNobody') }),

      h('h3', { text: T('onuw.over.table') }),
      // Each seat's night reads as symbols rather than sentences: the card it
      // was dealt, an arrow, the card it ended with, in its team's colour. The
      // sentences stay on as titles, so nothing is lost to a screen reader.
      h('div', { class: 'players' }, v.players.map((p) => {
        const moved = p.finalRole !== p.startRole;
        const dealt = T('onuw.over.dealt', { role: roleName(p.startRole) });
        const ended = T('onuw.over.ended', { role: roleName(p.finalRole) });
        const cardLabel = moved ? `${dealt} → ${ended}` : dealt;
        const votedFor = p.votedFor && v.players.find((q) => q.id === p.votedFor)?.name;
        const voteLabel = votedFor && T('onuw.over.votedFor', { name: votedFor });
        const voteCount = T('onuw.over.votesReceived', { count: votesReceived.get(p.id) ?? 0 });
        const isYou = p.id === v.you?.id;
        return h('div', {
          class: `player ${isYou ? 'is-you' : ''} ${p.dead ? 'dead' : ''}`,
          'aria-current': isYou ? 'true' : null,
        },
          avatarOf(p),
          p.finalRole ? rolePortrait(p.finalRole, { small: true }) : null,
          h('span', { class: 'name', text: p.name }),
          h('div', { class: 'player-tags' },
            p.finalRole ? h('span', { class: `tag ${teamTag(p.finalRole)}`, role: 'img', title: cardLabel, 'aria-label': cardLabel },
              moved ? h('span', { class: 'was', text: roleName(p.startRole) }) : null,
              moved ? h('span', { class: 'arrow', 'aria-hidden': 'true', text: '→' }) : null,
              roleName(p.finalRole)) : null,
            votedFor
              ? h('span', { class: 'tag', role: 'img', title: voteLabel, 'aria-label': voteLabel },
                  h('span', { class: 'arrow', 'aria-hidden': 'true', text: '☞' }), votedFor)
              : null,
            h('span', { class: 'tag vote-count', text: voteCount }),
            p.dead
              ? h('span', {
                  class: 'tag evil', text: '☠', role: 'img',
                  title: T('onuw.over.dead', { names: p.name }),
                  'aria-label': T('onuw.over.dead', { names: p.name }),
                })
              : null,
          ),
        );
      })),

      h('h3', { text: T('onuw.centre') }),
      centreRow(),

      v.you?.id === v.hostId
        ? h('button', { class: 'btn primary wide', onclick: () => send({ type: 'again' }) }, T('over.again'))
        : h('p', { class: 'muted', text: T('lobby.waitingHost') }),
    ),
  ];
}

function dispose() {
  stopClock();
  stopAnnouncements();
  spokenStep = null;
  window.removeEventListener?.('pointerdown', unlockAnnouncements);
  window.removeEventListener?.('keydown', unlockAnnouncements);
}

return {
  id, rulesKey, taglineKey,
  onView, formatParams, lobbyOptions, header_, paneKey, panes, dispose,
};
}
