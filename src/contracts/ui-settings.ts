export const THEMES = {
  classic: { label: 'Classic', description: 'Clean dark panels, rounded controls, and blue accents.', color: '#12141c' },
  crystal: { label: 'Crystal', description: 'JRPG-inspired frames, gold accents, and illustrated cards.', color: '#080d1c' },
} as const;

export type ThemeId = keyof typeof THEMES;
export type UiSettingsValue = { theme: ThemeId };
export const DEFAULT_THEME: ThemeId = 'crystal';

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && Object.hasOwn(THEMES, value);
}

export function parseUiSettings(value: unknown): UiSettingsValue | null {
  return value !== null && typeof value === 'object' && 'theme' in value && isThemeId(value.theme)
    ? { theme: value.theme }
    : null;
}
