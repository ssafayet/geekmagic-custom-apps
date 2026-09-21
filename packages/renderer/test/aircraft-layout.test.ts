import { describe, expect, it } from 'vitest';
import type { AircraftFrameLayout, ModuleFrameDraft } from '@gca/module-sdk';
import { finalizeFrame, renderFrameToSvg } from '../src/index.js';

const NOW = new Date('2026-09-22T12:00:00Z');

/** Matches the renderer's own safe area and footer band. */
const CONTENT_BOTTOM = 208;
const FOOTER_BASELINE = 231;
const SAFE_LEFT = 14;
const SAFE_RIGHT_EDGE = 226;

interface Drawn {
  x: number;
  y: number;
  size: number;
  content: string;
}

function drawnText(layout: Partial<AircraftFrameLayout> = {}): Drawn[] {
  const draft: ModuleFrameDraft = {
    id: 'x',
    viewId: 'aircraft',
    title: 'Overhead',
    icon: 'aircraft',
    accent: 'cyan',
    priority: 'normal',
    layout: {
      kind: 'aircraft',
      state: 'overhead',
      identifier: 'BAW117',
      identifierSource: 'callsign',
      distanceText: '1.4 NM',
      altitudeText: '12,350 ft',
      bearingDegrees: 214,
      compass: 'SW',
      verticalTrend: 'climbing',
      supporting: [
        { label: 'Reg / Type', value: 'G-STBA · B77W' },
        { label: 'Speed', value: '287 kt' },
      ],
      footer: '3s ago',
      attribution: 'Data: adsb.fi',
      ...layout,
    },
  };

  const svg = renderFrameToSvg(finalizeFrame(draft, { now: NOW }));
  return [...svg.matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)].map((match) => ({
    x: Number(/x="([-\d.]+)"/.exec(match[1] ?? '')?.[1]),
    y: Number(/y="([-\d.]+)"/.exec(match[1] ?? '')?.[1]),
    size: Number(/font-size="([-\d.]+)"/.exec(match[1] ?? '')?.[1]),
    content: match[2] ?? '',
  }));
}

const contentOf = (drawn: Drawn[]): string[] => drawn.map((item) => item.content);

const ROUTE = { origin: 'LHR', destination: 'JFK' };

describe('aircraft layout', () => {
  it('draws the airline under the identifier', () => {
    const drawn = drawnText({ airline: 'British Airways', route: ROUTE });
    const identifier = drawn.find((item) => item.content === 'BAW117');
    const airline = drawn.find((item) => item.content === 'British Airways');

    expect(identifier).toBeDefined();
    expect(airline).toBeDefined();
    expect(airline!.y).toBeGreaterThan(identifier!.y);
    expect(airline!.x).toBe(SAFE_LEFT);
    // Small enough to read as a caption rather than compete with the callsign.
    expect(airline!.size).toBeLessThan(identifier!.size / 2);
  });

  it('gives the airline and the identifier-source hint the same line, never both', () => {
    const withAirline = contentOf(drawnText({ airline: 'British Airways' }));
    expect(withAirline).toContain('British Airways');
    expect(withAirline).not.toContain('ICAO HEX');
    expect(withAirline).not.toContain('REGISTRATION');

    const withHint = contentOf(drawnText({ identifier: 'A0F1C9', identifierSource: 'hex' }));
    expect(withHint).toContain('ICAO HEX');

    const airlineRow = drawnText({ airline: 'British Airways' }).find(
      (item) => item.content === 'British Airways',
    );
    const hintRow = drawnText({ identifier: 'A0F1C9', identifierSource: 'hex' }).find(
      (item) => item.content === 'ICAO HEX',
    );
    expect(airlineRow!.y).toBe(hintRow!.y);
  });

  it('draws the route below the speed row', () => {
    const drawn = drawnText({ route: ROUTE });
    const speed = drawn.find((item) => item.content === '287 kt')!;
    const label = drawn.find((item) => item.content === 'ROUTE')!;
    const origin = drawn.find((item) => item.content === 'LHR')!;
    const destination = drawn.find((item) => item.content === 'JFK')!;

    expect(label.y).toBeGreaterThan(speed.y);
    expect(origin.y).toBe(label.y);
    expect(destination.y).toBe(label.y);
    expect(origin.x).toBeLessThan(destination.x);
    expect(contentOf(drawn)).toContain('→');
  });

  it('keeps reg/type and speed when the route is added', () => {
    const drawn = contentOf(drawnText({ route: ROUTE }));
    expect(drawn).toContain('G-STBA · B77W');
    expect(drawn).toContain('287 kt');
    expect(drawn).toContain('LHR');
  });

  it('draws no route row when there is no route', () => {
    expect(contentOf(drawnText())).not.toContain('ROUTE');
  });

  it('marks an unknown end of the route rather than inventing one', () => {
    const drawn = contentOf(drawnText({ route: { origin: 'MEM', destination: null } }));
    expect(drawn).toContain('MEM');
    expect(drawn).toContain('—');
  });

  it('keeps every row inside the safe area, even at its fullest', () => {
    const drawn = drawnText({
      airline: 'Singapore Airlines Cargo',
      route: { origin: 'WSSS', destination: 'EGLL' },
      attribution: 'Data: adsb.fi · adsbdb',
    });

    expect(drawn.length).toBeGreaterThan(0);
    for (const item of drawn) {
      expect(item.x, item.content).toBeGreaterThanOrEqual(0);
      expect(item.x, item.content).toBeLessThanOrEqual(SAFE_RIGHT_EDGE);
      // Only the footer may sit below the content band.
      const limit = item.y === FOOTER_BASELINE ? FOOTER_BASELINE : CONTENT_BOTTOM;
      expect(item.y, item.content).toBeLessThanOrEqual(limit);
    }
  });

  it('keeps the route clear of its own label column', () => {
    const drawn = drawnText({ route: { origin: 'WSSS', destination: 'EGLL' } });
    const label = drawn.find((item) => item.content === 'ROUTE')!;
    const origin = drawn.find((item) => item.content === 'WSSS')!;

    // The label is left-aligned at the safe edge; the value run must start well past it.
    expect(origin.x).toBeGreaterThan(label.x + 60);
  });

  it('drops the lowest-value detail row rather than overflowing', () => {
    const drawn = drawnText({
      route: ROUTE,
      supporting: [
        { label: 'Reg / Type', value: 'G-STBA · B77W' },
        { label: 'Speed', value: '287 kt' },
        { label: 'Squawk', value: '2000' },
      ],
    });

    expect(contentOf(drawn)).not.toContain('2000');
    expect(contentOf(drawn)).toContain('LHR');
    for (const item of drawn) {
      if (item.y !== FOOTER_BASELINE) expect(item.y).toBeLessThanOrEqual(CONTENT_BOTTOM);
    }
  });
});
