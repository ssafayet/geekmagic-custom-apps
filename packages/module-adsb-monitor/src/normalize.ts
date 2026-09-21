import type { Aircraft } from './types.js';

/**
 * Turns one provider record into a normalized aircraft, or null if unusable.
 *
 * Every field except identity and position is optional, and absent data stays absent:
 * a missing altitude must never become 0 ft on the display.
 */
export function normalizeAircraft(raw: unknown): Aircraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;

  const hex = cleanString(record['hex'])?.toLowerCase();
  if (!hex) return null;

  const latitude = finiteNumber(record['lat']);
  const longitude = finiteNumber(record['lon']);
  if (latitude === null || longitude === null) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  // Exactly (0,0) is Null Island: overwhelmingly a bad record rather than a real position.
  if (latitude === 0 && longitude === 0) return null;

  const { altitudeFt, onGround } = normalizeAltitude(record['alt_baro'], record['alt_geom']);

  return {
    hex,
    callsign: normalizeCallsign(record['flight']),
    registration: cleanString(record['r'])?.toUpperCase() ?? null,
    typeCode: cleanString(record['t'])?.toUpperCase() ?? null,
    latitude,
    longitude,
    altitudeFt,
    onGround,
    groundSpeedKt: nonNegative(finiteNumber(record['gs'])),
    trackDegrees: normalizeTrack(record['track']),
    verticalRateFpm: finiteNumber(record['baro_rate']) ?? finiteNumber(record['geom_rate']),
    squawk: cleanString(record['squawk']),
    emergency: normalizeEmergency(record['emergency']),
    positionAgeSeconds: nonNegative(finiteNumber(record['seen_pos'])),
    sourceType: cleanString(record['type']),
  };
}

export function normalizeAircraftList(raw: unknown): Aircraft[] {
  if (!Array.isArray(raw)) return [];
  const out: Aircraft[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const aircraft = normalizeAircraft(item);
    if (!aircraft) continue;
    // Providers occasionally repeat a hex within one response; keep the first.
    if (seen.has(aircraft.hex)) continue;
    seen.add(aircraft.hex);
    out.push(aircraft);
  }
  return out;
}

/**
 * Barometric altitude is preferred, then geometric. The literal string `ground` is the
 * provider's way of saying "on the ground" and carries no numeric altitude.
 */
export function normalizeAltitude(
  baro: unknown,
  geom: unknown,
): { altitudeFt: number | null; onGround: boolean } {
  if (typeof baro === 'string' && baro.trim().toLowerCase() === 'ground') {
    return { altitudeFt: null, onGround: true };
  }
  if (typeof geom === 'string' && geom.trim().toLowerCase() === 'ground') {
    return { altitudeFt: null, onGround: true };
  }
  const baroValue = finiteNumber(baro);
  if (baroValue !== null) return { altitudeFt: baroValue, onGround: false };
  const geomValue = finiteNumber(geom);
  if (geomValue !== null) return { altitudeFt: geomValue, onGround: false };
  return { altitudeFt: null, onGround: false };
}

export function normalizeCallsign(value: unknown): string | null {
  const cleaned = cleanString(value);
  if (!cleaned) return null;
  const upper = cleaned.toUpperCase().replace(/\s+/g, '');
  return upper.length > 0 ? upper : null;
}

function normalizeTrack(value: unknown): number | null {
  const track = finiteNumber(value);
  if (track === null) return null;
  // Only wrap when the value is genuinely out of range: applying the modulo
  // unconditionally introduces float drift (214.2 becomes 214.20000000000005),
  // which would churn snapshot fingerprints on otherwise identical data.
  if (track >= 0 && track < 360) return track;
  return ((track % 360) + 360) % 360;
}

function normalizeEmergency(value: unknown): string | null {
  const cleaned = cleanString(value);
  if (!cleaned) return null;
  // Providers send "none" rather than omitting the field when there is no emergency.
  return cleaned.toLowerCase() === 'none' ? null : cleaned.toLowerCase();
}

function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function nonNegative(value: number | null): number | null {
  return value === null || value < 0 ? null : value;
}
