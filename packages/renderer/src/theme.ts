import type { SemanticColor } from '@gca/module-sdk';

export interface Theme {
  id: string;
  displayName: string;
  background: string;
  surface: string;
  surfaceAlt: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  divider: string;
  /** Resolved semantic colours. Every module accent maps through this table. */
  colors: Record<SemanticColor, string>;
  /** Thresholds share a ramp so "getting full" reads the same across modules. */
  ramp: {
    normal: SemanticColor;
    warning: SemanticColor;
    high: SemanticColor;
    critical: SemanticColor;
  };
}

/**
 * Default dark theme. The panels are small, viewed from a distance and often in a dim
 * room, so the palette is high-contrast on near-black with saturated accents.
 */
export const MIDNIGHT_THEME: Theme = {
  id: 'midnight',
  displayName: 'Midnight',
  background: '#05070b',
  surface: '#101722',
  surfaceAlt: '#182130',
  textPrimary: '#f2f6fb',
  textSecondary: '#aebacb',
  textMuted: '#6c7a8d',
  divider: '#1e2938',
  colors: {
    purple: '#b183ff',
    blue: '#5aa2ff',
    cyan: '#3fd0d8',
    green: '#4ddb90',
    amber: '#ffc857',
    orange: '#ff9d4d',
    red: '#ff6b6b',
    magenta: '#ff7ac6',
    slate: '#8fa0b6',
  },
  ramp: { normal: 'green', warning: 'amber', high: 'orange', critical: 'red' },
};

export const CONTRAST_THEME: Theme = {
  ...MIDNIGHT_THEME,
  id: 'contrast',
  displayName: 'High contrast',
  background: '#000000',
  surface: '#0d0d0d',
  surfaceAlt: '#171717',
  textPrimary: '#ffffff',
  textSecondary: '#d4d4d4',
  textMuted: '#9a9a9a',
  divider: '#2a2a2a',
  colors: {
    ...MIDNIGHT_THEME.colors,
    amber: '#ffd633',
    green: '#4ef08f',
    red: '#ff5252',
  },
};

export const THEMES: Record<string, Theme> = {
  [MIDNIGHT_THEME.id]: MIDNIGHT_THEME,
  [CONTRAST_THEME.id]: CONTRAST_THEME,
};

export function resolveTheme(id: string | undefined): Theme {
  return (id && THEMES[id]) || MIDNIGHT_THEME;
}

export function color(theme: Theme, semantic: SemanticColor): string {
  return theme.colors[semantic] ?? theme.colors.slate;
}

/**
 * Usage thresholds from the Claude module spec, shared so any future quota module
 * reads identically: <60 normal, 60-84 warning, 85-99 high, >=100 error.
 */
export function usageTone(
  percent: number | null,
  theme: Theme,
  accent: SemanticColor,
): SemanticColor {
  if (percent === null || !Number.isFinite(percent)) return 'slate';
  if (percent >= 100) return theme.ramp.critical;
  if (percent >= 85) return theme.ramp.high;
  if (percent >= 60) return theme.ramp.warning;
  return accent;
}
