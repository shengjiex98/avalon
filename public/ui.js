// DOM primitives shared by the shell and by every game's panels.

export const el = (id) => document.getElementById(id);

/** Portraits share one generated atlas so the game pays a single image load. */
export function rolePortrait(role, { small = false } = {}) {
  return h('span', {
    class: `role-portrait portrait-${role} ${small ? 'portrait-small' : ''}`,
    'aria-hidden': 'true',
  });
}

export function h(tag, props = {}, ...children) {
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

/** A shared, dismissible information overlay used by both games. */
export function infoPopup({ title, closeLabel, onClose }, ...children) {
  return h('div', {
    class: 'info-popup-backdrop', id: 'infoPopupBackdrop',
    onclick: onClose,
    onkeydown: (event) => { if (event.key === 'Escape') onClose(); },
  },
    h('section', {
      class: 'card stack info-popup', role: 'dialog', 'aria-modal': 'true',
      'aria-labelledby': 'infoPopupTitle',
      onclick: (event) => event.stopPropagation(),
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

let toastTimer;
export function toast(message, kind = 'error') {
  const box = el('toast');
  box.textContent = message;
  box.className = `toast ${kind === 'info' ? 'info' : ''}`;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 4000);
}
