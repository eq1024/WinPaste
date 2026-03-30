import type { Locale } from "../types";

export interface ThemeDefinition {
  id: string;
  labels: Record<Locale, string>;
  supportsCustomBackground?: boolean;
  supportsSurfaceOpacity?: boolean;
}

export const THEMES: ThemeDefinition[] = [
  {
    id: "fluent",
    labels: {
      zh: "Fluent Design",
      en: "Fluent Design",
      tw: "Fluent Design"
    },
    supportsCustomBackground: true,
    supportsSurfaceOpacity: true
  }
];

export const DEFAULT_THEME = "fluent";

const THEME_BY_ID = new Map(THEMES.map((theme) => [theme.id, theme]));

export const THEME_CLASS_NAMES = THEMES.map((theme) => `theme-${theme.id}`);

export const getThemeDefinition = (_themeId: string): ThemeDefinition =>
  THEME_BY_ID.get(DEFAULT_THEME)!;

export const normalizeThemeId = (_themeId: string): string => DEFAULT_THEME;

export const getThemeLabel = (themeId: string, locale: Locale): string =>
  getThemeDefinition(themeId).labels[locale];

export const supportsCustomBackground = (_themeId: string): boolean => true;

export const supportsSurfaceOpacity = (_themeId: string): boolean => true;

export const clearThemeClasses = (...targets: Array<Element | null | undefined>) => {
  for (const target of targets) {
    if (!target) continue;
    target.classList.remove(...THEME_CLASS_NAMES);
  }
};

export const applyThemeClasses = (
  _themeId: string,
  ...targets: Array<Element | null | undefined>
) => {
  clearThemeClasses(...targets);
  for (const target of targets) {
    if (!target) continue;
    target.classList.add(`theme-${DEFAULT_THEME}`);
  }
};
