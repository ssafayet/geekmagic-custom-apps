import { round } from './svg.js';

/**
 * Built-in icon set.
 *
 * Modules reference icons by id only — they cannot supply path data. That keeps
 * arbitrary vector content out of the render pipeline while still allowing variety.
 */
const ICON_PATHS: Record<string, string> = {
  // 24x24 source grid.
  sparkle: 'M12 2 L14.2 8.6 L21 11 L14.2 13.4 L12 20 L9.8 13.4 L3 11 L9.8 8.6 Z',
  aircraft:
    'M12 2 C12.9 2 13.6 3 13.6 4.4 L13.6 9 L21.5 13.6 L21.5 15.6 L13.6 13.4 L13.6 18.4 L16.4 20.4 L16.4 22 L12 20.8 L7.6 22 L7.6 20.4 L10.4 18.4 L10.4 13.4 L2.5 15.6 L2.5 13.6 L10.4 9 L10.4 4.4 C10.4 3 11.1 2 12 2 Z',
  // Three subpaths: a 270-degree outer sweep, a matching inner ring, and the sweep arm.
  radar: 'M3 12 A9 9 0 1 1 12 21 M7.5 12 A4.5 4.5 0 1 1 12 16.5 M12 12 L19.4 4.6',
  clock: 'M12 3 A9 9 0 1 0 12.01 3 Z M12 7 L12 12.4 L16 14.6',
  warning: 'M12 3 L22 20.5 L2 20.5 Z M12 9 L12 15 M12 17.4 L12 18.6',
  error: 'M12 3 A9 9 0 1 0 12.01 3 Z M8.5 8.5 L15.5 15.5 M15.5 8.5 L8.5 15.5',
  offline:
    'M3 4 L21 20 M12 18.5 L12 18.6 M5.5 10.5 A9 9 0 0 1 9 8.4 M18.5 10.5 A9 9 0 0 0 14.6 8.2 M8.4 14 A5 5 0 0 1 10.4 12.7',
  check: 'M4 12.5 L9.5 18 L20 6.5',
  cost: 'M12 3 L12 21 M16.5 7.2 C16.5 5.4 14.5 4.4 12 4.4 C9.5 4.4 7.6 5.5 7.6 7.6 C7.6 12.4 16.8 10.6 16.8 15.6 C16.8 18 14.6 19.4 12 19.4 C9.4 19.4 7.2 18.2 7.2 16.2',
  gauge: 'M3.5 17.5 A9.5 9.5 0 1 1 20.5 17.5 M12 17 L16.5 9.5',
  settings:
    'M12 8.4 A3.6 3.6 0 1 0 12.01 8.4 Z M12 2.5 L13.4 5.2 L16.4 4.6 L16.6 7.6 L19.4 8.8 L17.8 11.3 L19.4 13.8 L16.6 15 L16.4 18 L13.4 17.4 L12 20.1 L10.6 17.4 L7.6 18 L7.4 15 L4.6 13.8 L6.2 11.3 L4.6 8.8 L7.4 7.6 L7.6 4.6 L10.6 5.2 Z',
  compass: 'M12 3 A9 9 0 1 0 12.01 3 Z M15.5 8.5 L13.2 13.2 L8.5 15.5 L10.8 10.8 Z',

  // Weather glyphs, adapted from Lucide (ISC; see LICENSE). Multi-element originals are
  // folded into one path, with circles as two arcs, so they fit this single-`d` model.
  thermometer: 'M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z',
  droplet:
    'M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z',
  wind: 'M12.8 19.6A2 2 0 1 0 14 16H2 M17.5 8a2.5 2.5 0 1 1 2 4H2 M9.8 4.4A2 2 0 1 1 11 8H2',
  leaf: 'M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12',
  'clear-day':
    'M8 12a4 4 0 1 0 8 0a4 4 0 1 0-8 0 M12 2v2 M12 20v2 M4.93 4.93l1.41 1.41 M17.66 17.66l1.41 1.41 M2 12h2 M20 12h2 M6.34 17.66l-1.41 1.41 M19.07 4.93l-1.41 1.41',
  'clear-night': 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z',
  'partly-cloudy-day':
    'M12 2v2 M4.93 4.93l1.41 1.41 M20 12h2 M19.07 4.93l-1.41 1.41 M15.947 12.65a4 4 0 0 0-5.925-4.128 M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z',
  'partly-cloudy-night':
    'M10.188 8.5A6 6 0 0 1 16 4a1 1 0 0 0 6 6 6 6 0 0 1-3 5.197 M13 16a3 3 0 1 1 0 6H7a5 5 0 1 1 4.9-6Z',
  cloudy: 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z',
  fog: 'M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242 M16 17H7 M17 21H9',
  drizzle:
    'M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242 M8 19v1 M8 14v1 M16 19v1 M16 14v1 M12 21v1 M12 16v1',
  rain: 'M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242 M16 14v6 M8 14v6 M12 16v6',
  snow: 'M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242 M8 15h.01 M8 19h.01 M12 17h.01 M12 21h.01 M16 15h.01 M16 19h.01',
  thunderstorm: 'M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973 M13 12l-3 5h4l-3 5',
};

export const ICON_IDS = Object.keys(ICON_PATHS);

export function hasIcon(id: string): boolean {
  return Object.hasOwn(ICON_PATHS, id);
}

export interface IconOptions {
  id: string;
  x: number;
  y: number;
  size: number;
  color: string;
  /** Stroke-only icons read better at small sizes than filled ones. */
  mode?: 'stroke' | 'fill';
  strokeWidth?: number;
  opacity?: number;
}

/** Renders a built-in icon at `size` px, anchored at its top-left corner. */
export function icon(options: IconOptions): string {
  const { id, x, y, size, color, mode = 'stroke', strokeWidth = 1.8, opacity } = options;
  const d = ICON_PATHS[id];
  if (!d) return '';
  const scale = size / 24;
  const attrs = [
    `d="${d}"`,
    mode === 'fill' ? `fill="${color}"` : 'fill="none"',
    mode === 'stroke' ? `stroke="${color}"` : '',
    mode === 'stroke' ? `stroke-width="${round(strokeWidth)}"` : '',
    'stroke-linecap="round"',
    'stroke-linejoin="round"',
    opacity === undefined ? '' : `opacity="${round(opacity, 3)}"`,
  ].filter(Boolean);
  return `<g transform="translate(${round(x)} ${round(y)}) scale(${round(scale, 4)})"><path ${attrs.join(' ')} /></g>`;
}

/**
 * Direction arrow for ADS-B bearings: a filled triangle rotated to the bearing, so
 * direction is legible at a glance even before the compass abbreviation is read.
 */
export function bearingArrow(options: {
  cx: number;
  cy: number;
  size: number;
  bearingDegrees: number;
  color: string;
}): string {
  const { cx, cy, size, bearingDegrees, color } = options;
  const half = size / 2;
  const d = [
    `M 0 ${round(-half)}`,
    `L ${round(half * 0.72)} ${round(half * 0.82)}`,
    `L 0 ${round(half * 0.4)}`,
    `L ${round(-half * 0.72)} ${round(half * 0.82)}`,
    'Z',
  ].join(' ');
  return `<g transform="translate(${round(cx)} ${round(cy)}) rotate(${round(bearingDegrees, 1)})"><path d="${d}" fill="${color}" /></g>`;
}
