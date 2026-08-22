// One Night Werewolf's screens.

import { h } from '../ui.js';

let T, send, app, joinNames, render;

export function bind(ctx) {
  ({ T, send, app, joinNames, render } = ctx);
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

  const toggle = (key) => h('label', { class: 'toggle' },
    h('input', {
      type: 'checkbox', checked: v.options[key], disabled: !isHost,
      onchange: (e) => send('options', { options: { [key]: e.target.checked } }),
    }),
    h('span', {}, roleName(key)),
    h('span', { class: 'muted', text: ` — ${T(`onuw.roleDesc.${key}`)}` }),
  );

  return h('div', { class: 'card stack' },
    h('h2', { text: T('lobby.roles') }),
    isHost ? null : h('p', { class: 'muted', text: T('lobby.hostOnlyRoles') }),
    h('p', { class: 'muted', text: T('onuw.optionRoom', { n: v.optionRoom }) }),
    ...OPTIONS.map(toggle),
    h('h3', { text: T('onuw.deck') }),
    v.deck
      ? h('div', { class: 'deck' }, Object.entries(v.deck).map(([role, n]) =>
          h('span', { class: 'tag', text: n > 1 ? `${roleName(role)} ×${n}` : roleName(role) })))
      : h('p', { class: 'muted', text: T('onuw.deckTooBig', { n: v.players.length }) }),
    h('p', { class: 'muted', text: T('onuw.deckHint') }),
  );
}

// ---------------------------------------------------------------- shared bits

/** The card you were dealt. It may not be the card you end up with. */
function paneCard() {
  const v = app.view;
  if (!v.you?.role) return h('div');
  const evil = v.you.team === 'werewolf';
  return h('div', { class: 'card stack' },
    h('div', { class: 'row' },
      h('h2', { class: 'grow', text: T('onuw.night.yourCard') }),
      h('button', { class: 'btn ghost', onclick: () => { app.showRole = !app.showRole; render(); } },
        app.showRole ? T('reveal.hide') : T('reveal.show')),
    ),
    app.showRole ? h('div', { class: 'reveal-card stack' },
      h('div', {},
        h('p', { class: 'role-name', text: roleName(v.you.role) }),
        h('span', { class: `side ${evil ? 'side-evil' : 'side-good'}`, text: T(`onuw.team.${v.you.team}`) }),
      ),
      h('p', { class: 'muted', text: T(`onuw.roleDesc.${v.you.role}`) }),
      ...v.knowledge.map((k) => h('p', { text: line(k) })),
    ) : null,
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
  return app.view.phase === 'over' ? [] : [paneCard()];
}

export function panes() {
  const byPhase = { night: paneNight, day: paneDay, vote: paneVote, over: paneOver };
  return byPhase[app.view.phase]();
}

function paneNight() {
  const v = app.view;
  const kind = v.you.action;

  if (v.you.acted) {
    return [h('div', { class: 'card stack' },
      h('h2', { text: T('onuw.phase.night') }),
      h('p', { class: 'muted', text: T('onuw.night.done', { names: waitingNames() }) }),
      pickList({ tags: (p) => (p.acted ? [h('span', { class: 'tag ok', text: '✓' })] : []) }),
    )];
  }

  if (!kind) {
    return [h('div', { class: 'card stack' },
      h('h2', { text: T('onuw.phase.night') }),
      h('p', { text: T('onuw.night.nothingToDo') }),
      h('p', { class: 'muted', text: T('onuw.night.waiting', { names: waitingNames() }) }),
      pickList({ tags: (p) => (p.acted ? [h('span', { class: 'tag ok', text: '✓' })] : []) }),
    )];
  }

  const body = { loneWolf: actLoneWolf, seer: actSeer, robber: actRobber,
                 troublemaker: actTroublemaker, drunk: actDrunk }[kind]();

  return [h('div', { class: 'card stack' },
    h('h2', { text: T('onuw.phase.night') }),
    h('p', { text: T(`onuw.act.${kind}`) }),
    ...body,
    h('p', { class: 'muted', text: T('onuw.night.hint') }),
  )];
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
        tags: (p) => (p.voted ? [h('span', { class: 'tag ok', text: '✓' })] : []),
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
