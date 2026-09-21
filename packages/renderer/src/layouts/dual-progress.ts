import type { DualProgressFrameLayout, ProgressGauge, SemanticColor } from '@gca/module-sdk';
import { BAND, footer } from '../chrome.js';
import { arcPath, CANVAS, CONTENT_WIDTH, SAFE, circle, path, text, round } from '../svg.js';
import { fitFontSize } from '../fonts.js';
import { color, type Theme } from '../theme.js';

const RING_RADIUS = 27;
const RING_STROKE = 7;

/**
 * Hero percentage plus one ring per window. The rings carry the label ("5H", "7D")
 * inside them, so the two windows stay distinguishable without relying on colour.
 */
export function renderDualProgress(
  layout: DualProgressFrameLayout,
  theme: Theme,
  accent: SemanticColor,
): string {
  const parts: string[] = [];
  const heroTone = color(theme, layout.hero.tone ?? accent);

  const heroSize = fitFontSize(layout.hero.value, {
    family: 'display',
    weight: 800,
    fontSize: 62,
    minFontSize: 36,
    maxWidth: CONTENT_WIDTH,
  });

  parts.push(
    text({
      x: SAFE.left,
      y: BAND.contentTop + heroSize * 0.8,
      text: layout.hero.value,
      size: heroSize,
      weight: 800,
      fill: heroTone,
      maxWidth: CONTENT_WIDTH,
    }),
  );

  if (layout.hero.caption) {
    parts.push(
      text({
        x: SAFE.left,
        y: BAND.contentTop + heroSize * 0.8 + 19,
        text: layout.hero.caption,
        size: 13,
        weight: 600,
        fill: theme.textSecondary,
        maxWidth: CONTENT_WIDTH,
      }),
    );
  }

  const gauges = layout.gauges.slice(0, 2);
  const ringsY = 172;
  const spacing = CONTENT_WIDTH / Math.max(1, gauges.length);
  gauges.forEach((gauge, index) => {
    const cx = SAFE.left + spacing * index + spacing / 2;
    parts.push(renderRing(gauge, theme, cx, ringsY));
  });

  parts.push(footer(theme, layout.footer));
  return parts.join('');
}

function renderRing(gauge: ProgressGauge, theme: Theme, cx: number, cy: number): string {
  const toneHex = color(theme, gauge.tone);
  const parts: string[] = [
    circle({ cx, cy, r: RING_RADIUS, stroke: theme.surfaceAlt, strokeWidth: RING_STROKE }),
  ];

  if (gauge.percent !== null && Number.isFinite(gauge.percent)) {
    // Values above 100 (spend limits) still draw a full ring rather than wrapping.
    const sweep = Math.min(100, Math.max(0, gauge.percent)) * 3.6;
    if (sweep > 0.5) {
      parts.push(
        path(arcPath(cx, cy, RING_RADIUS, 0, sweep), {
          stroke: toneHex,
          strokeWidth: RING_STROKE,
          linecap: 'round',
        }),
      );
    }
  } else {
    // Unknown is drawn as a dashed hint, never as an empty ring that reads like zero.
    parts.push(
      `<circle cx="${round(cx)}" cy="${round(cy)}" r="${RING_RADIUS}" fill="none" stroke="${theme.textMuted}" stroke-width="2" stroke-dasharray="3 5" opacity="0.7" />`,
    );
  }

  parts.push(
    text({
      x: cx,
      y: cy + 2,
      text: gauge.valueText,
      size: gauge.valueText.length > 4 ? 16 : 19,
      weight: 700,
      fill: gauge.percent === null ? theme.textMuted : theme.textPrimary,
      anchor: 'middle',
      maxWidth: RING_RADIUS * 1.8,
    }),
    text({
      x: cx,
      y: cy + 16,
      text: gauge.label.toUpperCase(),
      size: 10,
      weight: 700,
      fill: theme.textMuted,
      anchor: 'middle',
      letterSpacing: 0.8,
    }),
  );

  if (gauge.caption) {
    parts.push(
      text({
        x: cx,
        y: cy + RING_RADIUS + 16,
        text: gauge.caption,
        size: 11,
        weight: 600,
        fill: theme.textSecondary,
        anchor: 'middle',
        maxWidth: CANVAS / 2 - 10,
      }),
    );
  }

  return parts.join('');
}
