/** Mean Earth radius in nautical miles, per the ADS-B module specification. */
export const EARTH_RADIUS_NM = 3440.065;

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

export function isValidLatitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isValidLongitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;
}

export function isValidPoint(value: unknown): value is GeoPoint {
  if (typeof value !== 'object' || value === null) return false;
  const point = value as Partial<GeoPoint>;
  return isValidLatitude(point.latitude) && isValidLongitude(point.longitude);
}

/** Great-circle ground distance in nautical miles (Haversine). */
export function haversineDistanceNm(from: GeoPoint, to: GeoPoint): number {
  const lat1 = from.latitude * DEG_TO_RAD;
  const lat2 = to.latitude * DEG_TO_RAD;
  const deltaLat = (to.latitude - from.latitude) * DEG_TO_RAD;
  const deltaLon = (to.longitude - from.longitude) * DEG_TO_RAD;

  const a =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  // atan2 form stays numerically stable for antipodal points, unlike asin(sqrt(a)).
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_NM * c;
}

/** Initial great-circle bearing from `from` to `to`, normalized to [0, 360). */
export function initialBearingDegrees(from: GeoPoint, to: GeoPoint): number {
  const lat1 = from.latitude * DEG_TO_RAD;
  const lat2 = to.latitude * DEG_TO_RAD;
  const deltaLon = (to.longitude - from.longitude) * DEG_TO_RAD;

  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  const bearing = Math.atan2(y, x) * RAD_TO_DEG;
  return (bearing + 360) % 360;
}

const COMPASS_POINTS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
] as const;

export type CompassPoint = (typeof COMPASS_POINTS)[number];

export function bearingToCompass(bearingDegrees: number): CompassPoint {
  const normalized = ((bearingDegrees % 360) + 360) % 360;
  const index = Math.round(normalized / 22.5) % 16;
  // Index is bounded by the modulo above; the assertion documents that for the checker.
  return COMPASS_POINTS[index] as CompassPoint;
}

export const NM_PER_KM = 0.539957;
export const FT_PER_METRE = 3.28084;
export const KT_PER_KMH = 0.539957;

export function nmToKm(nm: number): number {
  return nm / NM_PER_KM;
}

export function feetToMetres(feet: number): number {
  return feet / FT_PER_METRE;
}

export function knotsToKmh(knots: number): number {
  return knots / KT_PER_KMH;
}
