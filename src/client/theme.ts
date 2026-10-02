import { DEFAULT_THEME, isThemeId, THEMES } from '../contracts/ui-settings.ts';
import type { ThemeId, UiSettingsValue } from '../contracts/ui-settings.ts';
import type { createStore } from './storage.ts';

const REFRESH_MS = 30_000;

export function createThemeController({ app, store, load }: {
  app: { server: string | null };
  store: ReturnType<typeof createStore>;
  load: () => Promise<UiSettingsValue>;
}) {
  let server: string | null = null;
  let generation = 0;
  let pending: Promise<void> | null = null;
  let started = false;

  function apply(theme: ThemeId): void {
    document.documentElement.setAttribute('data-theme', theme);
    document.getElementById('themeColor')?.setAttribute('content', THEMES[theme].color);
  }

  function prepare(): void {
    const selected = app.server || location.origin;
    if (server === selected) return;
    server = selected;
    generation += 1;
    pending = null;
    const cached = store.themeFor(selected);
    apply(isThemeId(cached) ? cached : DEFAULT_THEME);
  }

  function refresh(): Promise<void> {
    prepare();
    if (pending) return pending;
    const selected = server!;
    const requestGeneration = generation;
    const request = (async () => {
      try {
        const settings = await load();
        // A response from the previous backend must never recolor the new one.
        if (generation !== requestGeneration || selected !== (app.server || location.origin)) return;
        if (!isThemeId(settings.theme)) return;
        apply(settings.theme);
        try { store.setTheme(selected, settings.theme); } catch { /* Appearance works without durable storage. */ }
      } catch { /* Older or unavailable servers leave the last usable theme intact. */ }
    })();
    pending = request;
    void request.finally(() => { if (pending === request) pending = null; });
    return request;
  }

  function start(): void {
    prepare();
    if (started) return;
    started = true;
    const update = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    const timer = setInterval(update, REFRESH_MS);
    timer.unref?.();
    window.addEventListener('focus', update);
    window.addEventListener('online', update);
    document.addEventListener('visibilitychange', update);
    update();
  }

  return { start, prepare, refresh };
}
