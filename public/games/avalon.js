// Avalon's screens. The shell hands over a context so these read the same as
// they did when they lived in app.js.

import { h, infoPopup, rolePortrait } from '../ui.js';

let T, send, app, nameOf, namesOf, waitingNames, playerList, render;

export function bind(ctx) {
  ({ T, send, app, nameOf, namesOf, waitingNames, playerList, render } = ctx);
}

export const id = 'avalon';
export const minPlayers = 5;
export const rulesKey = 'rules.body';
export const taglineKey = 'app.tagline';

/** Each round is a fresh screen, so the middle pane starts at the top again. */
export function paneKey() { return String(app.view.round); }

/**
 * House rules are variants, not cards, so they sit under their own heading and
 * keep their description on screen: the table has to be able to read what it is
 * playing with, whether or not anybody touched the switch. Rendered only when
 * the server offers them, so a newer client against an older server shows no
 * switch it cannot actually throw.
 */
const HOUSE_RULES = ['randomLeader', 'hiddenVotes', 'resetRejects'];
const houseRuleName = (rule) => T(`avalon.house.${rule}`);

/** The role toggles and house rules the host sets before starting. */
export function lobbyOptions() {
  const v = app.view;
  const isHost = v.you?.id === v.hostId;
  const optionRow = (key) => h('label', { class: `role-option ${v.options[key] ? 'selected' : ''}` },
    h('input', { type: 'checkbox', checked: v.options[key], disabled: !isHost,
      onchange: (e) => send('options', { options: { [key]: e.target.checked } }) }),
    rolePortrait(key, { small: true }),
    h('span', { class: 'role-option-copy' },
      h('span', { class: 'role-option-name', text: T(`role.${key}`) }),
      h('span', { class: 'role-option-description', text: T(`roleDesc.${key}`) }),
    ),
  );

  const houseToggle = (rule) => h('label', { class: `house-rule ${v.houseRules[rule] ? 'selected' : ''}` },
    h('input', {
      type: 'checkbox', checked: v.houseRules[rule], disabled: !isHost,
      onchange: (e) => send('options', { options: { houseRules: { [rule]: e.target.checked } } }),
    }),
    h('span', { class: 'house-rule-copy' },
      h('span', { class: 'house-rule-name', text: houseRuleName(rule) }),
      h('span', { class: 'house-rule-description', text: T(`avalon.houseDesc.${rule}`) }),
    ),
  );

  return h('div', { class: 'card stack' },
    h('h2', { text: T('lobby.roles') }),
    isHost ? null : h('p', { class: 'muted', text: T('lobby.hostOnlyRoles') }),
    h('div', { class: 'role-options' }, ['percival', 'morgana', 'mordred', 'oberon'].map(optionRow)),
    // The deck the toggles above add up to. It follows the table size on its
    // own, so the usual answer to "what are we playing?" is already on screen.
    // Drawn only when the server works it out, so a newer client against an
    // older one shows no deck rather than an empty one.
    ...(v.deck !== undefined ? [
      h('h3', { text: T('avalon.deck') }),
      v.deck
        ? h('div', { class: 'deck' }, Object.entries(v.deck).map(([role, n]) =>
            h('span', { class: `tag ${sideOfRole(role)}`, text: n > 1 ? `${T(`role.${role}`)} ×${n}` : T(`role.${role}`) })))
        : h('p', { class: 'muted', text: T('avalon.deckTooBig', { n: v.players.length }) }),
      h('p', { class: 'muted', text: T('avalon.deckHint') }),
    ] : []),
    ...(v.houseRules ? [
      h('h3', { text: T('avalon.houseRules') }),
      h('div', { class: 'house-rules' }, HOUSE_RULES.map(houseToggle)),
    ] : []),
  );
}

/** Everything above the phase panel, once a game is running. */
export function header_() {
  const popup = app.infoPopup === 'avalon-role'
    ? infoPopup({
        title: T('know.title'), closeLabel: T('reveal.hide'), onClose: closeInfoPopup,
      }, roleContent())
    : app.infoPopup === 'avalon-reference'
      ? infoPopup({
          title: T('avalon.ref.title'), closeLabel: T('reveal.hide'), onClose: closeInfoPopup,
        }, referenceContent())
    : null;

  return [
    h('div', { class: 'row info-buttons' },
      h('button', {
        class: 'btn grow info-btn', id: 'roleToggle', type: 'button',
        'aria-haspopup': 'dialog', 'aria-expanded': app.infoPopup === 'avalon-role',
        onclick: () => { app.infoPopup = 'avalon-role'; render(); },
      }, T('reveal.show')),
      h('button', {
        class: 'btn grow info-btn', id: 'avalonRefToggle', type: 'button',
        'aria-haspopup': 'dialog', 'aria-expanded': app.infoPopup === 'avalon-reference',
        onclick: () => { app.infoPopup = 'avalon-reference'; render(); },
      }, T('avalon.ref.title')),
    ),
    popup,
    paneBoard(),
  ].filter(Boolean);
}

export function panes() {
  const byPhase = {
    reveal: paneReveal, team: paneTeam, vote: paneVote,
    quest: paneQuest, assassin: paneAssassin, over: paneOver,
  };
  return byPhase[app.view.phase]();
}

function roleContent() {
  const v = app.view;
  if (!v.you?.role) return null;
  const side = v.you.side;
  return h('div', { class: 'reveal-card stack' },
    h('div', { class: 'role-hero' },
      rolePortrait(v.you.role),
      h('div', { class: 'role-hero-copy' },
        h('p', { class: 'eyebrow', text: T('know.title') }),
        h('p', { class: 'role-name', text: T(`role.${v.you.role}`) }),
        h('span', {
          class: `faction-sigil ${side}`, title: T(`side.${side}`),
          'aria-label': T(`side.${side}`), text: side === 'evil' ? '☾' : '☀',
        }),
        h('span', { class: 'visually-hidden', text: T(`side.${side}`) }),
      ),
    ),
    h('p', { class: 'muted', text: T(`roleDesc.${v.you.role}`) }),
    v.knowledge.length
      ? h('div', { class: 'players' }, v.knowledge.map((k) => h('div', { class: 'player' },
          h('span', { class: 'name', text: nameOf(k.playerId) }),
          // "Evil" is the sigil above, not a word; a hint that names two roles
          // has nothing to draw and stays as text.
          k.hint === 'evil'
            ? h('span', {
                class: 'faction-sigil mini evil', text: '☾', role: 'img',
                title: T('know.evil'), 'aria-label': T('know.evil'),
              })
            : h('span', { class: 'tag', text: T(`know.${k.hint}`) }),
        )))
      : h('p', { class: 'muted', text: T('know.nothing') }),
  );
}

function closeInfoPopup() {
  app.infoPopup = null;
  render();
}

/** The variants this table switched on, in the order they are listed. */
const houseRulesInForce = () => HOUSE_RULES.filter((rule) => app.view.houseRules?.[rule]);

/** Public role composition and abilities, without revealing who holds what. */
function referenceContent() {
  const counts = app.view.roleCounts ?? {};
  const roles = Object.keys(counts);
  const inForce = houseRulesInForce();
  return h('div', { class: 'stack' },
    h('h3', { text: T('avalon.ref.inPlay', { n: app.view.players.length }) }),
    ...['good', 'evil'].map((side) => h('div', { class: 'stack tight' },
      h('h3', { text: T(`side.${side}`) }),
      ...roles.filter((role) => sideOfRole(role) === side).map((role) => h('div', { class: 'ref-role' },
        rolePortrait(role, { small: true }),
        h('span', {
          class: `tag ${side === 'evil' ? 'evil' : 'good'}`,
          text: counts[role] > 1 ? `${T(`role.${role}`)} ×${counts[role]}` : T(`role.${role}`),
        }),
        h('span', { class: 'muted', text: T(`roleDesc.${role}`) }),
      )),
    )),
    // The lobby agreed these too, and they decide how the game ends — so they
    // stay within reach of the argument they are going to come up in.
    ...(inForce.length ? [
      h('h3', { text: T('avalon.houseRules') }),
      h('div', { class: 'stack tight' }, inForce.map((rule) => h('div', { class: 'stack tight' },
        h('div', { class: 'deck' }, h('span', { class: 'tag gold', text: houseRuleName(rule) })),
        h('p', { class: 'muted', text: T(`avalon.houseDesc.${rule}`) }),
      ))),
    ] : []),
  );
}

function paneBoard() {
  const v = app.view;
  return h('div', { class: 'card stack board-card' },
    h('div', { class: 'row' },
      h('h2', { class: 'grow', text: T('board.title') }),
      h('span', {
        class: 'evil-count', title: T('board.evilCount', { n: v.evilCount, total: v.players.length }),
        'aria-label': T('board.evilCount', { n: v.evilCount, total: v.players.length }),
        text: `☾ ${v.evilCount}`,
      }),
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
    v.rejects === v.maxRejects - 1
      ? h('div', { class: 'banner evil', text: T('board.rejectWarn') })
      : null,
    voteResult(),
  );
}

/**
 * How the last vote went. The tally is always public — it is what decided the
 * mission — but the ballots behind it are only drawn when the table is playing
 * with open votes. An older server sends no tally, so it is read back off the
 * ballots in that case.
 */
function voteResult() {
  const v = app.view;
  const tally = v.voteTally ?? (v.lastVote ? {
    attempt: v.lastVote.attempt,
    approved: v.lastVote.approved,
    yes: Object.values(v.lastVote.votes).filter(Boolean).length,
    no: Object.values(v.lastVote.votes).filter((x) => !x).length,
  } : null);
  if (!tally) return null;

  return h('div', { class: 'stack tight vote-result' },
    h('p', { class: 'muted', text: T('vote.result', {
      n: tally.attempt,
      yes: tally.yes,
      no: tally.no,
      outcome: T(tally.approved ? 'vote.approved' : 'vote.rejected'),
    }) }),
    v.lastVote
      ? h('div', { class: 'players' }, v.players.map((p) => {
          const approved = v.lastVote.votes[p.id];
          return h('div', { class: 'player' },
            h('span', { class: 'name', text: p.name }),
            h('span', {
              class: `tag verdict ${approved ? 'ok' : 'evil'}`, role: 'img',
              title: T(approved ? 'vote.approve' : 'vote.reject'),
              'aria-label': T(approved ? 'vote.approve' : 'vote.reject'),
              text: approved ? '✓' : '✕',
            }),
          );
        }))
      : h('p', { class: 'muted', text: T('vote.hidden') }),
  );
}

// ---- phases

function paneReveal() {
  const v = app.view;
  const done = v.players.find((p) => p.id === v.you.id)?.ready;
  return [h('div', { class: 'card stack' },
    h('h2', { text: T('phase.reveal') }),
    playerList({ tags: (p) => (p.ready ? [h('span', { class: 'tag ok status-glyph', title: T('reveal.confirm'), text: '◆' })] : []) }),
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
    // The proposed team already wears the sword the list draws for it. During
    // voting, reveal only that a choice is locked in — the tick or cross
    // appears for everyone once the vote resolves.
    playerList({ tags: (p) => (p.hasVoted
      ? [h('span', { class: 'tag ok status-glyph', title: T('vote.voted'), text: '◆' })]
      : []) }),
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
    playerList({ only: v.team, tags: (p) => (p.hasPlayed ? [h('span', { class: 'tag ok status-glyph', title: T('quest.played'), text: '◆' })] : []) }),
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
      rolePortrait(p.role, { small: true }),
      h('span', { class: 'seat', text: p.seat + 1 }),
      h('span', { class: 'name', text: p.name }),
      h('span', { class: `tag ${sideOfRole(p.role)}`, text: T(`role.${p.role}`) }),
      h('span', {
        class: `faction-sigil mini ${sideOfRole(p.role)}`,
        title: T(`side.${sideOfRole(p.role)}`),
        'aria-label': T(`side.${sideOfRole(p.role)}`),
        text: sideOfRole(p.role) === 'evil' ? '☾' : '☀',
      }),
    ))),
    v.you.id === v.hostId
      ? h('button', { class: 'btn primary wide', onclick: () => send('again') }, T('over.again'))
      : h('p', { class: 'muted', text: T('lobby.waitingHost') }),
  )];
}

const EVIL_ROLES = new Set(['assassin', 'morgana', 'mordred', 'oberon', 'minion']);
const sideOfRole = (role) => (EVIL_ROLES.has(role) ? 'evil' : 'good');
