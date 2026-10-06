import { describe, expect, it } from 'vitest';
import { aqiCategory, usAqiFromPm25 } from '../src/aqi.js';

describe('usAqiFromPm25', () => {
  // Every band edge from Table 6 of the 2024 AQI Technical Assistance Document.
  it.each([
    [0, 0],
    [9.0, 50],
    [9.1, 51],
    [35.4, 100],
    [35.5, 101],
    [55.4, 150],
    [55.5, 151],
    [125.4, 200],
    [125.5, 201],
    [225.4, 300],
    [225.5, 301],
    [325.4, 500],
  ])('maps %s µg/m³ to AQI %s', (pm25, expected) => {
    expect(usAqiFromPm25(pm25)).toBe(expected);
  });

  it('uses the 2024 breakpoints, not the 12.0 µg/m³ Good ceiling they replaced', () => {
    // 12.0 was the top of Good before the revision; it is now well into Moderate.
    expect(usAqiFromPm25(12.0)).toBe(56);
  });

  it('truncates to one decimal before looking up the band, as the document says', () => {
    // Rounding would put 9.09 in Moderate; truncation keeps it at the top of Good.
    expect(usAqiFromPm25(9.09)).toBe(50);
    expect(usAqiFromPm25(35.49)).toBe(100);
  });

  it('keeps reporting past 500 instead of capping a wildfire reading', () => {
    expect(usAqiFromPm25(500)).toBeGreaterThan(500);
  });

  it('turns absence into null, never zero', () => {
    expect(usAqiFromPm25(null)).toBeNull();
    expect(usAqiFromPm25(Number.NaN)).toBeNull();
    expect(usAqiFromPm25(-1)).toBeNull();
  });
});

describe('aqiCategory', () => {
  it.each([
    [0, 'Good', 'green'],
    [50, 'Good', 'green'],
    [51, 'Moderate', 'amber'],
    [101, 'Unhealthy (sensitive)', 'orange'],
    [151, 'Unhealthy', 'red'],
    [201, 'Very unhealthy', 'purple'],
    [301, 'Hazardous', 'magenta'],
    [612, 'Hazardous', 'magenta'],
  ])('puts %s in %s', (index, label, tone) => {
    expect(aqiCategory(index)).toMatchObject({ label, tone });
  });

  it('gives every category a short label that fits a half-width tile', () => {
    for (const index of [0, 51, 101, 151, 201, 301]) {
      expect(aqiCategory(index).shortLabel.length).toBeLessThanOrEqual(12);
    }
  });
});
