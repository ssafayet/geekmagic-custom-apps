import type { SemanticColor, WeatherFrameLayout, WeatherTile } from '@gca/module-sdk';
import { divider, footer, footerRight } from '../chrome.js';
import { bearingArrow, icon } from '../icons.js';
import { CANVAS, CONTENT_WIDTH, SAFE, text, textWidth } from '../svg.js';
import { fitFontSize } from '../fonts.js';
import { color, type Theme } from '../theme.js';

const ICON_SIZE = 50;
const ICON_X = CANVAS - SAFE.right - ICON_SIZE;
const ICON_Y = 38;

/** Fixed vertical rhythm, measured from the top so nothing can collide. */
const ROW = {
  temperatureBaseline: 88,
  condition: 110,
  summary: 127,
  divider: 138,
  tileLabel: [153, 189],
  tileValue: [171, 207],
} as const;

const MAX_TILES = 4;
const COLUMN_GAP = 8;
const COLUMN_WIDTH = (CONTENT_WIDTH - COLUMN_GAP) / 2;
const TILE_VALUE_SIZE = 16;
const TILE_DETAIL_SIZE = 10.5;
const ARROW_SIZE = 11;
/** Arrow plus the space between it and the value. */
const ARROW_ADVANCE = ARROW_SIZE + 4;
const DETAIL_GAP = 4;
/** A value never shrinks below this to make room for its detail word; the word yields. */
const MIN_VALUE_WIDTH = COLUMN_WIDTH * 0.45;

/**
 * Temperature hero with the condition glyph on the right, then a two-by-two grid.
 *
 * The temperature is the one number a viewer glances up for, so it gets the panel's
 * largest type. Each tile is a label over a value, with an optional word after the
 * value: that word is what carries an AQI category, so the tile still reads correctly
 * on a panel whose colours are washed out.
 */
export function renderWeather(
  layout: WeatherFrameLayout,
  theme: Theme,
  accent: SemanticColor,
): string {
  const parts: string[] = [];
  const accentHex = color(theme, accent);
  const temperatureMaxWidth = ICON_X - SAFE.left - 8;

  const temperatureSize = fitFontSize(layout.temperatureText, {
    family: 'display',
    weight: 800,
    fontSize: 60,
    minFontSize: 34,
    maxWidth: temperatureMaxWidth,
  });

  parts.push(
    text({
      x: SAFE.left,
      y: ROW.temperatureBaseline,
      text: layout.temperatureText,
      size: temperatureSize,
      weight: 800,
      fill: theme.textPrimary,
      maxWidth: temperatureMaxWidth,
    }),
    icon({
      id: layout.conditionIcon,
      x: ICON_X,
      y: ICON_Y,
      size: ICON_SIZE,
      color: accentHex,
      strokeWidth: 1.5,
    }),
    text({
      x: SAFE.left,
      y: ROW.condition,
      text: layout.condition,
      size: 15,
      weight: 700,
      fill: theme.textSecondary,
      maxWidth: CONTENT_WIDTH,
    }),
  );

  if (layout.summary) {
    parts.push(
      text({
        x: SAFE.left,
        y: ROW.summary,
        text: layout.summary,
        size: 11.5,
        weight: 600,
        fill: theme.textMuted,
        maxWidth: CONTENT_WIDTH,
      }),
    );
  }

  parts.push(divider(theme, ROW.divider));

  layout.tiles.slice(0, MAX_TILES).forEach((tile, index) => {
    const column = index % 2;
    const row = index < 2 ? 0 : 1;
    const x = SAFE.left + column * (COLUMN_WIDTH + COLUMN_GAP);
    parts.push(renderTile(tile, x, ROW.tileLabel[row], ROW.tileValue[row], theme, accentHex));
  });

  parts.push(footer(theme, layout.attribution), footerRight(theme, layout.footer));
  return parts.join('');
}

function renderTile(
  tile: WeatherTile,
  x: number,
  labelY: number,
  valueY: number,
  theme: Theme,
  accentHex: string,
): string {
  const parts = [
    text({
      x,
      y: labelY,
      text: tile.label.toUpperCase(),
      size: 9.5,
      weight: 600,
      fill: theme.textMuted,
      letterSpacing: 0.7,
      maxWidth: COLUMN_WIDTH,
    }),
  ];

  const hasArrow = tile.arrowDegrees !== undefined && Number.isFinite(tile.arrowDegrees);
  let cursorX = x;
  if (hasArrow) {
    parts.push(
      bearingArrow({
        cx: x + ARROW_SIZE / 2,
        cy: valueY - 5.5,
        size: ARROW_SIZE,
        bearingDegrees: tile.arrowDegrees as number,
        color: accentHex,
      }),
    );
    cursorX += ARROW_ADVANCE;
  }

  const available = x + COLUMN_WIDTH - cursorX;
  const detailWidth = tile.detail
    ? textWidth(tile.detail, TILE_DETAIL_SIZE, 'display', 700) + DETAIL_GAP
    : 0;
  const valueMaxWidth = Math.max(MIN_VALUE_WIDTH, available - detailWidth);
  const valueSize = fitFontSize(tile.value, {
    family: 'display',
    weight: 700,
    fontSize: TILE_VALUE_SIZE,
    minFontSize: 12,
    maxWidth: valueMaxWidth,
  });
  const toneHex = tile.tone ? color(theme, tile.tone) : null;

  parts.push(
    text({
      x: cursorX,
      y: valueY,
      text: tile.value,
      size: valueSize,
      weight: 700,
      fill: toneHex ?? theme.textPrimary,
      maxWidth: valueMaxWidth,
    }),
  );

  if (tile.detail) {
    const valueWidth = Math.min(valueMaxWidth, textWidth(tile.value, valueSize, 'display', 700));
    const detailX = cursorX + valueWidth + DETAIL_GAP;
    const detailMaxWidth = x + COLUMN_WIDTH - detailX;
    if (detailMaxWidth > 12) {
      parts.push(
        text({
          x: detailX,
          y: valueY,
          text: tile.detail,
          size: TILE_DETAIL_SIZE,
          weight: 700,
          fill: toneHex ?? theme.textSecondary,
          maxWidth: detailMaxWidth,
        }),
      );
    }
  }
  return parts.join('');
}
