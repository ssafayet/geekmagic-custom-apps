import { describe, expect, it } from 'vitest';
import type { AircraftFrameLayout, FrameContext } from '@gca/module-sdk';
import { buildAircraftFrame } from '../src/frames.js';
import { ADSB_DEFAULT_SETTINGS } from '../src/settings.js';
import type { AdsbSnapshot, RankedAircraft } from '../src/types.js';

const NOW = new Date('2026-09-22T12:00:00Z');

const ctx: FrameContext = { now: NOW, timezone: 'UTC', accent: 'cyan' };

const snapshot: AdsbSnapshot = {
  capturedAt: NOW.toISOString(),
  observedAt: NOW.toISOString(),
  aircraft: [],
  totalSeen: 1,
  attribution: 'Data: adsb.fi',
  error: null,
  lastSuccessAt: NOW.toISOString(),
};

function aircraft(overrides: Partial<RankedAircraft> = {}): RankedAircraft {
  return {
    hex: 'a0f1c9',
    callsign: 'BAW117',
    registration: 'G-STBA',
    typeCode: 'B77W',
    latitude: 51.5,
    longitude: -0.4,
    altitudeFt: 12_350,
    onGround: false,
    groundSpeedKt: 287,
    trackDegrees: 214,
    verticalRateFpm: 1_200,
    squawk: '2000',
    emergency: null,
    positionAgeSeconds: 3,
    sourceType: 'adsb_icao',
    distanceNm: 1.4,
    bearingDegrees: 214,
    overhead: true,
    ...overrides,
  };
}

function layoutFor(overrides: Partial<RankedAircraft> = {}): AircraftFrameLayout {
  const draft = buildAircraftFrame(
    aircraft(overrides),
    0,
    snapshot,
    ADSB_DEFAULT_SETTINGS,
    ctx,
    false,
  );
  if (draft.layout.kind !== 'aircraft') throw new Error('expected an aircraft layout');
  return draft.layout;
}

describe('buildAircraftFrame airline and route', () => {
  it('carries the airline and both airports when the lookup resolved them', () => {
    const layout = layoutFor({
      route: { airline: 'British Airways', origin: 'LHR', destination: 'JFK' },
    });

    expect(layout.airline).toBe('British Airways');
    expect(layout.route).toEqual({ origin: 'LHR', destination: 'JFK' });
  });

  it('leaves both out entirely when no lookup has resolved', () => {
    const layout = layoutFor();
    expect(layout.airline).toBeUndefined();
    expect(layout.route).toBeUndefined();
  });

  it('leaves both out when the lookup ran and found nothing', () => {
    const layout = layoutFor({ route: null });
    expect(layout.airline).toBeUndefined();
    expect(layout.route).toBeUndefined();
  });

  it('shows an operator that has no published route', () => {
    const layout = layoutFor({
      route: { airline: 'British Airways', origin: null, destination: null },
    });
    expect(layout.airline).toBe('British Airways');
    expect(layout.route).toBeUndefined();
  });

  it('shows one known end of a route', () => {
    const layout = layoutFor({
      route: { airline: null, origin: 'MEM', destination: null },
    });
    expect(layout.route).toEqual({ origin: 'MEM', destination: null });
  });

  it('suppresses the airline when the hero is not a callsign', () => {
    // The line under the identifier is shared with the source hint, and an aircraft
    // with no callsign needs that hint more than it needs an operator it cannot have.
    const layout = layoutFor({
      callsign: null,
      route: { airline: 'British Airways', origin: 'LHR', destination: 'JFK' },
    });

    expect(layout.identifierSource).toBe('registration');
    expect(layout.airline).toBeUndefined();
    expect(layout.route).toEqual({ origin: 'LHR', destination: 'JFK' });
  });

  it('keeps reg/type and speed alongside the route', () => {
    const layout = layoutFor({
      route: { airline: 'British Airways', origin: 'LHR', destination: 'JFK' },
    });

    expect(layout.supporting).toEqual([
      { label: 'Reg / Type', value: 'G-STBA · B77W' },
      { label: 'Speed', value: '287 kt' },
    ]);
  });

  it('credits the route source only on frames that used it', () => {
    expect(layoutFor().attribution).toBe('Data: adsb.fi');
    expect(layoutFor({ route: null }).attribution).toBe('Data: adsb.fi');
    expect(
      layoutFor({ route: { airline: 'British Airways', origin: 'LHR', destination: 'JFK' } })
        .attribution,
    ).toBe('Data: adsb.fi · adsbdb');
  });
});
