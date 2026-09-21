import { describe, expect, it } from 'vitest';
import {
  bearingToCompass,
  EARTH_RADIUS_NM,
  feetToMetres,
  haversineDistanceNm,
  initialBearingDegrees,
  isValidLatitude,
  isValidLongitude,
  knotsToKmh,
  nmToKm,
} from '../src/geo.js';

/**
 * Reference values computed against the same great-circle formulae the spec names.
 * Tolerances are documented per case rather than blanket-loose.
 */
describe('haversineDistanceNm', () => {
  it('returns zero for identical points', () => {
    const point = { latitude: 51.4775, longitude: -0.4614 };
    expect(haversineDistanceNm(point, point)).toBe(0);
  });

  it('matches a known short hop (Heathrow to Gatwick, 22.09 NM)', () => {
    const distance = haversineDistanceNm(
      { latitude: 51.4775, longitude: -0.4614 },
      { latitude: 51.1537, longitude: -0.1821 },
    );
    // Published great-circle distance is 22.09 NM; hold to 0.01 NM.
    expect(distance).toBeCloseTo(22.0865, 3);
  });

  it('matches a known long haul (JFK to LHR, ~2990 NM)', () => {
    const distance = haversineDistanceNm(
      { latitude: 40.6413, longitude: -73.7781 },
      { latitude: 51.4775, longitude: -0.4614 },
    );
    expect(distance).toBeGreaterThan(2980);
    expect(distance).toBeLessThan(3010);
  });

  it('computes a quarter circumference between pole and equator', () => {
    const distance = haversineDistanceNm(
      { latitude: 0, longitude: 0 },
      { latitude: 90, longitude: 0 },
    );
    expect(distance).toBeCloseTo((Math.PI / 2) * EARTH_RADIUS_NM, 3);
  });

  it('stays stable for antipodal points', () => {
    const distance = haversineDistanceNm(
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 180 },
    );
    expect(distance).toBeCloseTo(Math.PI * EARTH_RADIUS_NM, 3);
  });

  it('is symmetric', () => {
    const a = { latitude: 34.05, longitude: -118.24 };
    const b = { latitude: 35.68, longitude: 139.69 };
    expect(haversineDistanceNm(a, b)).toBeCloseTo(haversineDistanceNm(b, a), 9);
  });

  it('handles the antimeridian without going the long way round', () => {
    const distance = haversineDistanceNm(
      { latitude: 0, longitude: 179.5 },
      { latitude: 0, longitude: -179.5 },
    );
    // One degree of longitude at the equator is ~60 NM.
    expect(distance).toBeCloseTo(60, 0);
  });
});

describe('initialBearingDegrees', () => {
  it('returns 0 for due north and 90 for due east', () => {
    const origin = { latitude: 0, longitude: 0 };
    expect(initialBearingDegrees(origin, { latitude: 1, longitude: 0 })).toBeCloseTo(0, 6);
    expect(initialBearingDegrees(origin, { latitude: 0, longitude: 1 })).toBeCloseTo(90, 6);
    expect(initialBearingDegrees(origin, { latitude: -1, longitude: 0 })).toBeCloseTo(180, 6);
    expect(initialBearingDegrees(origin, { latitude: 0, longitude: -1 })).toBeCloseTo(270, 6);
  });

  it('always normalizes into [0, 360)', () => {
    const origin = { latitude: 51.5, longitude: -0.1 };
    for (const target of [
      { latitude: 51.6, longitude: -0.2 },
      { latitude: 51.4, longitude: 0.3 },
      { latitude: 40, longitude: -170 },
      { latitude: -40, longitude: 170 },
    ]) {
      const bearing = initialBearingDegrees(origin, target);
      expect(bearing).toBeGreaterThanOrEqual(0);
      expect(bearing).toBeLessThan(360);
    }
  });

  it('gives a north-easterly bearing from London to Oslo', () => {
    const bearing = initialBearingDegrees(
      { latitude: 51.5074, longitude: -0.1278 },
      { latitude: 59.9139, longitude: 10.7522 },
    );
    expect(bearing).toBeGreaterThan(25);
    expect(bearing).toBeLessThan(45);
  });
});

describe('bearingToCompass', () => {
  it.each([
    [0, 'N'],
    [11, 'N'],
    [23, 'NNE'],
    [45, 'NE'],
    [90, 'E'],
    [135, 'SE'],
    [180, 'S'],
    [225, 'SW'],
    [270, 'W'],
    [315, 'NW'],
    [340, 'NNW'],
    [349, 'N'],
    [359, 'N'],
  ])('maps %d degrees to %s', (bearing, expected) => {
    expect(bearingToCompass(bearing)).toBe(expected);
  });

  it('wraps values outside 0-360', () => {
    expect(bearingToCompass(361)).toBe('N');
    expect(bearingToCompass(-90)).toBe('W');
  });
});

describe('unit conversions and validation', () => {
  it('converts between aviation and metric units', () => {
    expect(nmToKm(10)).toBeCloseTo(18.52, 1);
    expect(feetToMetres(10000)).toBeCloseTo(3048, 0);
    expect(knotsToKmh(100)).toBeCloseTo(185.2, 0);
  });

  it('validates coordinate ranges', () => {
    expect(isValidLatitude(90)).toBe(true);
    expect(isValidLatitude(-90)).toBe(true);
    expect(isValidLatitude(90.1)).toBe(false);
    expect(isValidLatitude(Number.NaN)).toBe(false);
    expect(isValidLatitude('51' as unknown)).toBe(false);
    expect(isValidLongitude(180)).toBe(true);
    expect(isValidLongitude(-180.1)).toBe(false);
  });
});
