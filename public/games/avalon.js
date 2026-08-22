// Avalon's screens. The shell hands over a context so these read the same as
// they did when they lived in app.js.

import { h } from '../ui.js';

let T, send, app, nameOf, namesOf, waitingNames, playerList, render;

export function bind(ctx) {
  ({ T, send, app, nameOf, namesOf, waitingNames, playerList, render } = ctx);
}

export const id = 'avalon';
export const minPlayers = 5;
export const rulesKey = 'rules.body';
export const taglineKey = 'app.tagline';

/** The role toggles the host sets before starting. */
export function lobbyOptions() {
  const v = app.view;
  const isHost = v.you?.id === v.hostId;
  const optionRow = (key) => h('label', { class: 'toggle' },
    h('input', { type: 'checkbox', checked: v.options[key], disabled: !isHost,
      onchange: (e) => send('options', { options: { [key]: e.target.checked } }) }),
    h('span', {}, T(`role.${key}`)),
    h('span', { class: 'muted', text: ` — ${T(`roleDesc.${key}`)}` }),
  );
  return h('div', { class: 'card stack' },
    h('h2', { text: T('lobby.roles') }),
    isHost ? null : h('p', { class: 'muted', text: T('lobby.hostOnlyRoles') }),
    ...['percival', 'morgana', 'mordred', 'oberon'].map(optionRow),
  );
}

/** Everything above the phase panel, once a game is running. */
export function header_() {
  return [paneRole(), paneBoard()];
}

export function panes() {
  const byPhase = {
    reveal: paneReveal, team: paneTeam, vote: paneVote,
    quest: paneQuest, assassin: paneAssassin, over: paneOver,
  };
  return byPhase[app.view.phase]();
}

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
