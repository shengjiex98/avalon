// Shared room rendering and scroll ownership. Game renderers receive only the
// player-list function; journal formatting remains private to this owner.

import { h, playerAvatar } from './ui.ts';
import type { LogEntry } from '../contracts/persistence.ts';
import type {
  PlayerListOptions, SharedRenderingContext,
} from './renderer-types.ts';

type ResultPlayer = { name: string; side: string };

export function createSharedRendering({ app, T, currentGame, joinNames }: SharedRenderingContext) {
  let scrollTops = new Map<string, number>();
  let scrollPanes: Array<[string, HTMLElement]> = [];

  function view() {
    if (!app.view) throw new Error('shared renderer requires a room view');
    return app.view;
  }

  function begin() {
    scrollPanes = [];
  }

  function scrollPane(key: string, props: Record<string, unknown>, ...children: unknown[]): HTMLElement {
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

  function playerList({
    selectable = false, selected = [], onpick, tags, only, exclude = [],
  }: PlayerListOptions = {}) {
    const current = view();
    const rows = current.players
      .filter((player) => !only || only.includes(player.id))
      .map((player) => {
        const picked = selected.includes(player.id);
        const blocked = exclude.includes(player.id);
        const isYou = player.id === current.you?.id;
        const inner = [
          playerAvatar(player, app.server ?? undefined),
          h('span', { class: 'name', text: player.name }),
          isYou ? h('span', { class: 'visually-hidden', text: T('lobby.you') }) : null,
          'isLeader' in player && player.isLeader ? h('span', { class: 'tag leader', text: '👑' }) : null,
          'onTeam' in player && player.onTeam && current.phase !== 'quest' ? h('span', { class: 'tag team', text: '⚔' }) : null,
          ...(tags ? tags(player) : []),
        ];
        if (!selectable) return h('div', {
          class: `player ${isYou ? 'is-you' : ''}`, 'aria-current': isYou ? 'true' : null,
        }, inner);
        return h('button', {
          class: `player ${isYou ? 'is-you' : ''} ${picked ? 'selected' : ''}`, type: 'button',
          'aria-current': isYou ? 'true' : null,
          disabled: blocked, onclick: () => onpick?.(player),
        }, inner);
      });
    return h('div', { class: 'players' }, rows);
  }

  function paneLog() {
    const entries = view().log.slice().reverse();
    return h('details', {
      class: 'card journal', open: app.logOpen,
      ontoggle: (event: Event) => {
        app.logOpen = Boolean(event.target && 'open' in event.target && event.target.open);
      },
    },
      h('summary', {},
        h('span', { 'aria-hidden': 'true', text: '▤' }),
        h('span', { text: T('log.title') }),
        h('span', { class: 'journal-count', text: entries.length }),
      ),
      scrollPane('log', { class: 'log' }, entries.map(renderLogEntry)),
    );
  }

  function renderLogEntry(entry: LogEntry) {
    if (entry.key !== 'log.gameResult') return h('div', {
      text: T(entry.key, formatParams(entry.params, entry.key)),
    });
    return h('div', { class: 'game-result' },
      resultRow('report.winners', entry.params.winners),
      resultRow('report.losers', entry.params.losers),
    );
  }

  function resultRow(label: string, value: unknown) {
    const players = Array.isArray(value) ? value.filter(resultPlayer) : [];
    const names = players.length
      ? players.flatMap((player, index) => [
          index ? T('report.separator') : null,
          h('span', {
            class: `report-player ${resultSideClass(player.side)}`,
            text: player.name,
            title: resultSideLabel(player.side),
            'aria-label': `${player.name}, ${resultSideLabel(player.side)}`,
          }),
        ])
      : [h('span', { class: 'muted', text: T('report.none') })];
    return h('div', { class: 'result-row' }, h('span', { text: T(label) }), names);
  }

  function resultPlayer(value: unknown): value is ResultPlayer {
    return Boolean(value && typeof value === 'object'
      && 'name' in value && typeof value.name === 'string'
      && 'side' in value && typeof value.side === 'string');
  }

  function resultSideClass(side: string) {
    if (side === 'good' || side === 'village') return 'good';
    if (side === 'evil' || side === 'werewolf') return 'evil';
    return 'tanner';
  }

  function resultSideLabel(side: string) {
    return T(side === 'good' || side === 'evil' ? `side.${side}` : `onuw.team.${side}`);
  }

  function formatParams(params: Record<string, unknown>, entryKey: string) {
    const out = { ...params };
    for (const [key, value] of Object.entries(out)) if (Array.isArray(value)) out[key] = joinNames(value);
    if (out.game) out.game = T(`game.${String(out.game)}`);
    const game = currentGame();
    if (game.formatParams) return game.formatParams(out, entryKey);
    if (out.winner) out.winner = T(`side.${String(out.winner)}`);
    return out;
  }

  return { begin, scrollPane, restoreScroll, playerList, paneLog };
}
