import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { computeFrameFingerprint } from '@gca/module-sdk';
import { finalizeFrame, FrameRenderer, renderFrameToSvg, CANVAS } from '../src/index.js';
import { FRAME_FIXTURES } from './fixtures/frames.js';

const NOW = new Date('2026-09-21T12:00:00Z');
const renderer = new FrameRenderer();
const ARTIFACT_DIR = join(process.cwd(), 'test-artifacts', 'visual-failures');

/**
 * Perceptual hash over a 16x16 luminance grid.
 *
 * Compared with a Hamming-distance tolerance rather than byte equality, so a JPEG
 * encoder revision does not fail the suite while a layout regression still does.
 */
async function perceptualHash(png: Buffer): Promise<string> {
  const { data } = await sharp(png)
    .greyscale()
    .resize(16, 16, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const average = data.reduce((sum, value) => sum + value, 0) / data.length;
  let bits = '';
  for (const value of data) bits += value >= average ? '1' : '0';
  return bits;
}

function hamming(a: string, b: string): number {
  let distance = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) distance += 1;
  }
  return distance;
}

const failures: Array<{ name: string; png: Buffer }> = [];

afterAll(() => {
  if (failures.length === 0) return;
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  for (const failure of failures) {
    writeFileSync(join(ARTIFACT_DIR, `${failure.name}.png`), failure.png);
  }
});

describe('frame rendering', () => {
  it.each(FRAME_FIXTURES.map((fixture) => [fixture.name, fixture] as const))(
    'renders %s to a valid 240x240 JPEG',
    async (name, fixture) => {
      const frame = finalizeFrame(fixture.draft, { now: NOW });
      const encoded = await renderer.render(frame);

      const metadata = await sharp(encoded.bytes).metadata();
      expect(metadata.width).toBe(CANVAS);
      expect(metadata.height).toBe(CANVAS);
      expect(metadata.format).toBe('jpeg');
      // No alpha channel: the panels flatten onto black.
      expect(metadata.hasAlpha).toBe(false);
      expect(encoded.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(encoded.bytes.length).toBeGreaterThan(1_000);
      expect(encoded.bytes.length).toBeLessThan(60_000);

      // A blank or near-blank panel means the layout silently failed to draw.
      const png = await renderer.renderPreviewPng(frame);
      const hash = await perceptualHash(png);
      const lit = [...hash].filter((bit) => bit === '1').length;
      if (lit < 4 || lit > 252) failures.push({ name, png });
      expect(lit, `${name} rendered an almost empty panel`).toBeGreaterThanOrEqual(4);
      expect(lit, `${name} rendered an almost solid panel`).toBeLessThanOrEqual(252);
    },
  );

  it('produces byte-identical output for identical input', async () => {
    const frame = finalizeFrame(FRAME_FIXTURES[0]!.draft, { now: NOW });
    const first = await renderer.render(frame);
    const second = await renderer.render(frame);
    expect(second.sha256).toBe(first.sha256);
  });

  it('produces visually distinct output for each usage level', async () => {
    const names = [
      'claude-usage-low',
      'claude-usage-medium',
      'claude-usage-high',
      'claude-usage-exhausted',
    ];
    const hashes = new Map<string, string>();

    for (const name of names) {
      const fixture = FRAME_FIXTURES.find((candidate) => candidate.name === name);
      const png = await renderer.renderPreviewPng(finalizeFrame(fixture!.draft, { now: NOW }));
      hashes.set(name, await perceptualHash(png));
    }

    // Each step of the ramp must be visibly different from the previous one.
    for (let i = 1; i < names.length; i += 1) {
      const previous = hashes.get(names[i - 1]!)!;
      const current = hashes.get(names[i]!)!;
      expect(
        hamming(previous, current),
        `${names[i - 1]} and ${names[i]} look identical`,
      ).toBeGreaterThan(2);
    }
  });

  it('renders a missing window differently from a zero-percent window', async () => {
    const missing = FRAME_FIXTURES.find((f) => f.name === 'claude-usage-missing-five-hour')!;
    const zeroed = structuredClone(missing.draft);
    if (zeroed.layout.kind === 'dual-progress' && zeroed.layout.gauges[0]) {
      zeroed.layout.gauges[0] = {
        label: '5H',
        percent: 0,
        valueText: '0%',
        caption: 'in 2h',
        tone: 'green',
      };
    }

    const missingHash = await perceptualHash(
      await renderer.renderPreviewPng(finalizeFrame(missing.draft, { now: NOW })),
    );
    const zeroHash = await perceptualHash(
      await renderer.renderPreviewPng(finalizeFrame(zeroed, { now: NOW })),
    );

    expect(hamming(missingHash, zeroHash)).toBeGreaterThan(2);
  });
});

describe('SVG safety', () => {
  it('escapes markup supplied by a module or provider', () => {
    const svg = renderFrameToSvg(
      finalizeFrame(
        {
          id: 'x',
          viewId: 'v',
          title: 'Test',
          accent: 'blue',
          priority: 'normal',
          layout: {
            kind: 'aircraft',
            state: 'nearby',
            identifier: '</text><script>alert(1)</script>',
            identifierSource: 'callsign',
            distanceText: '1 NM',
            altitudeText: '100 ft',
            bearingDegrees: 0,
            compass: 'N',
            verticalTrend: null,
            supporting: [{ label: '<b>x</b>', value: '"quoted" & \'apostrophed\'' }],
            footer: 'now',
            attribution: 'Data: test',
          },
        },
        { now: NOW },
      ),
    );

    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;');
    expect(svg).toContain('&amp;');
    expect(svg).not.toMatch(/<text[^>]*>[^<]*<\/text>[^<]*<script/);
  });

  it('strips control characters', () => {
    const svg = renderFrameToSvg(
      finalizeFrame(
        {
          id: 'x',
          viewId: 'v',
          title: 'Ti\u0000tle',
          accent: 'blue',
          priority: 'normal',
          layout: { kind: 'empty', icon: 'radar', headline: 'He\u0007ad' },
        },
        { now: NOW },
      ),
    );
    expect(svg).not.toContain('\u0000');
    expect(svg).not.toContain('\u0007');
  });
});

describe('fingerprints', () => {
  it('is stable across key ordering', () => {
    const a = computeFrameFingerprint({
      id: 'x',
      viewId: 'v',
      title: 'T',
      accent: 'blue',
      priority: 'normal',
      layout: { kind: 'empty', icon: 'radar', headline: 'A', detail: 'B' },
    });
    const b = computeFrameFingerprint({
      layout: { detail: 'B', headline: 'A', icon: 'radar', kind: 'empty' },
      priority: 'normal',
      accent: 'blue',
      title: 'T',
      viewId: 'v',
      id: 'x',
    });
    expect(a).toBe(b);
  });

  it('ignores validUntil so an unchanged frame is not re-uploaded', () => {
    const base = {
      id: 'x',
      viewId: 'v',
      title: 'T',
      accent: 'blue' as const,
      priority: 'normal' as const,
      layout: { kind: 'empty' as const, icon: 'radar', headline: 'A' },
    };
    const early = finalizeFrame({ ...base }, { now: NOW });
    const later = finalizeFrame({ ...base }, { now: new Date(NOW.getTime() + 60_000) });

    expect(later.validUntil).not.toBe(early.validUntil);
    expect(later.fingerprint).toBe(early.fingerprint);
  });

  it('changes when any visible value changes', () => {
    const base = {
      id: 'x',
      viewId: 'v',
      title: 'T',
      accent: 'blue' as const,
      priority: 'normal' as const,
      layout: { kind: 'empty' as const, icon: 'radar', headline: 'A' },
    };
    const original = computeFrameFingerprint(base);

    expect(computeFrameFingerprint({ ...base, title: 'U' })).not.toBe(original);
    expect(computeFrameFingerprint({ ...base, accent: 'red' })).not.toBe(original);
    expect(
      computeFrameFingerprint({ ...base, layout: { ...base.layout, headline: 'B' } }),
    ).not.toBe(original);
    expect(computeFrameFingerprint({ ...base, badge: { text: 'stale', tone: 'amber' } })).not.toBe(
      original,
    );
  });

  it('gives every fixture a distinct fingerprint', () => {
    const fingerprints = FRAME_FIXTURES.map((fixture) => computeFrameFingerprint(fixture.draft));
    expect(new Set(fingerprints).size).toBe(FRAME_FIXTURES.length);
  });
});
