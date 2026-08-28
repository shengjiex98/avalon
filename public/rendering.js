// Shared room rendering and scroll ownership. Game renderers receive only the
// player-list function; journal formatting remains private to this owner.

import { h, playerAvatar } from './ui.js';

export function createSharedRendering({ app, T, currentGame, joinNames }) {
  let scrollTops = new Map();
  let scrollPanes = [];

  function begin() {
    scrollPanes = [];
  }

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
    scrollTops = kept;
    scrollPanes = [];
  }

  function playerList({ selectable = false, selected = [], onpick, tags, only, exclude = [] } = {}) {
    const view = app.view;
    const rows = view.players
      .filter((player) => !only || only.includes(player.id))
      .map((player) => {
        const picked = selected.includes(player.id);
        const blocked = exclude.includes(player.id);
        const isYou = player.id === view.you?.id;
        const inner = [
          playerAvatar(player, app.server),
          h('span', { class: 'name', text: player.name }),
          isYou ? h('span', { class: 'visually-hidden', text: T('lobby.you') }) : null,
          player.isLeader ? h('span', { class: 'tag leader', text: '👑' }) : null,
          player.onTeam && view.phase !== 'quest' ? h('span', { class: 'tag team', text: '⚔' }) : null,
          ...(tags ? tags(player) : []),
        ];
        if (!selectable) return h('div', {
          class: `player ${isYou ? 'is-you' : ''}`, 'aria-current': isYou ? 'true' : null,
        }, inner);
        return h('button', {
          class: `player ${isYou ? 'is-you' : ''} ${picked ? 'selected' : ''}`, type: 'button',
          'aria-current': isYou ? 'true' : null,
          disabled: blocked, onclick: () => onpick(player),
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
      scrollPane('log', { class: 'log' }, entries.map((entry) => h('div', {
        text: T(entry.key, formatParams(entry.params, entry.key)),
      }))),
    );
  }

  function formatParams(params, entryKey) {
    const out = { ...params };
    for (const [key, value] of Object.entries(out)) if (Array.isArray(value)) out[key] = joinNames(value);
    if (out.game) out.game = T(`game.${out.game}`);
    const game = currentGame();
    if (game.formatParams) return game.formatParams(out, entryKey);
    if (out.winner) out.winner = T(`side.${out.winner}`);
    return out;
  }

  return { begin, scrollPane, restoreScroll, playerList, paneLog };
}
