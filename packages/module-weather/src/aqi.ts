import type { SemanticColor } from '@gca/module-sdk';

interface Breakpoint {
  concentrationLow: number;
  concentrationHigh: number;
  indexLow: number;
  indexHigh: number;
}

/**
 * US EPA PM2.5 breakpoints (µg/m³), Table 6 of the AQI Technical Assistance Document
 * as revised in 2024. The Hazardous band runs to 325.4 at index 500 and the equation
 * keeps going past it, so a wildfire reading is reported, not capped.
 */
const PM25_BREAKPOINTS: readonly Breakpoint[] = [
  { concentrationLow: 0.0, concentrationHigh: 9.0, indexLow: 0, indexHigh: 50 },
  { concentrationLow: 9.1, concentrationHigh: 35.4, indexLow: 51, indexHigh: 100 },
  { concentrationLow: 35.5, concentrationHigh: 55.4, indexLow: 101, indexHigh: 150 },
  { concentrationLow: 55.5, concentrationHigh: 125.4, indexLow: 151, indexHigh: 200 },
  { concentrationLow: 125.5, concentrationHigh: 225.4, indexLow: 201, indexHigh: 300 },
  { concentrationLow: 225.5, concentrationHigh: 325.4, indexLow: 301, indexHigh: 500 },
];

/**
 * US AQI from a PM2.5 concentration.
 *
 * The breakpoints are defined for a 24-hour average; applied to a monitor's current
 * reading this is the same approximation every consumer air-quality display makes,
 * and it is why the docs call the AirGradient figure "from current PM2.5".
 */
export function usAqiFromPm25(pm25: number | null): number | null {
  if (pm25 === null || !Number.isFinite(pm25) || pm25 < 0) return null;
  // The document truncates PM2.5 to one decimal before looking up the band.
  // The epsilon keeps a float like 35.4 * 10 = 353.99999… from truncating a band low.
  const concentration = Math.floor(pm25 * 10 + 1e-9) / 10;
  const band =
    PM25_BREAKPOINTS.find((candidate) => concentration <= candidate.concentrationHigh) ??
    PM25_BREAKPOINTS[PM25_BREAKPOINTS.length - 1]!;
  const index =
    ((band.indexHigh - band.indexLow) / (band.concentrationHigh - band.concentrationLow)) *
      (concentration - band.concentrationLow) +
    band.indexLow;
  return Math.round(index);
}

export interface AqiCategory {
  /** The EPA name, for the panel that has a line to spare. */
  label: string;
  /** Fits after the value in a half-width tile. */
  shortLabel: string;
  tone: SemanticColor;
}

/**
 * EPA category for an index. Maroon is not in the semantic palette, so Hazardous uses
 * magenta; the word, not the colour, is what carries it.
 */
export function aqiCategory(index: number): AqiCategory {
  if (index <= 50) return { label: 'Good', shortLabel: 'Good', tone: 'green' };
  if (index <= 100) return { label: 'Moderate', shortLabel: 'Moderate', tone: 'amber' };
  if (index <= 150) {
    // The EPA name, "Unhealthy for Sensitive Groups", does not fit the caption line.
    return { label: 'Unhealthy (sensitive)', shortLabel: 'Sensitive', tone: 'orange' };
  }
  if (index <= 200) return { label: 'Unhealthy', shortLabel: 'Unhealthy', tone: 'red' };
  if (index <= 300) return { label: 'Very unhealthy', shortLabel: 'V. unhealthy', tone: 'purple' };
  return { label: 'Hazardous', shortLabel: 'Hazardous', tone: 'magenta' };
}
