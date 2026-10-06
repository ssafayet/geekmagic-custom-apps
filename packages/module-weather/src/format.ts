import type { WeatherSettings } from './settings.js';

/** Absence stays absence. An em dash is unambiguous; `0%` would be a lie. */
export const MISSING = '—';

const HPA_PER_INHG = 33.8639;
const MM_PER_INCH = 25.4;

export function formatTemperature(celsius: number | null, units: WeatherSettings['units']): string {
  if (celsius === null) return MISSING;
  const value = units === 'imperial' ? (celsius * 9) / 5 + 32 : celsius;
  // Round first, then normalise: `Math.round(-0.4)` is `-0`, which prints as `-0°`.
  const rounded = Math.round(value) || 0;
  return `${rounded}°`;
}

export function formatWindSpeed(
  kmh: number | null,
  unit: WeatherSettings['windSpeedUnit'],
): string {
  if (kmh === null) return MISSING;
  switch (unit) {
    case 'ms': {
      const ms = kmh / 3.6;
      // Light air in m/s needs the decimal; a gale does not.
      return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} m/s`;
    }
    case 'mph':
      return `${Math.round(kmh / 1.609344)} mph`;
    case 'kn':
      return `${Math.round(kmh / 1.852)} kn`;
    default:
      return `${Math.round(kmh)} km/h`;
  }
}

export function formatPressure(hpa: number | null, units: WeatherSettings['units']): string {
  if (hpa === null) return MISSING;
  return units === 'imperial'
    ? `${(hpa / HPA_PER_INHG).toFixed(2)} inHg`
    : `${Math.round(hpa)} hPa`;
}

export function formatPrecipitation(mm: number | null, units: WeatherSettings['units']): string {
  if (mm === null) return MISSING;
  return units === 'imperial' ? `${(mm / MM_PER_INCH).toFixed(2)} in` : `${mm.toFixed(1)} mm`;
}

export function formatPercent(value: number | null): string {
  return value === null ? MISSING : `${Math.round(value)}%`;
}

/** WHO exposure categories, which is what every consumer UV scale prints. */
export function uvCategory(index: number): {
  label: string;
  tone: 'green' | 'amber' | 'orange' | 'red' | 'purple';
} {
  if (index < 3) return { label: 'Low', tone: 'green' };
  if (index < 6) return { label: 'Moderate', tone: 'amber' };
  if (index < 8) return { label: 'High', tone: 'orange' };
  if (index < 11) return { label: 'Very high', tone: 'red' };
  return { label: 'Extreme', tone: 'purple' };
}

/**
 * The direction arrow points where the air is going, which is opposite to the
 * meteorological "from" bearing the provider reports and the compass word names.
 */
export function windArrowDegrees(fromDegrees: number): number {
  return (fromDegrees + 180) % 360;
}
