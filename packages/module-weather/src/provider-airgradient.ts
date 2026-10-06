import { AppError, haversineDistanceNm, nmToKm } from '@gca/shared';
import type { ScopedHttpClient } from '@gca/module-sdk';
import { usAqiFromPm25 } from './aqi.js';
import { asRecord, finiteOrNull, parseRetryAfter, stringOrNull } from './parse.js';
import type { AirQualityReading, WeatherQuery } from './types.js';

export const AIRGRADIENT_API = 'https://api.airgradient.com/public/api/v1';
export const AIRGRADIENT_ATTRIBUTION = 'AirGradient';

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
/** The public world list is ~1.5 MB today; only the test action ever asks for it. */
const MAX_WORLD_RESPONSE_BYTES = 6 * 1024 * 1024;
const WORLD_LIST_TIMEOUT_MS = 15_000;

export type AirGradientAccess = { kind: 'token'; token: string } | { kind: 'public' };

/** One AirGradient location, as the test action lists them. */
export interface AirGradientLocation {
  locationId: number;
  name: string | null;
  usAqi: number | null;
  observedAt: string | null;
  /** Only for public monitors, measured from the configured coordinates. */
  distanceKm?: number;
}

/**
 * AirGradient cloud API.
 *
 * Two routes in: a token reads the monitors on the user's own account, and the keyless
 * `world` endpoints read any monitor its owner made public on the map. Neither returns
 * an AQI, so the index is computed here from PM2.5.
 */
export class AirGradientProvider {
  readonly attribution = AIRGRADIENT_ATTRIBUTION;

  constructor(private readonly http: ScopedHttpClient) {}

  async fetchReading(
    access: AirGradientAccess,
    locationId: number | null,
    signal: AbortSignal,
  ): Promise<AirQualityReading> {
    if (access.kind === 'public') {
      if (locationId === null) {
        throw new AppError(
          'AIRGRADIENT_NOT_CONFIGURED',
          'Choose a public AirGradient location ID in module settings.',
        );
      }
      const payload = await this.getJson(
        `${AIRGRADIENT_API}/world/locations/${locationId}/measures/current`,
        access,
        signal,
      );
      const reading = parseMeasure(payload);
      if (!reading) throw locationNotFound(locationId);
      return reading;
    }

    const measures = await this.listOwn(access.token, signal);
    if (measures.length === 0) {
      throw new AppError(
        'AIRGRADIENT_LOCATION_NOT_FOUND',
        'This AirGradient account has no monitors with readings yet.',
      );
    }
    const chosen =
      locationId === null ? measures[0] : measures.find((entry) => entry.locationId === locationId);
    if (!chosen) throw locationNotFound(locationId as number);
    return chosen.reading;
  }

  /** Every monitor on the account, for the test action to list. */
  async listOwnLocations(token: string, signal: AbortSignal): Promise<AirGradientLocation[]> {
    const measures = await this.listOwn(token, signal);
    return measures.map(({ locationId, reading }) => ({
      locationId,
      name: reading.locationName,
      usAqi: reading.usAqi,
      observedAt: reading.observedAt,
    }));
  }

  /**
   * Public monitors nearest the coordinates, closest first.
   *
   * Costs one 1.5 MB download, so it runs only when the user presses Test, never on a
   * poll. Offline monitors are left out: suggesting one would configure a blank tile.
   */
  async findNearbyPublic(
    query: WeatherQuery,
    limit: number,
    signal: AbortSignal,
  ): Promise<AirGradientLocation[]> {
    const payload = await this.getJson(
      `${AIRGRADIENT_API}/world/locations/measures/current`,
      { kind: 'public' },
      signal,
      { maxBytes: MAX_WORLD_RESPONSE_BYTES, timeoutMs: WORLD_LIST_TIMEOUT_MS },
    );
    if (!Array.isArray(payload)) return [];

    const candidates: AirGradientLocation[] = [];
    for (const entry of payload) {
      const record = asRecord(entry);
      if (!record || record['offline'] === true) continue;
      const latitude = finiteOrNull(record['latitude']);
      const longitude = finiteOrNull(record['longitude']);
      const reading = parseMeasure(record);
      if (latitude === null || longitude === null || !reading) continue;
      const locationId = finiteOrNull(record['locationId']);
      if (locationId === null) continue;
      candidates.push({
        locationId,
        name: stringOrNull(record['publicLocationName']) ?? reading.locationName,
        usAqi: reading.usAqi,
        observedAt: reading.observedAt,
        distanceKm: nmToKm(haversineDistanceNm(query, { latitude, longitude })),
      });
    }
    return candidates
      .sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0))
      .slice(0, Math.max(1, limit));
  }

  private async listOwn(
    token: string,
    signal: AbortSignal,
  ): Promise<Array<{ locationId: number; reading: AirQualityReading }>> {
    const payload = await this.getJson(
      `${AIRGRADIENT_API}/locations/measures/current`,
      { kind: 'token', token },
      signal,
    );
    if (!Array.isArray(payload)) return [];
    const measures: Array<{ locationId: number; reading: AirQualityReading }> = [];
    for (const entry of payload) {
      const locationId = finiteOrNull(asRecord(entry)?.['locationId']);
      const reading = parseMeasure(entry);
      if (locationId !== null && reading) measures.push({ locationId, reading });
    }
    return measures;
  }

  private async getJson(
    path: string,
    access: AirGradientAccess,
    signal: AbortSignal,
    limits: { maxBytes?: number; timeoutMs?: number } = {},
  ): Promise<unknown> {
    // The API takes its token as a query parameter. The URL is therefore never logged
    // here, and the scoped client names only the host in its own errors.
    const url =
      access.kind === 'token' ? `${path}?token=${encodeURIComponent(access.token)}` : path;
    const response = await this.http.request(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      timeoutMs: limits.timeoutMs ?? REQUEST_TIMEOUT_MS,
      maxBytes: limits.maxBytes ?? MAX_RESPONSE_BYTES,
      signal,
    });

    // Without a valid token the API answers 422 ("token: Invalid value"), not 401.
    if (
      access.kind === 'token' &&
      (response.status === 401 || response.status === 403 || response.status === 422)
    ) {
      throw new AppError(
        'AIRGRADIENT_CREDENTIAL_INVALID',
        'AirGradient rejected the API token. Check it in the dashboard’s place settings, under Connectivity.',
        { details: { status: response.status } },
      );
    }
    // An answer, not a fault: there is nothing at that path. Callers name the ID.
    if (response.status === 404) return null;
    if (response.status === 429) {
      throw new AppError(
        'WEATHER_PROVIDER_RATE_LIMITED',
        'AirGradient is rate limiting requests.',
        {
          details: { retryAfterSeconds: parseRetryAfter(response.headers['retry-after']) },
          retryable: true,
        },
      );
    }
    if (!response.ok) {
      throw new AppError(
        'AIRGRADIENT_UNAVAILABLE',
        `AirGradient returned HTTP ${response.status}.`,
        { details: { status: response.status }, retryable: response.status >= 500 },
      );
    }

    try {
      return response.json();
    } catch (cause) {
      throw new AppError('AIRGRADIENT_UNAVAILABLE', 'AirGradient returned malformed JSON.', {
        cause,
        retryable: true,
      });
    }
  }
}

function locationNotFound(locationId: number): AppError {
  return new AppError(
    'AIRGRADIENT_LOCATION_NOT_FOUND',
    `AirGradient location ${locationId} was not found. Test the source to list the ones available.`,
  );
}

/**
 * Reads one AirGradient `Measure`, tolerating every field being absent.
 *
 * PM2.5 prefers `pm02_corrected`, which AirGradient fills once the EPA correction is
 * on for the place, and falls back to the raw reading. Returns null for a record with
 * nothing usable in it, which the caller treats as "no such location".
 */
export function parseMeasure(payload: unknown): AirQualityReading | null {
  const record = asRecord(payload);
  if (!record) return null;

  const pm25 = finiteOrNull(record['pm02_corrected']) ?? finiteOrNull(record['pm02']);
  const reading: AirQualityReading = {
    source: 'airgradient',
    observedAt: isoOrNull(record['timestamp']) ?? new Date().toISOString(),
    usAqi: usAqiFromPm25(pm25),
    pm25,
    pm10: finiteOrNull(record['pm10_corrected']) ?? finiteOrNull(record['pm10']),
    co2Ppm: finiteOrNull(record['rco2_corrected']) ?? finiteOrNull(record['rco2']),
    tvocIndex: finiteOrNull(record['tvocIndex']),
    noxIndex: finiteOrNull(record['noxIndex']),
    locationName: stringOrNull(record['locationName']),
  };

  const hasAny =
    reading.pm25 !== null ||
    reading.pm10 !== null ||
    reading.co2Ppm !== null ||
    reading.tvocIndex !== null;
  return hasAny ? reading : null;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
