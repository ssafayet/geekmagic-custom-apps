import { createHash } from 'node:crypto';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import { computeFrameFingerprint, type ModuleFrame, type ModuleFrameDraft } from '@gca/module-sdk';
import { AppError } from '@gca/shared';
import { header } from './chrome.js';
import { fontFilePaths, SVG_DISPLAY_FAMILY } from './fonts.js';
import {
  renderAircraft,
  renderDualProgress,
  renderEmpty,
  renderError,
  renderEvent,
  renderHero,
  renderWeather,
} from './layouts/index.js';
import { CANVAS, RASTER, document as svgDocument } from './svg.js';
import { resolveTheme, type Theme } from './theme.js';

export interface RenderOptions {
  themeId?: string;
  /** JPEG quality; the spec's usable band is 86-90 and the default is 88. */
  quality?: number;
}

export interface EncodedFrame {
  frameId: string;
  viewId: string;
  bytes: Buffer;
  /** SHA-256 over the final encoded bytes; the upload queue compares this. */
  sha256: string;
  fingerprint: string;
  width: number;
  height: number;
  contentType: 'image/jpeg';
  renderedAt: string;
}

const MIN_QUALITY = 86;
const MAX_QUALITY = 90;
const DEFAULT_QUALITY = 88;

/** Builds the SVG for a frame without rasterizing. Exposed for tests and diagnostics. */
export function renderFrameToSvg(frame: ModuleFrame | ModuleFrameDraft, themeId?: string): string {
  const theme: Theme = resolveTheme(themeId);
  const body = [
    header({
      theme,
      title: frame.title,
      icon: frame.icon,
      accent: frame.accent,
      badge: frame.badge,
    }),
    renderLayoutBody(frame, theme),
  ].join('');
  return svgDocument(body, theme.background);
}

function renderLayoutBody(frame: ModuleFrame | ModuleFrameDraft, theme: Theme): string {
  switch (frame.layout.kind) {
    case 'hero':
      return renderHero(frame.layout, theme, frame.accent);
    case 'dual-progress':
      return renderDualProgress(frame.layout, theme, frame.accent);
    case 'aircraft':
      return renderAircraft(frame.layout, theme, frame.accent);
    case 'weather':
      return renderWeather(frame.layout, theme, frame.accent);
    case 'event':
      return renderEvent(frame.layout, theme, frame.accent);
    case 'empty':
      return renderEmpty(frame.layout, theme, frame.accent);
    case 'error':
      return renderError(frame.layout, theme);
    default: {
      // Exhaustiveness guard: a new layout kind must be handled here explicitly.
      const unreachable: never = frame.layout;
      throw new AppError(
        'INTERNAL_ERROR',
        `Unsupported frame layout: ${JSON.stringify(unreachable)}`,
      );
    }
  }
}

/**
 * Frame -> 240x240 JPEG.
 *
 * Rasterizes at 2x with explicitly loaded bundled fonts (no system fontconfig, so a
 * container renders identically to a laptop), downsamples with Lanczos, flattens onto
 * black because the panels have no alpha, then hashes the encoded bytes.
 */
export class FrameRenderer {
  readonly #fontFiles: string[];

  constructor(private readonly defaults: RenderOptions = {}) {
    this.#fontFiles = fontFilePaths();
  }

  async render(
    frame: ModuleFrame | ModuleFrameDraft,
    options: RenderOptions = {},
  ): Promise<EncodedFrame> {
    const themeId = options.themeId ?? this.defaults.themeId;
    const quality = clampQuality(options.quality ?? this.defaults.quality ?? DEFAULT_QUALITY);
    const svg = renderFrameToSvg(frame, themeId);

    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: RASTER },
      background: resolveTheme(themeId).background,
      font: {
        loadSystemFonts: false,
        fontFiles: this.#fontFiles,
        defaultFontFamily: SVG_DISPLAY_FAMILY,
      },
    });

    const png = resvg.render().asPng();
    const bytes = await sharp(png)
      .resize(CANVAS, CANVAS, { kernel: 'lanczos3', fit: 'fill' })
      .flatten({ background: '#000000' })
      .jpeg({ quality, chromaSubsampling: '4:2:0', progressive: false })
      .toBuffer();

    return {
      frameId: frame.id,
      viewId: frame.viewId,
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      fingerprint: frame.fingerprint ?? computeFrameFingerprint(frame),
      width: CANVAS,
      height: CANVAS,
      contentType: 'image/jpeg',
      renderedAt: new Date().toISOString(),
    };
  }

  /** PNG at native size, used by the web UI preview where JPEG artifacts distract. */
  async renderPreviewPng(
    frame: ModuleFrame | ModuleFrameDraft,
    options: RenderOptions = {},
  ): Promise<Buffer> {
    const themeId = options.themeId ?? this.defaults.themeId;
    const svg = renderFrameToSvg(frame, themeId);
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: RASTER },
      background: resolveTheme(themeId).background,
      font: {
        loadSystemFonts: false,
        fontFiles: this.#fontFiles,
        defaultFontFamily: SVG_DISPLAY_FAMILY,
      },
    });
    return sharp(resvg.render().asPng())
      .resize(CANVAS, CANVAS, { kernel: 'lanczos3', fit: 'fill' })
      .png({ compressionLevel: 9 })
      .toBuffer();
  }
}

function clampQuality(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_QUALITY;
  return Math.min(MAX_QUALITY, Math.max(MIN_QUALITY, Math.round(value)));
}
