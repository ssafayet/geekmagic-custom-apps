import {
  ellipsize,
  measureTextWidth,
  SVG_DISPLAY_FAMILY,
  SVG_MONO_FAMILY,
  type FontFamily,
  type FontWeight,
} from './fonts.js';

/** Final panel size. All layout maths uses this coordinate space; the raster is 2x. */
export const CANVAS = 240;
export const SUPERSAMPLE = 2;
export const RASTER = CANVAS * SUPERSAMPLE;

/** Keeps content clear of the bezel and of any rounding on the panel's corners. */
export const SAFE = {
  left: 14,
  right: 14,
  top: 12,
  bottom: 12,
} as const;

export const CONTENT_WIDTH = CANVAS - SAFE.left - SAFE.right;

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/**
 * Escapes text for XML and strips control characters.
 *
 * Every string reaching the SVG comes from a module or a remote provider, so this is a
 * trust boundary: an unescaped callsign must never be able to inject markup.
 */
export function escapeXml(value: string): string {
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char)
  );
}

export type TextAnchor = 'start' | 'middle' | 'end';

export interface TextOptions {
  x: number;
  y: number;
  text: string;
  size: number;
  fill: string;
  family?: FontFamily;
  weight?: FontWeight;
  anchor?: TextAnchor;
  letterSpacing?: number;
  opacity?: number;
  /** When set, the string is ellipsized to fit before it reaches the rasterizer. */
  maxWidth?: number;
}

export function text(options: TextOptions): string {
  const {
    x,
    y,
    size,
    fill,
    family = 'display',
    weight = 400,
    anchor = 'start',
    letterSpacing = 0,
    opacity,
    maxWidth,
  } = options;

  const fitted =
    maxWidth === undefined
      ? options.text
      : ellipsize(options.text, { family, weight, fontSize: size, maxWidth, letterSpacing });
  if (fitted.length === 0) return '';

  const attrs = [
    `x="${round(x)}"`,
    `y="${round(y)}"`,
    `font-family="${family === 'mono' ? SVG_MONO_FAMILY : SVG_DISPLAY_FAMILY}"`,
    `font-size="${round(size)}"`,
    `font-weight="${weight}"`,
    `fill="${fill}"`,
    `text-anchor="${anchor}"`,
  ];
  if (letterSpacing !== 0) attrs.push(`letter-spacing="${round(letterSpacing)}"`);
  if (opacity !== undefined) attrs.push(`opacity="${round(opacity, 3)}"`);
  return `<text ${attrs.join(' ')}>${escapeXml(fitted)}</text>`;
}

export function textWidth(
  value: string,
  size: number,
  family: FontFamily = 'display',
  weight: FontWeight = 400,
  letterSpacing = 0,
): number {
  return measureTextWidth(value, { family, weight, fontSize: size, letterSpacing });
}

export function rect(options: {
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  radius?: number;
  opacity?: number;
}): string {
  const { x, y, width, height, fill, radius = 0, opacity } = options;
  const attrs = [
    `x="${round(x)}"`,
    `y="${round(y)}"`,
    `width="${round(width)}"`,
    `height="${round(height)}"`,
    `fill="${fill}"`,
  ];
  if (radius > 0) attrs.push(`rx="${round(radius)}"`);
  if (opacity !== undefined) attrs.push(`opacity="${round(opacity, 3)}"`);
  return `<rect ${attrs.join(' ')} />`;
}

export function line(options: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  width?: number;
  opacity?: number;
}): string {
  const { x1, y1, x2, y2, stroke, width = 1, opacity } = options;
  return `<line x1="${round(x1)}" y1="${round(y1)}" x2="${round(x2)}" y2="${round(y2)}" stroke="${stroke}" stroke-width="${round(width)}"${opacity === undefined ? '' : ` opacity="${round(opacity, 3)}"`} />`;
}

export function circle(options: {
  cx: number;
  cy: number;
  r: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
}): string {
  const { cx, cy, r, fill = 'none', stroke, strokeWidth = 1, opacity } = options;
  const attrs = [`cx="${round(cx)}"`, `cy="${round(cy)}"`, `r="${round(r)}"`, `fill="${fill}"`];
  if (stroke) attrs.push(`stroke="${stroke}"`, `stroke-width="${round(strokeWidth)}"`);
  if (opacity !== undefined) attrs.push(`opacity="${round(opacity, 3)}"`);
  return `<circle ${attrs.join(' ')} />`;
}

export function path(
  d: string,
  options: {
    fill?: string;
    stroke?: string;
    strokeWidth?: number;
    opacity?: number;
    linecap?: 'round' | 'butt';
  },
): string {
  const { fill = 'none', stroke, strokeWidth = 1, opacity, linecap } = options;
  const attrs = [`d="${d}"`, `fill="${fill}"`];
  if (stroke) attrs.push(`stroke="${stroke}"`, `stroke-width="${round(strokeWidth)}"`);
  if (linecap) attrs.push(`stroke-linecap="${linecap}"`);
  if (opacity !== undefined) attrs.push(`opacity="${round(opacity, 3)}"`);
  return `<path ${attrs.join(' ')} />`;
}

/** Arc path for progress rings, drawn clockwise from 12 o'clock. */
export function arcPath(
  cx: number,
  cy: number,
  r: number,
  fromDegrees: number,
  toDegrees: number,
): string {
  const sweep = Math.min(359.999, Math.max(0, toDegrees - fromDegrees));
  if (sweep <= 0) return '';
  const start = polar(cx, cy, r, fromDegrees);
  const end = polar(cx, cy, r, fromDegrees + sweep);
  const largeArc = sweep > 180 ? 1 : 0;
  return `M ${round(start.x)} ${round(start.y)} A ${round(r)} ${round(r)} 0 ${largeArc} 1 ${round(end.x)} ${round(end.y)}`;
}

function polar(cx: number, cy: number, r: number, degrees: number): { x: number; y: number } {
  // -90 puts 0 degrees at the top of the ring rather than at 3 o'clock.
  const radians = ((degrees - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(radians), y: cy + r * Math.sin(radians) };
}

export function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function document(body: string, background: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${RASTER}" height="${RASTER}" viewBox="0 0 ${CANVAS} ${CANVAS}">`,
    rect({ x: 0, y: 0, width: CANVAS, height: CANVAS, fill: background }),
    body,
    '</svg>',
  ].join('');
}
