import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { DEFAULT_THEME, isThemeId, parseUiSettings } from '../contracts/ui-settings.ts';
import type { ThemeId, UiSettingsValue } from '../contracts/ui-settings.ts';
import { errorKind, operationalLogger } from './logging.ts';
import type { OperationalLogger } from './logging.ts';

/** Site appearance survives application releases independently of room snapshots. */
export class UiSettings {
  private value: UiSettingsValue = { theme: DEFAULT_THEME };
  private readonly file: string | undefined;
  private readonly logger: OperationalLogger;
  private pending: Promise<void> = Promise.resolve();

  constructor({ file, logger = operationalLogger }: { file?: string; logger?: OperationalLogger } = {}) {
    this.file = file;
    this.logger = logger;
    if (!file) return;
    try {
      const settings = parseUiSettings(JSON.parse(readFileSync(file, 'utf8')));
      if (!settings) throw new TypeError('Invalid UI settings');
      this.value = settings;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
      logger('error', 'ui.settings.load', { outcome: 'defaulted', error: errorKind(error) });
    }
  }

  current(): UiSettingsValue {
    return { ...this.value };
  }

  setTheme(theme: ThemeId): Promise<void> {
    if (!isThemeId(theme)) throw new TypeError('Unknown theme');
    const update = this.pending.then(() => this.persist(theme));
    // Serialize competing admin submissions without blocking the game event loop.
    this.pending = update.catch(() => {});
    return update;
  }

  private async persist(theme: ThemeId): Promise<void> {
    if (theme === this.value.theme) return;
    if (!this.file) throw new Error('UI settings storage is not configured');

    const value = { theme };
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600, flush: true });
      await rename(temporary, this.file);
    } finally {
      try { await unlink(temporary); } catch { /* rename already consumed the temporary file */ }
    }
    // Publish only after storage succeeds, so the admin never confirms a lost change.
    this.value = value;
    this.logger('info', 'ui.theme.changed', { theme });
  }
}
