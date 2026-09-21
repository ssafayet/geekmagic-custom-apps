import type { AircraftFrameLayout, SemanticColor } from '@gca/module-sdk';
import { divider, footer, footerRight } from '../chrome.js';
import { bearingArrow, icon } from '../icons.js';
import { CANVAS, CONTENT_WIDTH, SAFE, circle, text, textWidth } from '../svg.js';
import { fitFontSize } from '../fonts.js';
import { color, type Theme } from '../theme.js';

const COMPASS_CX = 200;
const COMPASS_CY = 72;
const COMPASS_R = 24;

/** Fixed vertical rhythm: every band is measured from the top so nothing can collide. */
const ROW = {
  identifierBaseline: 68,
  identifierHint: 82,
  statLabel: 118,
  statValueBaseline: 142,
  divider: 156,
  supportingFirst: 174,
  supportingStep: 19,
} as const;

const STAT_COLUMN_WIDTH = CONTENT_WIDTH / 2;
/** Leaves room for the vertical-trend glyph without letting the value run into it. */
const STAT_VALUE_WIDTH = STAT_COLUMN_WIDTH - 14;

/**
 * Identifier hero with a bearing compass on the right.
 *
 * The callsign gets the most space of anything on the panel because it is the one value
 * a viewer glances up to read. Long identifiers and long altitudes shrink to fit rather
 * than truncating, since a clipped callsign is worse than a slightly smaller one.
 */
export function renderAircraft(
  layout: AircraftFrameLayout,
  theme: Theme,
  accent: SemanticColor,
): string {
  const parts: string[] = [];
  const accentHex = color(theme, accent);
  const hasCompass = layout.bearingDegrees !== null || layout.compass !== null;
  const identifierMaxWidth = hasCompass ? COMPASS_CX - COMPASS_R - SAFE.left - 8 : CONTENT_WIDTH;

  const identifierSize = fitFontSize(layout.identifier, {
    family: 'mono',
    weight: 700,
    fontSize: 38,
    minFontSize: 20,
    maxWidth: identifierMaxWidth,
  });

  parts.push(
    text({
      x: SAFE.left,
      y: ROW.identifierBaseline,
      text: layout.identifier,
      size: identifierSize,
      weight: 700,
      family: 'mono',
      fill: theme.textPrimary,
      maxWidth: identifierMaxWidth,
    }),
  );

  // Say so when the hero is not a callsign, so a hex code is never mistaken for one.
  if (layout.identifierSource !== 'callsign') {
    parts.push(
      text({
        x: SAFE.left,
        y: ROW.identifierHint,
        text: layout.identifierSource === 'registration' ? 'REGISTRATION' : 'ICAO HEX',
        size: 9.5,
        weight: 600,
        fill: theme.textMuted,
        letterSpacing: 0.8,
        maxWidth: identifierMaxWidth,
      }),
    );
  }

  if (hasCompass) parts.push(renderCompass(layout, theme, accentHex));

  parts.push(
    statBlock(theme, SAFE.left, 'DIST', layout.distanceText, accentHex, null),
    statBlock(
      theme,
      SAFE.left + STAT_COLUMN_WIDTH,
      'ALT',
      layout.altitudeText,
      theme.textPrimary,
      layout.verticalTrend,
    ),
    divider(theme, ROW.divider),
  );

  layout.supporting.slice(0, 2).forEach((item, index) => {
    const y = ROW.supportingFirst + index * ROW.supportingStep;
    parts.push(
      text({
        x: SAFE.left,
        y,
        text: item.label.toUpperCase(),
        size: 10,
        weight: 600,
        fill: theme.textMuted,
        letterSpacing: 0.6,
        maxWidth: CONTENT_WIDTH * 0.42,
      }),
      text({
        x: CANVAS - SAFE.right,
        y,
        text: item.value,
        size: 13,
        weight: 700,
        fill: item.tone ? color(theme, item.tone) : theme.textSecondary,
        anchor: 'end',
        maxWidth: CONTENT_WIDTH * 0.56,
      }),
    );
  });

  parts.push(footer(theme, layout.attribution), footerRight(theme, layout.footer));
  return parts.join('');
}

function statBlock(
  theme: Theme,
  x: number,
  label: string,
  value: string,
  tone: string,
  trend: AircraftFrameLayout['verticalTrend'],
): string {
  const valueSize = fitFontSize(value, {
    family: 'display',
    weight: 700,
    fontSize: 22,
    minFontSize: 15,
    maxWidth: STAT_VALUE_WIDTH,
  });

  const parts = [
    text({
      x,
      y: ROW.statLabel,
      text: label,
      size: 10,
      weight: 600,
      fill: theme.textMuted,
      letterSpacing: 0.8,
    }),
    text({
      x,
      y: ROW.statValueBaseline,
      text: value,
      size: valueSize,
      weight: 700,
      fill: tone,
      maxWidth: STAT_VALUE_WIDTH,
    }),
  ];

  if (trend && trend !== 'level') {
    // A glyph, not a colour: vertical trend must survive a monochrome read. Positioned
    // from the measured value width so it never overlaps a long altitude.
    const glyph = trend === 'climbing' ? '▲' : '▼';
    const toneHex = trend === 'climbing' ? theme.colors.green : theme.colors.amber;
    const valueWidth = Math.min(STAT_VALUE_WIDTH, textWidth(value, valueSize, 'display', 700));
    parts.push(
      text({
        x: x + valueWidth + 4,
        y: ROW.statValueBaseline - 8,
        text: glyph,
        size: 9,
        weight: 700,
        fill: toneHex,
      }),
    );
  }
  return parts.join('');
}

function renderCompass(layout: AircraftFrameLayout, theme: Theme, accentHex: string): string {
  const parts = [
    circle({
      cx: COMPASS_CX,
      cy: COMPASS_CY,
      r: COMPASS_R,
      stroke: theme.surfaceAlt,
      strokeWidth: 2,
    }),
    text({
      x: COMPASS_CX,
      y: COMPASS_CY - COMPASS_R + 1,
      text: 'N',
      size: 8,
      weight: 700,
      fill: theme.textMuted,
      anchor: 'middle',
    }),
  ];

  if (layout.bearingDegrees !== null) {
    parts.push(
      bearingArrow({
        cx: COMPASS_CX,
        cy: COMPASS_CY,
        size: 25,
        bearingDegrees: layout.bearingDegrees,
        color: accentHex,
      }),
    );
  } else {
    parts.push(
      icon({
        id: 'compass',
        x: COMPASS_CX - 10,
        y: COMPASS_CY - 10,
        size: 20,
        color: theme.textMuted,
      }),
    );
  }

  if (layout.compass) {
    parts.push(
      text({
        x: COMPASS_CX,
        y: COMPASS_CY + COMPASS_R + 13,
        text: layout.compass,
        size: 12,
        weight: 700,
        fill: theme.textSecondary,
        anchor: 'middle',
      }),
    );
  }
  return parts.join('');
}
