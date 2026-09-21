import type { EmptyFrameLayout, ErrorFrameLayout, SemanticColor } from '@gca/module-sdk';
import { footer } from '../chrome.js';
import { icon } from '../icons.js';
import { CANVAS, CONTENT_WIDTH, SAFE, text } from '../svg.js';
import { ellipsize, fitFontSize } from '../fonts.js';
import { color, type Theme } from '../theme.js';

/** Centred icon + headline. Used for "no traffic", "waiting" and setup states. */
export function renderEmpty(layout: EmptyFrameLayout, theme: Theme, accent: SemanticColor): string {
  const accentHex = color(theme, accent);
  const parts = [
    icon({
      id: layout.icon,
      x: CANVAS / 2 - 19,
      y: 62,
      size: 38,
      color: accentHex,
      strokeWidth: 1.6,
      opacity: 0.9,
    }),
    headline(layout.headline, theme.textPrimary, 22, 140),
  ];

  if (layout.detail) {
    parts.push(...wrapCentered(layout.detail, theme.textSecondary, 13, 162, 2));
  }

  parts.push(footer(theme, layout.footer));
  return parts.join('');
}

export function renderError(layout: ErrorFrameLayout, theme: Theme): string {
  const tone =
    layout.severity === 'error'
      ? theme.colors.red
      : layout.severity === 'warn'
        ? theme.colors.amber
        : theme.colors.blue;
  const iconId =
    layout.severity === 'info' ? 'clock' : layout.severity === 'warn' ? 'warning' : 'offline';

  const parts = [
    icon({ id: iconId, x: CANVAS / 2 - 18, y: 58, size: 36, color: tone, strokeWidth: 1.8 }),
    headline(layout.headline, theme.textPrimary, 20, 134),
  ];

  if (layout.detail) {
    parts.push(...wrapCentered(layout.detail, theme.textSecondary, 12.5, 156, 3));
  }

  if (layout.code) {
    parts.push(
      text({
        x: CANVAS / 2,
        y: 210,
        text: layout.code,
        size: 10,
        weight: 700,
        family: 'mono',
        fill: theme.textMuted,
        anchor: 'middle',
        maxWidth: CONTENT_WIDTH,
      }),
    );
  }

  parts.push(footer(theme, layout.footer));
  return parts.join('');
}

/**
 * Centred headline that shrinks to fit rather than truncating.
 *
 * These strings are short state labels ("Bridge not installed", "No traffic") where
 * a clipped word costs more comprehension than a couple of points of type size.
 */
function headline(value: string, fill: string, maxSize: number, y: number): string {
  const upper = value.toUpperCase();
  const letterSpacing = 0.5;
  const size = fitFontSize(upper, {
    family: 'display',
    weight: 800,
    fontSize: maxSize,
    minFontSize: 13,
    maxWidth: CONTENT_WIDTH,
    letterSpacing,
  });
  return text({
    x: CANVAS / 2,
    y,
    text: upper,
    size,
    weight: 800,
    fill,
    anchor: 'middle',
    letterSpacing,
    maxWidth: CONTENT_WIDTH,
  });
}

/**
 * Greedy word wrap into at most `maxLines` centred lines. Width is measured with the
 * real font, so the last line ellipsizes only when it genuinely overflows.
 */
function wrapCentered(
  value: string,
  fill: string,
  size: number,
  startY: number,
  maxLines: number,
): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ellipsize(candidate, { fontSize: size, maxWidth: CONTENT_WIDTH }) === candidate) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);

  return lines.slice(0, maxLines).map((lineText, index) =>
    text({
      x: CANVAS / 2,
      y: startY + index * (size + 4),
      text: lineText,
      size,
      weight: 400,
      fill,
      anchor: 'middle',
      maxWidth: CONTENT_WIDTH,
    }),
  );
}

export const CONTENT_LEFT = SAFE.left;
