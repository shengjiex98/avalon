// DOM primitives shared by the shell and by every game's panels.

type AvatarPlayer = { name: string; avatar?: string | null; seat?: number };
type ElementProps = Record<string, unknown>;

export const el = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

/** Portraits share one generated atlas so the game pays a single image load. */
export function rolePortrait(role: unknown, { small = false }: { small?: boolean } = {}): HTMLElement {
  return h('span', {
    class: `role-portrait portrait-${role} ${small ? 'portrait-small' : ''}`,
    'aria-hidden': 'true',
  });
}

/** A player's chamfered badge; deliberately unlike the round role medallions. */
export function playerAvatar(player: AvatarPlayer | null | undefined, server = ''): HTMLElement {
  const initial = [...String(player?.name ?? '?').trim()][0]?.toLocaleUpperCase() ?? '?';
  const seat = typeof player?.seat === 'number' && Number.isInteger(player.seat)
    ? player.seat + 1
    : null;
  const src = typeof player?.avatar === 'string' && player.avatar.startsWith('/api/avatars/')
    ? `${server}${player.avatar}`
    : null;
  return h('span', { class: 'player-avatar', 'aria-hidden': 'true' },
    h('span', { class: 'player-avatar-initial', text: initial }),
    src ? h('img', {
      src, alt: '', loading: 'lazy', decoding: 'async',
      onerror: (event: Event) => {
        if (event.target instanceof HTMLElement) event.target.hidden = true;
      },
    }) : null,
    seat === null ? null : h('span', { class: 'player-number', text: seat }),
  );
}

export function h(tag: string, props: ElementProps = {}, ...children: unknown[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'disabled' || key === 'checked' || key === 'hidden' || key === 'open') {
      Object.assign(node, { [key]: Boolean(value) });
    } else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child && typeof child === 'object' && 'nodeType' in child
      ? child as Node
      : document.createTextNode(String(child)));
  }
  return node;
}

/** A shared, dismissible information overlay used by both games. */
export function infoPopup(
  { title, closeLabel, onClose }: { title: string; closeLabel: string; onClose: () => void },
  ...children: unknown[]
): HTMLElement {
  return h('div', {
    class: 'info-popup-backdrop', id: 'infoPopupBackdrop',
    onclick: onClose,
    onkeydown: (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); },
  },
    h('section', {
      class: 'card stack info-popup', role: 'dialog', 'aria-modal': 'true',
      'aria-labelledby': 'infoPopupTitle',
      onclick: (event: Event) => event.stopPropagation(),
    },
      h('div', { class: 'row' },
        h('h2', { class: 'grow', id: 'infoPopupTitle', text: title }),
        h('button', {
          class: 'btn ghost popup-close', type: 'button',
          'aria-label': closeLabel, onclick: onClose,
        }, '×'),
      ),
      ...children,
    ),
  );
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(message: string, kind = 'error'): void {
  const box = el('toast');
  box.textContent = message;
  box.className = `toast ${kind === 'info' ? 'info' : ''}`;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 4000);
}
