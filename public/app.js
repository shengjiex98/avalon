import { LANGS, detectLang, t } from './i18n.js';

// ---------------------------------------------------------------- state

const app = {
  lang: detectLang(),
  code: null,
  playerId: null,
  view: null,        // latest server view, or null before the first event
  connected: false,
  selection: [],     // team the leader is building
  showRole: true,
  source: null,      // EventSource
  retry: 0,
};

const el = (id) => document.getElementById(id);
const T = (key, params) => t(app.lang, key, params);

const store = {
  get name() { return localStorage.getItem('avalon.name') ?? ''; },
  set name(v) { localStorage.setItem('avalon.name', v); },
  playerFor: (code) => localStorage.getItem(`avalon.player.${code}`),
  setPlayer: (code, id) => localStorage.setItem(`avalon.player.${code}`, id),
  clearPlayer: (code) => localStorage.removeItem(`avalon.player.${code}`),
};

// ---------------------------------------------------------------- dom helper

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'disabled' || key === 'checked' || key === 'hidden') node[key] = Boolean(value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

let toastTimer;
function toast(message, kind = 'error') {
  const box = el('toast');
  box.textContent = message;
  box.className = `toast ${kind === 'info' ? 'info' : ''}`;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 4000);
}

// ---------------------------------------------------------------- transport

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
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
  const source = new EventSource(`/api/rooms/${app.code}/events?playerId=${encodeURIComponent(app.playerId)}`);
  app.source = source;

  source.onmessage = (event) => {
    app.connected = true;
    app.retry = 0;
    const next = JSON.parse(event.data);
    // Drop a stale team selection whenever the round or phase moves on.
    if (!app.view || next.phase !== app.view.phase || next.round !== app.view.round) app.selection = [];
    app.view = next;
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
  const { code } = await api('/api/rooms', { body: {} });
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
    location.hash = `#/${code}`;
    connect();
    render();
  } catch (err) {
    toast(T(`err.${err.key}`, err.params));
  }
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
    location.hash = '';
    app.code = null;
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
  el('rulesBody').textContent = T('rules.body');

  const conn = el('conn');
  conn.hidden = !app.code || app.connected;
  conn.textContent = T('conn.lost');

  const view = el('view');
  view.replaceChildren(...(app.code && app.view ? screenGame() : screenHome()));
}

function screenHome() {
  const hashCode = (location.hash.match(/^#\/([A-Za-z0-9]{4,8})$/) ?? [])[1] ?? '';
  return [
    h('div', { class: 'card stack' },
      h('p', { class: 'muted', text: T('app.tagline') }),
      h('label', {}, T('home.name'),
        h('input', { type: 'text', id: 'nameInput', maxlength: '24', value: store.name,
                     placeholder: T('home.namePlaceholder'), autocomplete: 'nickname' })),
      h('button', { class: 'btn primary wide', onclick: () => createRoom().catch((e) => toast(T(`err.${e.key ?? 'network'}`, e.params))) },
        T('home.create')),
    ),
    h('div', { class: 'card stack' },
      h('h2', { text: T('home.join') }),
      h('label', {}, T('home.code'),
        h('input', { type: 'text', id: 'codeInput', maxlength: '8', value: hashCode.toUpperCase(),
                     placeholder: T('home.codePlaceholder'), autocapitalize: 'characters', autocomplete: 'off',
                     onkeydown: (e) => { if (e.key === 'Enter') doJoin(); } })),
      h('button', { class: 'btn wide', onclick: doJoin }, T('home.go')),
    ),
    h('button', { class: 'btn ghost', onclick: () => el('rules').showModal() }, T('home.rulesLink')),
  ];

  function doJoin() {
    const name = readName();
    const code = el('codeInput').value.trim().toUpperCase();
    if (!name) return;
    if (!code) { toast(T('err.noSuchRoom')); return; }
    joinRoom(code, name);
  }
}

function screenGame() {
  const v = app.view;
  const byPhase = {
    lobby: paneLobby, reveal: paneReveal, team: paneTeam,
    vote: paneVote, quest: paneQuest, assassin: paneAssassin, over: paneOver,
  };
  return [
    ...(v.phase === 'lobby' ? [] : [paneRole(), paneBoard()]),
    ...byPhase[v.phase](),
    paneLog(),
  ];
}

const nameOf = (id) => app.view.players.find((p) => p.id === id)?.name ?? '?';
const namesOf = (ids) => ids.map(nameOf).join(app.lang === 'zh' ? '、' : ', ');
const waitingNames = () => namesOf(app.view.waitingFor);

// ---- lobby

function paneLobby() {
  const v = app.view;
  const isHost = v.you?.id === v.hostId;
  const optionRow = (key) => h('label', { class: 'toggle' },
    h('input', { type: 'checkbox', checked: v.options[key], disabled: !isHost,
      onchange: (e) => send('options', { options: { [key]: e.target.checked } }) }),
    h('span', {}, T(`role.${key}`)),
    h('span', { class: 'muted', text: ` — ${T(`roleDesc.${key}`)}` }),
  );

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
    h('div', { class: 'card stack' },
      h('h2', { text: T('lobby.roles') }),
      isHost ? null : h('p', { class: 'muted', text: T('lobby.hostOnlyRoles') }),
      ...['percival', 'morgana', 'mordred', 'oberon'].map(optionRow),
    ),
    h('div', { class: 'row' },
      isHost
        ? h('button', {
            class: 'btn primary grow', disabled: v.players.length < 5,
            onclick: () => send('start'),
          }, v.players.length < 5 ? T('lobby.needMore', { min: 5, n: v.players.length }) : T('lobby.start'))
        : h('span', { class: 'muted grow', text: T('lobby.waitingHost') }),
      h('button', { class: 'btn ghost', onclick: leaveRoom }, T('lobby.leave')),
    ),
  ];
}

function copyLink() {
  const link = `${location.origin}/#/${app.code}`;
  navigator.clipboard?.writeText(link)
    .then(() => toast(T('lobby.copied'), 'info'))
    .catch(() => toast(link, 'info'));
}

// ---- role + board (shown in every in-game phase)

function paneRole() {
  const v = app.view;
  if (!v.you?.role) return h('div');
  const side = v.you.side;
  return h('div', { class: 'card stack' },
    h('div', { class: 'row' },
      h('h2', { class: 'grow', text: T('know.title') }),
      h('button', { class: 'btn ghost', onclick: () => { app.showRole = !app.showRole; render(); } },
        app.showRole ? T('reveal.hide') : T('reveal.show')),
    ),
    app.showRole ? h('div', { class: 'reveal-card stack' },
      h('div', {},
        h('p', { class: 'role-name', text: T(`role.${v.you.role}`) }),
        h('span', { class: `side ${side === 'evil' ? 'side-evil' : 'side-good'}`, text: T(`side.${side}`) }),
      ),
      h('p', { class: 'muted', text: T(`roleDesc.${v.you.role}`) }),
      v.knowledge.length
        ? h('div', { class: 'players' }, v.knowledge.map((k) => h('div', { class: 'player' },
            h('span', { class: 'name', text: nameOf(k.playerId) }),
            h('span', { class: `tag ${k.hint === 'evil' ? 'evil' : ''}`, text: T(`know.${k.hint}`) }),
          )))
        : h('p', { class: 'muted', text: T('know.nothing') }),
    ) : null,
  );
}

function paneBoard() {
  const v = app.view;
  return h('div', { class: 'card stack' },
    h('div', { class: 'row' },
      h('h2', { class: 'grow', text: T('board.title') }),
      h('span', { class: 'muted', text: T('board.evilCount', { n: v.evilCount, total: v.players.length }) }),
    ),
    h('div', { class: 'board' }, v.boardSizes.map((q, i) => {
      const done = v.quests.find((x) => x.round === i);
      const cls = ['quest', done ? (done.success ? 'success' : 'fail') : '', i === v.round && v.phase !== 'over' ? 'current' : ''];
      return h('div', { class: cls.filter(Boolean).join(' ') },
        h('span', { class: 'size', text: done ? (done.success ? '✓' : '✕') : q.size }),
        h('span', { class: 'hint', text: done ? T('board.players', { n: q.size }) : (q.twoFails ? T('board.twoFails') : '') }),
      );
    })),
    h('div', { class: 'row' },
      h('span', { class: 'muted', text: T('board.rejects', { n: v.rejects, max: v.maxRejects }) }),
      h('div', { class: 'rejects' }, [0, 1, 2, 3, 4].map((i) => h('div', {
        class: `pip ${i < v.rejects ? 'on' : ''} ${i === 4 ? 'last' : ''}`,
      }))),
    ),
    v.rejects === v.maxRejects - 1 ? h('div', { class: 'banner evil', text: T('board.rejectWarn') }) : null,
    v.lastVote ? h('p', { class: 'muted', text: T('vote.result', {
      n: v.lastVote.attempt,
      yes: Object.values(v.lastVote.votes).filter(Boolean).length,
      no: Object.values(v.lastVote.votes).filter((x) => !x).length,
      outcome: T(v.lastVote.approved ? 'vote.approved' : 'vote.rejected'),
    }) }) : null,
  );
}

// ---- phases

function paneReveal() {
  const v = app.view;
  const done = v.players.find((p) => p.id === v.you.id)?.ready;
  return [h('div', { class: 'card stack' },
    h('h2', { text: T('phase.reveal') }),
    playerList({ tags: (p) => (p.ready ? [h('span', { class: 'tag ok', text: '✓' })] : []) }),
    done
      ? h('p', { class: 'muted', text: T('reveal.waiting', { names: waitingNames() }) })
      : h('button', { class: 'btn primary wide', onclick: () => send('confirm') }, T('reveal.confirm')),
  )];
}

function paneTeam() {
  const v = app.view;
  const leader = v.players.find((p) => p.isLeader);
  const isLeader = leader?.id === v.you.id;
  const full = app.selection.length === v.teamSize;

  return [h('div', { class: 'card stack' },
    h('h2', { text: T('phase.team') }),
    h('p', {}, isLeader
      ? T('team.yourTurn', { n: v.teamSize, round: v.round + 1 })
      : T('team.theirTurn', { name: leader?.name ?? '?', n: v.teamSize, round: v.round + 1 })),
    v.failsRequired === 2 ? h('p', { class: 'muted', text: T('quest.needsTwo') }) : null,
    playerList({
      selectable: isLeader,
      selected: app.selection,
      onpick: (p) => {
        const i = app.selection.indexOf(p.id);
        if (i >= 0) app.selection.splice(i, 1);
        else if (app.selection.length < v.teamSize) app.selection.push(p.id);
        render();
      },
    }),
    isLeader ? h('div', { class: 'row' },
      h('span', { class: 'muted grow', text: T('team.selected', { n: app.selection.length, max: v.teamSize }) }),
      h('button', { class: 'btn primary', disabled: !full, onclick: () => send('propose', { team: app.selection }) },
        T('team.submit')),
    ) : null,
  )];
}

function paneVote() {
  const v = app.view;
  const voted = v.players.find((p) => p.id === v.you.id)?.hasVoted;
  return [h('div', { class: 'card stack' },
    h('h2', { text: T('phase.vote') }),
    h('p', { text: T('vote.team', { names: namesOf(v.team) }) }),
    playerList({ tags: (p) => [
      p.onTeam ? h('span', { class: 'tag team', text: T('phase.quest') }) : null,
      p.hasVoted ? h('span', { class: 'tag ok', text: '✓' }) : null,
    ].filter(Boolean) }),
    voted
      ? h('p', { class: 'muted', text: T('vote.cast', { names: waitingNames() }) })
      : h('div', { class: 'stack' },
          h('p', { text: T('vote.prompt') }),
          h('div', { class: 'row' },
            h('button', { class: 'btn primary grow', onclick: () => send('vote', { approve: true }) }, T('vote.approve')),
            h('button', { class: 'btn danger grow', onclick: () => send('vote', { approve: false }) }, T('vote.reject')),
          ),
        ),
  )];
}

function paneQuest() {
  const v = app.view;
  const me = v.players.find((p) => p.id === v.you.id);
  const onTeam = me?.onTeam;
  const played = me?.hasPlayed;

  return [h('div', { class: 'card stack' },
    h('h2', { text: T('phase.quest') }),
    h('p', { text: T('quest.watching', { round: v.round + 1, names: namesOf(v.team) }) }),
    v.failsRequired === 2 ? h('p', { class: 'muted', text: T('quest.needsTwo') }) : null,
    playerList({ only: v.team, tags: (p) => (p.hasPlayed ? [h('span', { class: 'tag ok', text: '✓' })] : []) }),
    onTeam && !played ? h('div', { class: 'stack' },
      h('p', { text: T('quest.prompt') }),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary grow', onclick: () => send('card', { success: true }) }, T('quest.success')),
        v.you.side === 'evil'
          ? h('button', { class: 'btn danger grow', onclick: () => send('card', { success: false }) }, T('quest.fail'))
          : h('span', { class: 'muted grow', text: T('quest.goodCannotFail') }),
      ),
    ) : h('p', { class: 'muted', text: T(onTeam ? 'quest.played' : 'reveal.waiting', { names: waitingNames() }) }),
  )];
}

function paneAssassin() {
  const v = app.view;
  const isAssassin = v.you.role === 'assassin';
  return [h('div', { class: 'card stack' },
    h('h2', { text: T('phase.assassin') }),
    h('p', { text: T(isAssassin ? 'assassin.you' : 'assassin.other') }),
    playerList({
      selectable: isAssassin,
      selected: app.selection,
      onpick: (p) => { app.selection = [p.id]; render(); },
      exclude: isAssassin ? v.knowledge.map((k) => k.playerId).concat(v.you.id) : [],
    }),
    isAssassin ? h('button', {
      class: 'btn danger wide', disabled: !app.selection.length,
      onclick: () => send('assassinate', { target: app.selection[0] }),
    }, T('assassin.kill', { name: app.selection.length ? nameOf(app.selection[0]) : '…' })) : null,
  )];
}

function paneOver() {
  const v = app.view;
  const good = v.winner === 'good';
  return [h('div', { class: 'card stack' },
    h('div', { class: `banner ${good ? 'good' : 'evil'}`, text: T(good ? 'over.goodWins' : 'over.evilWins') }),
    h('p', { text: T(v.winReason) }),
    v.assassinTarget ? h('p', { class: 'muted', text: T('over.assassinPicked', { name: nameOf(v.assassinTarget) }) }) : null,
    h('h3', { text: T('over.roles') }),
    h('div', { class: 'players' }, v.players.map((p) => h('div', { class: 'player' },
      h('span', { class: 'seat', text: p.seat + 1 }),
      h('span', { class: 'name', text: p.name }),
      h('span', { class: 'tag', text: T(`role.${p.role}`) }),
      h('span', { class: `tag ${p.role && sideOfRole(p.role) === 'evil' ? 'evil' : 'good'}`,
                  text: T(`side.${sideOfRole(p.role)}`) }),
    ))),
    v.you.id === v.hostId
      ? h('button', { class: 'btn primary wide', onclick: () => send('again') }, T('over.again'))
      : h('p', { class: 'muted', text: T('lobby.waitingHost') }),
  )];
}

const EVIL_ROLES = new Set(['assassin', 'morgana', 'mordred', 'oberon', 'minion']);
const sideOfRole = (role) => (EVIL_ROLES.has(role) ? 'evil' : 'good');

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
  return h('div', { class: 'card' },
    h('h2', { text: T('log.title') }),
    h('div', { class: 'log' }, entries.map((e) => h('div', {
      text: T(e.key, formatParams(e.params)),
    }))),
  );
}

function formatParams(params) {
  const out = { ...params };
  if (Array.isArray(out.members)) out.members = out.members.join(app.lang === 'zh' ? '、' : ', ');
  if (out.winner) out.winner = T(`side.${out.winner}`);
  return out;
}

// ---------------------------------------------------------------- boot

el('langToggle').addEventListener('click', () => {
  app.lang = app.lang === 'en' ? 'zh' : 'en';
  localStorage.setItem('avalon.lang', app.lang);
  render();
});

window.addEventListener('hashchange', () => {
  if (!app.code) render();
});

// A refresh inside a room reconnects silently if we still hold that seat.
(function boot() {
  const code = (location.hash.match(/^#\/([A-Za-z0-9]{4,8})$/) ?? [])[1]?.toUpperCase();
  const playerId = code && store.playerFor(code);
  if (code && playerId) {
    app.code = code;
    app.playerId = playerId;
    api(`/api/rooms/${code}/join`, { body: { name: store.name, playerId } })
      .then(() => connect())
      .catch(() => { store.clearPlayer(code); app.code = null; app.playerId = null; render(); });
  }
  render();
})();
