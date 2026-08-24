// One Night Werewolf's screens.

import { h, infoPopup, rolePortrait } from '../ui.js';

let T, send, app, joinNames, render;

export function bind(ctx) {
  ({ T, send, app, joinNames, render } = ctx);
}

// ---------------------------------------------------------------- the clock

/**
 * The server sends how long is left at the moment it broadcasts; we count down
 * locally from there and re-sync on the next message. That keeps everyone on
 * the same clock without trusting any two devices to agree on the time.
 */
let clockTimer = null;
let spokenStep = null;
let announcementAudio = null;
let announcementQueue = [];

const AUDIO_ROOT = new URL('../audio/onuw/', import.meta.url);

function audioPlayer() {
  if (announcementAudio || typeof Audio === 'undefined') return announcementAudio;
  announcementAudio = new Audio();
  announcementAudio.preload = 'auto';
  announcementAudio.onended = playNextAnnouncement;
  announcementAudio.onerror = playNextAnnouncement;
  return announcementAudio;
}

function stopAnnouncements() {
  announcementQueue = [];
  if (!announcementAudio) return;
  announcementAudio.pause();
  announcementAudio.removeAttribute?.('src');
  announcementAudio.load?.();
}

function playNextAnnouncement() {
  const audio = audioPlayer();
  if (!audio || app?.muted || !announcementQueue.length) return stopAnnouncements();
  audio.src = announcementQueue.shift();
  const started = audio.play();
  // Autoplay policies can still refuse playback when a player has not touched
  // the page. The written call remains visible, and a rejection must never
  // interrupt the game frame that delivered it.
  started?.catch?.(() => { announcementQueue = []; });
}

const announcementUrl = (lang, phase, key) =>
  new URL(`${lang}/${phase}-${key}.mp3`, AUDIO_ROOT).href;

/**
 * Prime media playback during the player's first gesture. Mobile browsers
 * otherwise refuse an announcement that begins later from an SSE frame.
 */
function unlockAnnouncements() {
  const audio = audioPlayer();
  if (!audio || announcementQueue.length || !audio.paused) return;
  audio.src = new URL('unlock.wav', AUDIO_ROOT).href;
  const started = audio.play();
  started?.then?.(() => {
    audio.pause();
    audio.currentTime = 0;
  }).catch?.(() => {});
}

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', unlockAnnouncements, { once: true });
  window.addEventListener('keydown', unlockAnnouncements, { once: true });
}

function stopClock() {
  clearInterval(clockTimer);
  clockTimer = null;
}

function paintClock() {
  if (!app.view?.night) return stopClock();
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
  const night = app.view?.night;
  if (!night) return 0;
  if (app.clockStep !== night.index) return night.msLeft;
  return Math.max(0, (app.stepEndsAt ?? 0) - Date.now());
}
const clockText = () => String(Math.ceil(msLeft() / 1000));
const clockFraction = () => {
  const total = app.view?.night?.msTotal ?? 1;
  return Math.max(0, Math.min(1, msLeft() / total));
};

/**
 * Play the pre-generated announcement. Every player hears the same line,
 * including the roles nobody was dealt — that is what stops the table reading
 * the deck off what does and does not get called.
 */
function announce(night) {
  if (spokenStep === night.index) return;
  const previous = spokenStep;
  spokenStep = night.index;
  if (app.muted) return stopAnnouncements();

  const clips = [];
  const script = app.view.nightScript ?? [];
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
export function onView() {
  const night = app.view?.night;
  if (!night) { stopClock(); stopAnnouncements(); spokenStep = null; return; }
  app.stepEndsAt = Date.now() + night.msLeft;
  app.clockStep = night.index;
  if (!clockTimer) clockTimer = setInterval(paintClock, 200);
  announce(night);
}

export const id = 'onuw';
export const minPlayers = 3;
export const rulesKey = 'onuw.rules.body';
export const taglineKey = 'onuw.tagline';

const OPTIONS = ['minion', 'mason', 'drunk', 'insomniac', 'hunter', 'tanner'];
const roleName = (role) => T(`onuw.role.${role}`);

/** Role keys arrive raw from the server so each client can name them itself. */
export function formatParams(params) {
  const out = { ...params };
  for (const key of ['role', 'roleA', 'roleB']) if (out[key]) out[key] = roleName(out[key]);
  if (out.winner) out.winner = out.winner === 'nobody' ? T('onuw.over.nobodyWins') : T(`onuw.team.${out.winner}`);
  return out;
}

const line = (entry) => T(entry.key, formatParams(entry.params));

// ---------------------------------------------------------------- lobby

export function lobbyOptions() {
  const v = app.view;
  const isHost = v.you?.id === v.hostId;

  const toggle = (key) => h('label', { class: `role-option ${v.options[key] ? 'selected' : ''}` },
    h('input', {
      type: 'checkbox', checked: v.options[key], disabled: !isHost,
      onchange: (e) => send('options', { options: { [key]: e.target.checked } }),
    }),
    rolePortrait(key, { small: true }),
    h('span', { class: 'role-option-copy' },
      h('span', { class: 'role-option-name', text: roleName(key) }),
      h('span', { class: 'role-option-description', text: T(`onuw.roleDesc.${key}`) }),
    ),
  );

  return h('div', { class: 'card stack' },
    h('h2', { text: T('lobby.roles') }),
    isHost ? null : h('p', { class: 'muted', text: T('lobby.hostOnlyRoles') }),
    h('p', { class: 'option-room', text: T('onuw.optionRoom', { n: v.optionRoom }) }),
    h('div', { class: 'role-options' }, OPTIONS.map(toggle)),
    h('h3', { text: T('onuw.pace') }),
    h('div', { class: 'row pace-picker' }, ['brisk', 'normal', 'relaxed'].map((pace) => h('button', {
      class: `btn grow ${v.pace === pace ? 'primary' : ''}`, id: `pace-${pace}`, disabled: !isHost,
      onclick: () => send('options', { options: { pace } }),
    }, T(`onuw.pace.${pace}`)))),
    h('p', { class: 'muted', text: T('onuw.pace.length', { n: Math.round((v.nightSeconds ?? 0)) }) }),
    h('h3', { text: T('onuw.deck') }),
    v.deck
      ? h('div', { class: 'deck' }, Object.entries(v.deck).map(([role, n]) =>
          h('span', { class: 'tag', text: n > 1 ? `${roleName(role)} ×${n}` : roleName(role) })))
      : h('p', { class: 'muted', text: T('onuw.deckTooBig', { n: v.players.length }) }),
    h('p', { class: 'muted', text: T('onuw.deckHint') }),
    h('h3', { text: T('onuw.ref.order') }),
    h('ol', { class: 'order' }, (v.nightScript ?? []).map((key) => h('li', {
      text: key === 'nightfall' ? T('onuw.ref.nightfall') : roleName(key),
    }))),
  );
}

// ---------------------------------------------------------------- shared bits

/** The card you were dealt. It may not be the card you end up with. */
function cardContent() {
  const v = app.view;
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
    ...v.info.map((entry) => h('p', { class: 'finding', text: line(entry) })),
  );
}

function paneInfo() {
  const v = app.view;
  if (!v.info.length) return null;
  return h('div', { class: 'card stack' },
    h('h2', { text: T('onuw.info.title') }),
    ...v.info.map((entry) => h('p', { text: line(entry) })),
  );
}

/** Three face-down cards, or their faces once the game is over. */
function centreRow({ pickable = false, picked = [], onpick } = {}) {
  const v = app.view;
  const count = v.centreCount ?? 3;
  return h('div', { class: 'centre' }, [...Array(count).keys()].map((i) => {
    const label = v.centre ? roleName(v.centre[i]) : '?';
    const props = {
      class: `centre-card ${picked.includes(i) ? 'selected' : ''}`,
      title: T('onuw.centreCard', { n: i + 1 }),
    };
    const inner = [h('span', { class: 'centre-n', text: i + 1 }), h('span', { class: 'centre-face', text: label })];
    return pickable
      ? h('button', { ...props, type: 'button', onclick: () => onpick(i) }, inner)
      : h('div', props, inner);
  }));
}

function pickList({ picked = [], onpick, exclude = [], tags } = {}) {
  const v = app.view;
  return h('div', { class: 'players' }, v.players.map((p) => {
    const inner = [
      h('span', { class: 'seat', text: p.seat + 1 }),
      h('span', { class: 'name', text: p.name }),
      p.id === v.you?.id ? h('span', { class: 'tag you', text: T('lobby.you') }) : null,
      ...(tags ? tags(p) : []),
    ];
    if (!onpick) return h('div', { class: 'player' }, inner);
    return h('button', {
      class: `player ${picked.includes(p.id) ? 'selected' : ''}`, type: 'button',
      disabled: exclude.includes(p.id), onclick: () => onpick(p),
    }, inner);
  }));
}

const waitingNames = () => joinNames(app.view.waitingFor.map(
  (id) => app.view.players.find((p) => p.id === id)?.name ?? '?'));

// ---------------------------------------------------------------- phases

export function header_() {
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

/**
 * Which roles are in this game, what each of them does, and the order the
 * night runs in. All of it is public — the lobby agreed the deck — so having
 * it on hand just saves asking.
 */
function referenceContent() {
  const v = app.view;
  const deck = v.deck ?? {};
  const script = v.nightScript ?? [];

  return h('div', { class: 'stack' },
      h('h3', { text: T('onuw.ref.inPlay', { n: Object.values(deck).reduce((a, b) => a + b, 0) }) }),
      h('div', { class: 'stack tight' }, Object.keys(deck).map((role) => h('div', { class: 'ref-role' },
        rolePortrait(role, { small: true }),
        h('span', { class: 'tag', text: deck[role] > 1 ? `${roleName(role)} ×${deck[role]}` : roleName(role) }),
        h('span', { class: 'muted', text: T(`onuw.roleDesc.${role}`) }),
      ))),
      h('h3', { text: T('onuw.ref.order') }),
      h('ol', { class: 'order' }, script.map((key, i) => h('li', {
        class: v.night?.index === i ? 'now' : '',
        text: key === 'nightfall' ? T('onuw.ref.nightfall') : roleName(key),
      }))),
      h('p', { class: 'muted', text: T('onuw.ref.note') }),
  );
}

export function panes() {
  const byPhase = { reveal: paneReveal, night: paneNight, day: paneDay, vote: paneVote, over: paneOver };
  return byPhase[app.view.phase]();
}

function paneReveal() {
  const v = app.view;
  const done = v.players.find((p) => p.id === v.you.id)?.ready;
  return [h('div', { class: 'card stack' },
    h('h2', { text: T('onuw.reveal.title') }),
    pickList({ tags: (p) => (p.ready ? [h('span', { class: 'tag ok status-glyph', title: T('onuw.reveal.ready'), text: '✓' })] : []) }),
    done
      ? h('p', { class: 'muted', text: T('onuw.reveal.waiting', { names: waitingNames() }) })
      : h('button', { class: 'btn primary wide', onclick: () => send('confirm') }, T('onuw.reveal.ready')),
  )];
}

function paneNight() {
  const v = app.view;
  const night = v.night;
  const awake = v.you.awake;

  return [h('div', { class: 'card stack night' },
    h('div', { class: 'row' },
      h('span', { class: 'muted grow', text: T('onuw.night.step', { n: night.index + 1, total: night.total }) }),
      h('button', {
        class: 'btn ghost', id: 'voiceToggle',
        onclick: () => {
          app.muted = !app.muted;
          localStorage.setItem('avalon.muted', app.muted ? '1' : '');
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

    awake
      ? h('div', { class: 'stack' },
          h('p', { class: 'yourturn', text: T('onuw.night.yourTurn') }),
          ...v.info.map((entry) => h('p', { class: 'finding', text: line(entry) })),
          ...(v.you.action ? actionBody(v.you.action) : []),
        )
      : h('p', { class: 'muted', text: T('onuw.night.keepEyesShut') }),

    h('p', { class: 'muted', text: T('onuw.night.everyoneSameClock') }),
  )];
}

function actionBody(kind) {
  if (app.view.you.acted) return [h('p', { class: 'muted', text: T('onuw.night.hint') })];
  const body = { loneWolf: actLoneWolf, seer: actSeer, robber: actRobber,
                 troublemaker: actTroublemaker, drunk: actDrunk }[kind];
  return [h('p', { text: T(`onuw.act.${kind}`) }), ...body(), h('p', { class: 'muted', text: T('onuw.night.hint') })];
}

const submit = (action) => send('night', { action });

function actLoneWolf() {
  return [
    centreRow({ pickable: true, picked: app.centres, onpick: (i) => { app.centres = [i]; render(); } }),
    h('div', { class: 'row' },
      h('button', {
        class: 'btn primary grow', disabled: !app.centres.length,
        onclick: () => submit({ centre: app.centres[0] }),
      }, T('onuw.night.confirm')),
      h('button', { class: 'btn ghost', onclick: () => submit({ skip: true }) }, T('onuw.night.skip')),
    ),
  ];
}

function actSeer() {
  const mode = app.seerMode ?? 'player';
  const setMode = (m) => { app.seerMode = m; app.selection = []; app.centres = []; render(); };

  return [
    h('div', { class: 'row' },
      h('button', { class: `btn grow ${mode === 'player' ? 'primary' : ''}`, onclick: () => setMode('player') },
        T('onuw.act.seerPlayer')),
      h('button', { class: `btn grow ${mode === 'centre' ? 'primary' : ''}`, onclick: () => setMode('centre') },
        T('onuw.act.seerCentre')),
    ),
    mode === 'player'
      ? pickList({
          picked: app.selection, exclude: [app.view.you.id],
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
          ? { mode: 'player', target: app.selection[0] }
          : { mode: 'centre', centres: app.centres }),
      }, T('onuw.night.confirm')),
      h('button', { class: 'btn ghost', onclick: () => submit({ skip: true }) }, T('onuw.night.skip')),
    ),
  ];
}

function actRobber() {
  return [
    pickList({ picked: app.selection, exclude: [app.view.you.id],
               onpick: (p) => { app.selection = [p.id]; render(); } }),
    h('div', { class: 'row' },
      h('button', {
        class: 'btn primary grow', disabled: !app.selection.length,
        onclick: () => submit({ target: app.selection[0] }),
      }, T('onuw.night.confirm')),
      h('button', { class: 'btn ghost', onclick: () => submit({ skip: true }) }, T('onuw.night.skip')),
    ),
  ];
}

function actTroublemaker() {
  return [
    pickList({
      picked: app.selection, exclude: [app.view.you.id],
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
        onclick: () => submit({ targets: app.selection }),
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
      onclick: () => submit({ centre: app.centres[0] }),
    }, T('onuw.night.confirm')),
  ];
}

function paneDay() {
  const v = app.view;
  const isHost = v.you.id === v.hostId;
  return [
    paneInfo(),
    h('div', { class: 'card stack' },
      h('h2', { text: T('onuw.day.title') }),
      h('p', { class: 'muted', text: T('onuw.day.hint') }),
      centreRow(),
      pickList(),
      isHost
        ? h('button', { class: 'btn primary wide', onclick: () => send('startVote') }, T('onuw.day.startVote'))
        : h('p', { class: 'muted', text: T('onuw.day.waitingHost') }),
    ),
  ].filter(Boolean);
}

function paneVote() {
  const v = app.view;
  const me = v.players.find((p) => p.id === v.you.id);
  return [
    paneInfo(),
    h('div', { class: 'card stack' },
      h('h2', { text: T('onuw.phase.vote') }),
      me?.voted
        ? h('p', { class: 'muted', text: T('onuw.vote.cast', { name: '—', names: waitingNames() }) })
        : h('p', { text: T('onuw.vote.prompt') }),
      pickList({
        picked: app.selection,
        exclude: me?.voted ? v.players.map((p) => p.id) : [v.you.id],
        onpick: me?.voted ? null : (p) => { app.selection = [p.id]; render(); },
        tags: (p) => (p.voted ? [h('span', { class: 'tag ok status-glyph', title: T('onuw.vote.cast', { name: '', names: '' }), text: '◆' })] : []),
      }),
      me?.voted ? null : h('button', {
        class: 'btn danger wide', disabled: !app.selection.length,
        onclick: () => send('vote', { target: app.selection[0] }),
      }, T('onuw.night.confirm')),
    ),
  ].filter(Boolean);
}

function paneOver() {
  const v = app.view;
  const won = v.youWon;
  const winners = v.winners.length
    ? T('onuw.over.winners', { names: joinNames(v.winners.map((w) => T(`onuw.team.${w}`))) })
    : T('onuw.over.nobodyWins');

  return [
    h('div', { class: 'card stack' },
      h('div', { class: `banner ${won ? 'good' : 'evil'}`, text: won ? T('onuw.over.youWon') : T('onuw.over.youLost') }),
      h('p', { text: winners }),
      h('p', { text: v.dead.length
        ? T('onuw.over.dead', { names: joinNames(v.dead.map((id) => v.players.find((p) => p.id === id).name)) })
        : T('onuw.over.nobodyDied') }),

      h('h3', { text: T('onuw.over.night') }),
      v.swaps.length
        ? h('div', { class: 'log' }, v.swaps.map((s) => h('div', { text: line(s) })))
        : h('p', { class: 'muted', text: T('onuw.info.swappedNobody') }),

      h('h3', { text: T('onuw.over.table') }),
      h('div', { class: 'players' }, v.players.map((p) => h('div', { class: `player ${p.dead ? 'dead' : ''}` },
        rolePortrait(p.finalRole, { small: true }),
        h('span', { class: 'seat', text: p.seat + 1 }),
        h('span', { class: 'name', text: p.name }),
        h('span', { class: 'tag', text: T('onuw.over.dealt', { role: roleName(p.startRole) }) }),
        p.finalRole !== p.startRole
          ? h('span', { class: 'tag good', text: T('onuw.over.ended', { role: roleName(p.finalRole) }) })
          : null,
        p.votedFor ? h('span', { class: 'tag', text: T('onuw.over.votedFor', { name: v.players.find((q) => q.id === p.votedFor)?.name }) }) : null,
        p.dead ? h('span', { class: 'tag evil', text: '☠' }) : null,
      ))),

      h('h3', { text: T('onuw.centre') }),
      centreRow(),

      v.you.id === v.hostId
        ? h('button', { class: 'btn primary wide', onclick: () => send('again') }, T('over.again'))
        : h('p', { class: 'muted', text: T('lobby.waitingHost') }),
    ),
  ];
}
