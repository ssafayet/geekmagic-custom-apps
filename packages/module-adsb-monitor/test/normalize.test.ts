import { describe, expect, it } from 'vitest';
import {
  normalizeAircraft,
  normalizeAircraftList,
  normalizeAltitude,
  normalizeCallsign,
} from '../src/normalize.js';

const base = { hex: 'a1b2c3', lat: 51.5, lon: -0.4 };

describe('normalizeAircraft', () => {
  it('normalizes a complete record', () => {
    const aircraft = normalizeAircraft({
      ...base,
      flight: 'BAW117  ',
      r: 'g-stba',
      t: 'b77w',
      alt_baro: 12350,
      gs: 287.4,
      track: 214.2,
      baro_rate: 1280,
      squawk: '2000',
      emergency: 'none',
      seen_pos: 3.2,
      type: 'adsb_icao',
    });

    expect(aircraft).toMatchObject({
      hex: 'a1b2c3',
      callsign: 'BAW117',
      registration: 'G-STBA',
      typeCode: 'B77W',
      altitudeFt: 12350,
      onGround: false,
      groundSpeedKt: 287.4,
      trackDegrees: 214.2,
      verticalRateFpm: 1280,
      squawk: '2000',
      // "none" is the provider's way of saying there is no emergency.
      emergency: null,
      positionAgeSeconds: 3.2,
      sourceType: 'adsb_icao',
    });
  });

  it('rejects a record with no identity', () => {
    expect(normalizeAircraft({ lat: 51.5, lon: -0.4 })).toBeNull();
    expect(normalizeAircraft({ hex: '   ', lat: 51.5, lon: -0.4 })).toBeNull();
  });

  it('rejects records with missing or invalid coordinates', () => {
    expect(normalizeAircraft({ hex: 'abc' })).toBeNull();
    expect(normalizeAircraft({ hex: 'abc', lat: 91, lon: 0 })).toBeNull();
    expect(normalizeAircraft({ hex: 'abc', lat: 0, lon: 181 })).toBeNull();
    expect(normalizeAircraft({ hex: 'abc', lat: 'north', lon: 0 })).toBeNull();
  });

  it('rejects the (0,0) null-island placeholder', () => {
    expect(normalizeAircraft({ hex: 'abc', lat: 0, lon: 0 })).toBeNull();
  });

  it('keeps every optional field absent rather than zero', () => {
    const aircraft = normalizeAircraft(base);
    expect(aircraft).toMatchObject({
      callsign: null,
      registration: null,
      typeCode: null,
      altitudeFt: null,
      groundSpeedKt: null,
      trackDegrees: null,
      verticalRateFpm: null,
      squawk: null,
      positionAgeSeconds: null,
    });
  });

  it('treats non-objects and null as unusable', () => {
    expect(normalizeAircraft(null)).toBeNull();
    expect(normalizeAircraft('BAW117')).toBeNull();
    expect(normalizeAircraft([])).toBeNull();
  });

  it('coerces numeric strings the provider sometimes sends', () => {
    const aircraft = normalizeAircraft({ ...base, alt_baro: '3200', gs: '150' });
    expect(aircraft?.altitudeFt).toBe(3200);
    expect(aircraft?.groundSpeedKt).toBe(150);
  });

  it('normalizes a track outside 0-360', () => {
    expect(normalizeAircraft({ ...base, track: 380 })?.trackDegrees).toBe(20);
    expect(normalizeAircraft({ ...base, track: -10 })?.trackDegrees).toBe(350);
  });

  it('drops a negative position age and negative ground speed', () => {
    const aircraft = normalizeAircraft({ ...base, seen_pos: -1, gs: -5 });
    expect(aircraft?.positionAgeSeconds).toBeNull();
    expect(aircraft?.groundSpeedKt).toBeNull();
  });

  it('preserves a real emergency code', () => {
    expect(normalizeAircraft({ ...base, emergency: 'general' })?.emergency).toBe('general');
  });

  it('falls back to geometric vertical rate when barometric is absent', () => {
    expect(normalizeAircraft({ ...base, geom_rate: -900 })?.verticalRateFpm).toBe(-900);
  });
});

describe('normalizeAltitude', () => {
  it('prefers barometric over geometric', () => {
    expect(normalizeAltitude(10000, 10250)).toEqual({ altitudeFt: 10000, onGround: false });
  });

  it('falls back to geometric when barometric is missing', () => {
    expect(normalizeAltitude(undefined, 10250)).toEqual({ altitudeFt: 10250, onGround: false });
  });

  it('turns the literal string "ground" into onGround with no altitude', () => {
    expect(normalizeAltitude('ground', undefined)).toEqual({ altitudeFt: null, onGround: true });
    expect(normalizeAltitude('GROUND', 50)).toEqual({ altitudeFt: null, onGround: true });
    expect(normalizeAltitude(undefined, 'ground')).toEqual({ altitudeFt: null, onGround: true });
  });

  it('reports unknown altitude as null, never zero', () => {
    expect(normalizeAltitude(undefined, undefined)).toEqual({ altitudeFt: null, onGround: false });
    expect(normalizeAltitude(null, null)).toEqual({ altitudeFt: null, onGround: false });
  });

  it('keeps a genuine zero or negative altitude', () => {
    expect(normalizeAltitude(0, undefined).altitudeFt).toBe(0);
    expect(normalizeAltitude(-225, undefined).altitudeFt).toBe(-225);
  });
});

describe('normalizeCallsign', () => {
  it('trims and uppercases', () => {
    expect(normalizeCallsign('  baw117 ')).toBe('BAW117');
  });

  it('removes internal padding the feed sometimes includes', () => {
    expect(normalizeCallsign('BAW 117 ')).toBe('BAW117');
  });

  it('returns null for empty or non-string values', () => {
    expect(normalizeCallsign('   ')).toBeNull();
    expect(normalizeCallsign(undefined)).toBeNull();
    expect(normalizeCallsign(42)).toBeNull();
  });
});

describe('normalizeAircraftList', () => {
  it('drops unusable entries and keeps the rest', () => {
    const list = normalizeAircraftList([base, { hex: 'bad' }, null, { ...base, hex: 'ffffff' }]);
    expect(list.map((item) => item.hex)).toEqual(['a1b2c3', 'ffffff']);
  });

  it('de-duplicates repeated hex codes, keeping the first', () => {
    const list = normalizeAircraftList([
      { ...base, flight: 'FIRST' },
      { ...base, flight: 'SECOND' },
    ]);
    expect(list).toHaveLength(1);
    expect(list[0]?.callsign).toBe('FIRST');
  });

  it('returns an empty array for a non-array input', () => {
    expect(normalizeAircraftList(null)).toEqual([]);
    expect(normalizeAircraftList({ ac: [] })).toEqual([]);
  });
});
