// Avalon's screens. The shell hands over a context so these read the same as
// they did when they lived in app.ts.

import { h, infoPopup, playerAvatar, rolePortrait } from '../ui.ts';
import { assertNever } from '../assert-never.ts';
import type { AvalonView } from '../../contracts/views.ts';
import type { AvalonRendererContext } from '../renderer-types.ts';


export const id: 'avalon' = 'avalon';
export const rulesKey = 'rules.body';
export const taglineKey = 'app.tagline';

/** Construct one renderer with an explicit, immutable shell context. */
export function createRenderer(ctx: AvalonRendererContext) {
const { T, send, app, nameOf, namesOf, waitingNames, playerList, render } = ctx;
const avatarOf = (player: { name: string; avatar: string | null; seat?: number } | undefined) =>
  playerAvatar(player, app.server ?? undefined);

function view(): AvalonView {
  const current = app.view;
  if (!current || current.gameId !== 'avalon') throw new Error('Avalon renderer received another game');
  return current;
}

/** Each round is a fresh screen, so the middle pane starts at the top again. */
function paneKey() {
  const current = view();
  return String('round' in current ? current.round : '');
}

/**
 * House rules are variants, not cards, so they sit under their own heading and
 * keep their description on screen: the table has to be able to read what it is
 * playing with, whether or not anybody touched the switch. Rendered only when
 * the server offers them, so a newer client against an older server shows no
 * switch it cannot actually throw.
 */
const houseRuleName = (rule: string) => T(`avalon.house.${rule}`);

function checked(event: Event) {
  const target = event.target;
  return Boolean(target && 'checked' in target && target.checked);
}

/** The role toggles and house rules the host sets before starting. */
function lobbyOptions() {
  const v = view();
  if (v.phase !== 'lobby') throw new Error('expected lobby view');
  const isHost = v.you?.id === v.hostId;
  const optionRow = (key: string) => h('label', { class: `role-option ${v.options[key] ? 'selected' : ''}` },
    h('input', { type: 'checkbox', checked: v.options[key], disabled: !isHost,
      onchange: (event: Event) => send({ type: 'options', options: { [key]: checked(event) } }) }),
    rolePortrait(key, { small: true }),
    h('span', { class: 'role-option-copy' },
      h('span', { class: 'role-option-name', text: T(`role.${key}`) }),
      h('span', { class: 'role-option-description', text: T(`roleDesc.${key}`) }),
    ),
  );

  const houseToggle = (rule: string) => h('label', { class: `house-rule ${v.houseRules[rule] ? 'selected' : ''}` },
    h('input', {
      type: 'checkbox', checked: v.houseRules[rule], disabled: !isHost,
      onchange: (event: Event) => send({
        type: 'options', options: { houseRules: { [rule]: checked(event) } },
      }),
    }),
    h('span', { class: 'house-rule-copy' },
      h('span', { class: 'house-rule-name', text: houseRuleName(rule) }),
      h('span', { class: 'house-rule-description', text: T(`avalon.houseDesc.${rule}`) }),
    ),
  );

  return h('div', { class: 'card stack' },
    h('h2', { text: T('lobby.roles') }),
    isHost ? null : h('p', { class: 'muted', text: T('lobby.hostOnlyRoles') }),
    h('div', { class: 'role-options' }, v.setup.options.map(optionRow)),
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
      h('div', { class: 'house-rules' }, v.setup.houseRules.map(houseToggle)),
    ] : []),
  );
}

/** Everything above the phase panel, once a game is running. */
function header_() {
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

function panes() {
  const current = view();
  switch (current.phase) {
    case 'lobby': return [lobbyOptions()];
    case 'reveal': return paneReveal();
    case 'team': return paneTeam();
    case 'vote': return paneVote();
    case 'quest': return paneQuest();
    case 'assassin': return paneAssassin();
    case 'over': return paneOver();
    default: return assertNever(current);
  }
}

function roleContent() {
  const v = view();
  if (v.phase === 'lobby') return null;
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
          avatarOf(v.players.find((player) => player.id === k.playerId)),
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
const houseRulesInForce = () => view().setup.houseRules.filter((rule) => view().houseRules?.[rule]);

/** Public role composition and abilities, without revealing who holds what. */
function referenceContent() {
  const current = view();
  if (current.phase === 'lobby') throw new Error('reference panel is not available in the lobby');
  const counts = current.roleCounts;
  const roles = Object.keys(counts);
  const inForce = houseRulesInForce();
  return h('div', { class: 'stack' },
    h('h3', { text: T('avalon.ref.inPlay', { n: current.players.length }) }),
    ...['good', 'evil'].map((side) => h('div', { class: 'stack tight' },
      h('h3', { text: T(`side.${side}`) }),
      ...roles.filter((role) => sideOfRole(role) === side).map((role) => h('div', { class: 'ref-role' },
        rolePortrait(role, { small: true }),
        h('span', {
          class: `tag ${side === 'evil' ? 'evil' : 'good'}`,
          text: (counts[role] ?? 0) > 1 ? `${T(`role.${role}`)} ×${counts[role]}` : T(`role.${role}`),
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
  const v = view();
  if (v.phase === 'lobby') throw new Error('board is not available in the lobby');
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
  const v = view();
  if (v.phase === 'lobby') throw new Error('vote result is not available in the lobby');
  const tally = v.voteTally ?? (v.lastVote ? {
    approved: v.lastVote.approved,
    yes: Object.values(v.lastVote.votes).filter(Boolean).length,
    no: Object.values(v.lastVote.votes).filter((x) => !x).length,
  } : null);
  if (!tally) return null;

  return h('div', { class: 'stack tight vote-result' },
    h('p', { class: 'muted', text: T('vote.result', {
      yes: tally.yes,
      no: tally.no,
      outcome: T(tally.approved ? 'vote.approved' : 'vote.rejected'),
    }) }),
    v.lastVote
      ? h('div', { class: 'players' }, v.players.map((p) => {
          const approved = v.lastVote?.votes[p.id];
          return h('div', { class: 'player' },
            avatarOf(p),
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
  const v = view();
  if (v.phase !== 'reveal') throw new Error('expected reveal view');
  if (!v.you) throw new Error('expected seated viewer');
  const youId = v.you.id;
  const done = v.players.find((p) => p.id === youId)?.ready;
  return [h('div', { class: 'card stack' },
    h('h2', { text: T('phase.reveal') }),
    playerList({ tags: (p) => ('ready' in p && p.ready ? [h('span', { class: 'tag ok status-glyph', title: T('reveal.confirm'), text: '◆' })] : []) }),
    done
      ? h('p', { class: 'muted', text: T('reveal.waiting', { names: waitingNames() }) })
      : h('button', { class: 'btn primary wide', onclick: () => send({ type: 'confirm' }) }, T('reveal.confirm')),
  )];
}

function paneTeam() {
  const v = view();
  if (v.phase !== 'team') throw new Error('expected team view');
  if (!v.you || v.teamSize === undefined) throw new Error('expected seated viewer and team size');
  const teamSize = v.teamSize;
  const leader = v.players.find((p) => p.isLeader);
  const isLeader = leader?.id === v.you.id;
  const full = app.selection.length === teamSize;

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
        else if (app.selection.length < teamSize) app.selection.push(p.id);
        render();
      },
    }),
    isLeader ? h('div', { class: 'row' },
      h('span', { class: 'muted grow', text: T('team.selected', { n: app.selection.length, max: v.teamSize }) }),
      h('button', { class: 'btn primary', disabled: !full, onclick: () => send({ type: 'propose', team: app.selection }) },
        T('team.submit')),
    ) : null,
  )];
}

function paneVote() {
  const v = view();
  if (v.phase !== 'vote') throw new Error('expected vote view');
  if (!v.you) throw new Error('expected seated viewer');
  const youId = v.you.id;
  const voted = v.players.find((p) => p.id === youId)?.hasVoted;
  return [h('div', { class: 'card stack' },
    h('h2', { text: T('phase.vote') }),
    h('p', { text: T('vote.team', { names: namesOf(v.team) }) }),
    // The proposed team already wears the sword the list draws for it. During
    // voting, reveal only that a choice is locked in — the tick or cross
    // appears for everyone once the vote resolves.
    playerList({ tags: (p) => ('hasVoted' in p && p.hasVoted
      ? [h('span', { class: 'tag ok status-glyph', title: T('vote.voted'), text: '◆' })]
      : []) }),
    voted
      ? h('p', { class: 'muted', text: T('vote.cast', { names: waitingNames() }) })
      : h('div', { class: 'stack' },
          h('p', { text: T('vote.prompt') }),
          h('div', { class: 'row' },
            h('button', { class: 'btn primary grow', onclick: () => send({ type: 'vote', approve: true }) }, T('vote.approve')),
            h('button', { class: 'btn danger grow', onclick: () => send({ type: 'vote', approve: false }) }, T('vote.reject')),
          ),
        ),
  )];
}

function paneQuest() {
  const v = view();
  if (v.phase !== 'quest') throw new Error('expected quest view');
  if (!v.you) throw new Error('expected seated viewer');
  const youId = v.you.id;
  const me = v.players.find((p) => p.id === youId);
  const onTeam = me?.onTeam;
  const played = me?.hasPlayed;

  return [h('div', { class: 'card stack' },
    h('h2', { text: T('phase.quest') }),
    h('p', { text: T('quest.watching', { round: v.round + 1, names: namesOf(v.team) }) }),
    v.failsRequired === 2 ? h('p', { class: 'muted', text: T('quest.needsTwo') }) : null,
    playerList({ only: v.team, tags: (p) => ('hasPlayed' in p && p.hasPlayed ? [h('span', { class: 'tag ok status-glyph', title: T('quest.played'), text: '◆' })] : []) }),
    onTeam && !played ? h('div', { class: 'stack' },
      h('p', { text: T('quest.prompt') }),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary grow', onclick: () => send({ type: 'card', success: true }) }, T('quest.success')),
        v.you.side === 'evil'
          ? h('button', { class: 'btn danger grow', onclick: () => send({ type: 'card', success: false }) }, T('quest.fail'))
          : h('span', { class: 'muted grow', text: T('quest.goodCannotFail') }),
      ),
    ) : h('p', { class: 'muted', text: T(onTeam ? 'quest.played' : 'reveal.waiting', { names: waitingNames() }) }),
  )];
}

function paneAssassin() {
  const v = view();
  if (v.phase !== 'assassin') throw new Error('expected assassin view');
  if (!v.you) throw new Error('expected seated viewer');
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
      onclick: () => send({ type: 'assassinate', target: selectedPlayer() }),
    }, T('assassin.kill', { name: app.selection.length ? nameOf(selectedPlayer()) : '…' })) : null,
  )];
}

function paneOver() {
  const v = view();
  if (v.phase !== 'over') throw new Error('expected over view');
  const good = v.winner === 'good';
  return [h('div', { class: 'card stack' },
    h('div', { class: `banner ${good ? 'good' : 'evil'}`, text: T(good ? 'over.goodWins' : 'over.evilWins') }),
    h('p', { text: T(v.winReason ?? 'over.evilWins') }),
    v.assassinTarget ? h('p', { class: 'muted', text: T('over.assassinPicked', { name: nameOf(v.assassinTarget) }) }) : null,
    h('h3', { text: T('over.roles') }),
    h('div', { class: 'players' }, v.players.map((p) => {
      const isYou = p.id === v.you?.id;
      const role = p.role;
      return h('div', {
        class: `player ${isYou ? 'is-you' : ''}`, 'aria-current': isYou ? 'true' : null,
      },
        avatarOf(p),
        role ? rolePortrait(role, { small: true }) : null,
        h('span', { class: 'name', text: p.name }),
        role ? h('span', { class: `tag ${sideOfRole(role)}`, text: T(`role.${role}`) }) : null,
        role ? h('span', {
          class: `faction-sigil mini ${sideOfRole(role)}`,
          title: T(`side.${sideOfRole(role)}`),
          'aria-label': T(`side.${sideOfRole(role)}`),
          text: sideOfRole(role) === 'evil' ? '☾' : '☀',
        }) : null,
      );
    })),
    v.you?.id === v.hostId
      ? h('button', { class: 'btn primary wide', onclick: () => send({ type: 'again' }) }, T('over.again'))
      : h('p', { class: 'muted', text: T('lobby.waitingHost') }),
  )];
}

const EVIL_ROLES = new Set(['assassin', 'morgana', 'mordred', 'oberon', 'minion']);
const sideOfRole = (role: string) => (EVIL_ROLES.has(role) ? 'evil' : 'good');

function selectedPlayer() {
  const selected = app.selection[0];
  if (!selected) throw new Error('expected a selected player');
  return selected;
}

return { id, rulesKey, taglineKey, paneKey, lobbyOptions, header_, panes };
}
