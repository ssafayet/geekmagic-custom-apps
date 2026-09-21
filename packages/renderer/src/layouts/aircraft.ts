import type { AircraftFrameLayout, SemanticColor } from '@gca/module-sdk';
import { divider, footer, footerRight } from '../chrome.js';
import { bearingArrow, icon } from '../icons.js';
import { CANVAS, CONTENT_WIDTH, SAFE, circle, text, textWidth } from '../svg.js';
import { fitFontSize } from '../fonts.js';
import { color, type Theme } from '../theme.js';

const COMPASS_CX = 200;
const COMPASS_CY = 64;
const COMPASS_R = 21;

/** Fixed vertical rhythm: every band is measured from the top so nothing can collide. */
const ROW = {
  identifierBaseline: 62,
  /** Airline name, or the identifier-source hint. Never both — see `renderSubIdentifier`. */
  subIdentifier: 76,
  statLabel: 110,
  statValueBaseline: 134,
  divider: 146,
  detailFirst: 163,
  detailStep: 17,
} as const;

/**
 * Three detail rows fit between the divider and the footer, which is what the route
 * costs: reg/type, speed, then origin and destination.
 */
const MAX_DETAIL_ROWS = 3;

const STAT_COLUMN_WIDTH = CONTENT_WIDTH / 2;
/** Leaves room for the vertical-trend glyph without letting the value run into it. */
const STAT_VALUE_WIDTH = STAT_COLUMN_WIDTH - 14;

const DETAIL_LABEL_WIDTH = CONTENT_WIDTH * 0.42;
const DETAIL_VALUE_WIDTH = CONTENT_WIDTH * 0.56;
const DETAIL_VALUE_SIZE = 13;

const ROUTE_SIZE = DETAIL_VALUE_SIZE;
/** Breathing room either side of the arrow so the two codes read as separate places. */
const ROUTE_GAP = 4.5;
/** Absence stays absence: one known end of a route still says something. */
const ROUTE_UNKNOWN = '—';

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
    fontSize: 32,
    minFontSize: 18,
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
    renderSubIdentifier(layout, theme, identifierMaxWidth),
  );

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

  // The route is one more detail row rather than a band of its own, so a frame without
  // it looks like the frame always did instead of leaving a hole.
  const routeRows = layout.route ? 1 : 0;
  const supporting = layout.supporting.slice(0, MAX_DETAIL_ROWS - routeRows);

  supporting.forEach((item, index) => {
    const y = ROW.detailFirst + index * ROW.detailStep;
    parts.push(
      detailLabel(theme, y, item.label),
      text({
        x: CANVAS - SAFE.right,
        y,
        text: item.value,
        size: DETAIL_VALUE_SIZE,
        weight: 700,
        fill: item.tone ? color(theme, item.tone) : theme.textSecondary,
        anchor: 'end',
        maxWidth: DETAIL_VALUE_WIDTH,
      }),
    );
  });

  if (layout.route) {
    const y = ROW.detailFirst + supporting.length * ROW.detailStep;
    parts.push(detailLabel(theme, y, 'Route'), renderRoute(layout.route, y, theme, accentHex));
  }

  parts.push(footer(theme, layout.attribution), footerRight(theme, layout.footer));
  return parts.join('');
}

/**
 * The line under the identifier carries the airline when one was resolved, and
 * otherwise says what the identifier is.
 *
 * These are mutually exclusive by construction: an airline can only be looked up from
 * a callsign, and the source hint only appears when the identifier is not one. Sharing
 * the line is what makes room for the route without moving anything else.
 */
function renderSubIdentifier(layout: AircraftFrameLayout, theme: Theme, maxWidth: number): string {
  if (layout.airline) {
    return text({
      x: SAFE.left,
      y: ROW.subIdentifier,
      text: layout.airline,
      size: 10.5,
      weight: 600,
      fill: theme.textSecondary,
      maxWidth,
    });
  }

  // Say so when the hero is not a callsign, so a hex code is never mistaken for one.
  if (layout.identifierSource === 'callsign') return '';
  return text({
    x: SAFE.left,
    y: ROW.subIdentifier,
    text: layout.identifierSource === 'registration' ? 'REGISTRATION' : 'ICAO HEX',
    size: 9.5,
    weight: 600,
    fill: theme.textMuted,
    letterSpacing: 0.8,
    maxWidth,
  });
}

function detailLabel(theme: Theme, y: number, label: string): string {
  return text({
    x: SAFE.left,
    y,
    text: label.toUpperCase(),
    size: 10,
    weight: 600,
    fill: theme.textMuted,
    letterSpacing: 0.6,
    maxWidth: DETAIL_LABEL_WIDTH,
  });
}

/**
 * `LHR → JFK`, right-aligned to match the other detail values.
 *
 * Drawn as three runs rather than one string: the codes are mono so they align with the
 * callsign above them, and the arrow is accented because direction is the whole point
 * of the row. Both airports shrink together when a pair of four-letter ICAO codes turns
 * up in place of IATA.
 */
function renderRoute(
  route: NonNullable<AircraftFrameLayout['route']>,
  y: number,
  theme: Theme,
  accentHex: string,
): string {
  const origin = route.origin ?? ROUTE_UNKNOWN;
  const destination = route.destination ?? ROUTE_UNKNOWN;
  const arrow = '→';

  const size = fitRoute(origin, destination, arrow);
  const originWidth = textWidth(origin, size, 'mono', 700);
  const arrowWidth = textWidth(arrow, size, 'display', 700);
  const destinationWidth = textWidth(destination, size, 'mono', 700);
  const total = originWidth + destinationWidth + arrowWidth + ROUTE_GAP * 2;

  const startX = CANVAS - SAFE.right - total;
  const arrowX = startX + originWidth + ROUTE_GAP;

  return [
    text({
      x: startX,
      y,
      text: origin,
      size,
      weight: 700,
      family: 'mono',
      fill: theme.textPrimary,
    }),
    text({ x: arrowX, y, text: arrow, size, weight: 700, fill: accentHex }),
    text({
      x: arrowX + arrowWidth + ROUTE_GAP,
      y,
      text: destination,
      size,
      weight: 700,
      family: 'mono',
      fill: theme.textPrimary,
    }),
  ].join('');
}

/** Largest size at which the whole `origin → destination` run fits the value column. */
function fitRoute(origin: string, destination: string, arrow: string): number {
  let size = ROUTE_SIZE;
  while (size > 9) {
    const width =
      textWidth(origin, size, 'mono', 700) +
      textWidth(destination, size, 'mono', 700) +
      textWidth(arrow, size, 'display', 700) +
      ROUTE_GAP * 2;
    if (width <= DETAIL_VALUE_WIDTH) return size;
    size -= 0.5;
  }
  return size;
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
        size: 22,
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
        y: COMPASS_CY + COMPASS_R + 12,
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
