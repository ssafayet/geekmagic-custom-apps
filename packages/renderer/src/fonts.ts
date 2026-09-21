import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { create, type Font } from 'fontkit';

export type FontFamily = 'display' | 'mono';
export type FontWeight = 400 | 600 | 700 | 800;

interface FontEntry {
  family: FontFamily;
  weight: FontWeight;
  /** The family name as it appears inside the TTF, which is what resvg matches on. */
  svgFamily: string;
  file: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
// `src` during development, `dist` after a build; assets sit beside both.
const ASSETS_DIR = resolve(HERE, '..', 'assets', 'fonts');

export const SVG_DISPLAY_FAMILY = 'Inter';
export const SVG_MONO_FAMILY = 'JetBrains Mono';

const FONT_ENTRIES: FontEntry[] = [
  { family: 'display', weight: 400, svgFamily: SVG_DISPLAY_FAMILY, file: 'Inter-Regular.ttf' },
  { family: 'display', weight: 600, svgFamily: SVG_DISPLAY_FAMILY, file: 'Inter-SemiBold.ttf' },
  { family: 'display', weight: 700, svgFamily: SVG_DISPLAY_FAMILY, file: 'Inter-Bold.ttf' },
  { family: 'display', weight: 800, svgFamily: SVG_DISPLAY_FAMILY, file: 'Inter-ExtraBold.ttf' },
  { family: 'mono', weight: 700, svgFamily: SVG_MONO_FAMILY, file: 'JetBrainsMono-Bold.ttf' },
];

export function fontFilePaths(): string[] {
  return FONT_ENTRIES.map((entry) => join(ASSETS_DIR, entry.file));
}

interface LoadedFont {
  font: Font;
  unitsPerEm: number;
}

const cache = new Map<string, LoadedFont>();

function keyFor(family: FontFamily, weight: FontWeight): string {
  return `${family}:${weight}`;
}

function nearestEntry(family: FontFamily, weight: FontWeight): FontEntry {
  const candidates = FONT_ENTRIES.filter((entry) => entry.family === family);
  const exact = candidates.find((entry) => entry.weight === weight);
  if (exact) return exact;
  // Fall back to the closest available weight rather than failing to measure.
  const sorted = [...candidates].sort(
    (a, b) => Math.abs(a.weight - weight) - Math.abs(b.weight - weight),
  );
  const fallback = sorted[0];
  if (!fallback) throw new Error(`No bundled font for family "${family}"`);
  return fallback;
}

function load(family: FontFamily, weight: FontWeight): LoadedFont {
  const key = keyFor(family, weight);
  const cached = cache.get(key);
  if (cached) return cached;

  const entry = nearestEntry(family, weight);
  const buffer = readFileSync(join(ASSETS_DIR, entry.file));
  const parsed = create(buffer) as Font;
  const loaded: LoadedFont = { font: parsed, unitsPerEm: parsed.unitsPerEm };
  cache.set(key, loaded);
  return loaded;
}

/**
 * Fallback advance as a fraction of the em square, used when a glyph cannot be
 * measured. JetBrains Mono is exactly 0.6em; Inter averages a little narrower.
 */
const FALLBACK_ADVANCE_EM: Record<FontFamily, number> = { display: 0.55, mono: 0.6 };

/**
 * Advance width in pixels for `text` at `fontSize`.
 *
 * Measuring with the same font files resvg rasterizes with means the ellipsis decision
 * matches what actually gets drawn, instead of an average-character-width guess.
 *
 * Measurement is best-effort by design. Text reaching here can come from a remote
 * provider, and fontkit throws on some malformed or unmapped glyph entries; a layout
 * hint must never be able to crash a render, so every failure degrades to an estimate.
 */
export function measureTextWidth(
  text: string,
  options: { family?: FontFamily; weight?: FontWeight; fontSize: number; letterSpacing?: number },
): number {
  const { family = 'display', weight = 400, fontSize, letterSpacing = 0 } = options;
  if (text.length === 0) return 0;
  const spacing = letterSpacing * Math.max(0, text.length - 1);

  let loaded: LoadedFont;
  try {
    loaded = load(family, weight);
  } catch {
    return estimateWidth(text, family, fontSize) + spacing;
  }

  const { font, unitsPerEm } = loaded;
  const fallbackUnits = FALLBACK_ADVANCE_EM[family] * unitsPerEm;

  try {
    const run = font.layout(text);
    let advance = 0;
    for (const glyph of run.glyphs) {
      try {
        advance += glyph.advanceWidth;
      } catch {
        // A single undecodable glyph should not discard the whole measurement.
        advance += fallbackUnits;
      }
    }
    return (advance / unitsPerEm) * fontSize + spacing;
  } catch {
    return estimateWidth(text, family, fontSize) + spacing;
  }
}

function estimateWidth(text: string, family: FontFamily, fontSize: number): number {
  return [...text].length * FALLBACK_ADVANCE_EM[family] * fontSize;
}

export interface FitOptions {
  family?: FontFamily;
  weight?: FontWeight;
  fontSize: number;
  maxWidth: number;
  letterSpacing?: number;
  ellipsis?: string;
}

/** Truncates with an ellipsis so the result fits `maxWidth` at the given size. */
export function ellipsize(text: string, options: FitOptions): string {
  const { ellipsis = '…', maxWidth } = options;
  if (measureTextWidth(text, options) <= maxWidth) return text;

  const ellipsisWidth = measureTextWidth(ellipsis, options);
  if (ellipsisWidth > maxWidth) return '';

  const characters = [...text];
  let low = 0;
  let high = characters.length;
  // Binary search the longest prefix that still fits alongside the ellipsis.
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = characters.slice(0, mid).join('').trimEnd();
    if (measureTextWidth(candidate, options) + ellipsisWidth <= maxWidth) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  const prefix = characters.slice(0, low).join('').trimEnd();
  return prefix.length === 0 ? ellipsis : `${prefix}${ellipsis}`;
}

/**
 * Largest size within `[minFontSize, fontSize]` at which `text` fits `maxWidth`.
 * Long callsigns shrink instead of truncating, which keeps them readable.
 */
export function fitFontSize(text: string, options: FitOptions & { minFontSize: number }): number {
  const { minFontSize, fontSize, maxWidth } = options;
  if (text.length === 0) return fontSize;
  let size = fontSize;
  while (size > minFontSize) {
    if (measureTextWidth(text, { ...options, fontSize: size }) <= maxWidth) return size;
    size -= 1;
  }
  return minFontSize;
}
