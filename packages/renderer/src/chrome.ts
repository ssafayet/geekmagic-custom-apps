import type { FrameBadge, SemanticColor } from '@gca/module-sdk';
import { icon as renderIcon, hasIcon } from './icons.js';
import { CANVAS, CONTENT_WIDTH, SAFE, rect, round, text, textWidth } from './svg.js';
import { color, type Theme } from './theme.js';

/** Vertical bands every layout shares, so modules line up with each other on rotation. */
export const BAND = {
  headerBaseline: 25,
  contentTop: 38,
  contentBottom: 208,
  footerBaseline: 231,
} as const;

export const HEADER_SIZE = 12;
export const FOOTER_SIZE = 11;

export function header(options: {
  theme: Theme;
  title: string;
  icon?: string | undefined;
  accent: SemanticColor;
  badge?: FrameBadge | undefined;
}): string {
  const { theme, title, accent, badge } = options;
  const accentHex = color(theme, accent);
  const parts: string[] = [];

  let cursorX = SAFE.left;
  if (options.icon && hasIcon(options.icon)) {
    parts.push(
      renderIcon({
        id: options.icon,
        x: cursorX,
        y: BAND.headerBaseline - 14,
        size: 16,
        color: accentHex,
        strokeWidth: 2,
      }),
    );
    cursorX += 21;
  }

  const badgeMarkup = badge ? renderBadge(theme, badge) : { markup: '', width: 0 };
  const titleMaxWidth =
    CANVAS - SAFE.right - cursorX - (badgeMarkup.width > 0 ? badgeMarkup.width + 8 : 0);

  parts.push(
    text({
      x: cursorX,
      y: BAND.headerBaseline,
      text: title.toUpperCase(),
      size: HEADER_SIZE,
      weight: 700,
      fill: accentHex,
      letterSpacing: 1.1,
      maxWidth: Math.max(20, titleMaxWidth),
    }),
  );

  if (badgeMarkup.markup) parts.push(badgeMarkup.markup);
  return parts.join('');
}

function renderBadge(theme: Theme, badge: FrameBadge): { markup: string; width: number } {
  const label = badge.text.toUpperCase();
  const size = 9.5;
  const padding = 5;
  const width = round(textWidth(label, size, 'display', 700, 0.8) + padding * 2);
  const height = 15;
  const x = CANVAS - SAFE.right - width;
  const y = BAND.headerBaseline - 11.5;
  const tone = color(theme, badge.tone);
  return {
    width,
    markup: [
      rect({ x, y, width, height, fill: tone, radius: 4, opacity: 0.18 }),
      text({
        x: x + width / 2,
        y: y + height - 4.5,
        text: label,
        size,
        weight: 700,
        fill: tone,
        anchor: 'middle',
        letterSpacing: 0.8,
      }),
    ].join(''),
  };
}

export function footer(
  theme: Theme,
  value: string | undefined,
  options: { tone?: string } = {},
): string {
  if (!value) return '';
  return text({
    x: SAFE.left,
    y: BAND.footerBaseline,
    text: value,
    size: FOOTER_SIZE,
    fill: options.tone ?? theme.textMuted,
    maxWidth: CONTENT_WIDTH,
  });
}

/** Right-aligned second half of the footer, used for attribution and age. */
export function footerRight(theme: Theme, value: string | undefined): string {
  if (!value) return '';
  return text({
    x: CANVAS - SAFE.right,
    y: BAND.footerBaseline,
    text: value,
    size: FOOTER_SIZE,
    fill: theme.textMuted,
    anchor: 'end',
    maxWidth: CONTENT_WIDTH * 0.55,
  });
}

export function divider(theme: Theme, y: number): string {
  return rect({
    x: SAFE.left,
    y,
    width: CONTENT_WIDTH,
    height: 1,
    fill: theme.divider,
  });
}
