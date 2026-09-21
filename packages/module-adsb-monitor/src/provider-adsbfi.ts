import { AppError, nowIso } from '@gca/shared';
import type { ScopedHttpClient } from '@gca/module-sdk';
import { normalizeAircraftList } from './normalize.js';
import type { AircraftProvider, AircraftProviderResult, NearbyAircraftQuery } from './types.js';

export const ADSB_FI_HOST = 'https://opendata.adsb.fi';
export const ADSB_FI_ATTRIBUTION = 'Data: adsb.fi';
/** Provider maximum; settings validation keeps requests inside it. */
export const ADSB_FI_MAX_RADIUS_NM = 250;

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * adsb.fi open-data provider.
 *
 * Kept behind `AircraftProvider` so a local readsb receiver or a licensed feed can be
 * swapped in later without touching selection, hysteresis or rendering.
 */
export class AdsbFiProvider implements AircraftProvider {
  readonly id = 'adsb-fi';
  readonly attribution = ADSB_FI_ATTRIBUTION;

  constructor(private readonly http: ScopedHttpClient) {}

  async fetchNearby(
    query: NearbyAircraftQuery,
    signal: AbortSignal,
  ): Promise<AircraftProviderResult> {
    const radius = Math.min(ADSB_FI_MAX_RADIUS_NM, Math.max(1, query.radiusNm));
    // Six decimal places is ~0.1 m; more would only add noise to the request.
    const lat = query.latitude.toFixed(6);
    const lon = query.longitude.toFixed(6);
    const url = `${ADSB_FI_HOST}/api/v3/lat/${lat}/lon/${lon}/dist/${radius}`;

    const response = await this.http.request(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
      signal,
    });

    if (response.status === 429) {
      const retryAfter = parseRetryAfter(response.headers['retry-after']);
      throw new AppError(
        'ADSB_PROVIDER_RATE_LIMITED',
        'The ADS-B provider is rate limiting requests.',
        {
          details: { retryAfterSeconds: retryAfter },
          retryable: true,
        },
      );
    }
    if (!response.ok) {
      throw new AppError(
        'ADSB_PROVIDER_UNAVAILABLE',
        `ADS-B provider returned HTTP ${response.status}.`,
        { details: { status: response.status }, retryable: true },
      );
    }

    let payload: unknown;
    try {
      payload = response.json();
    } catch (cause) {
      throw new AppError('ADSB_PROVIDER_UNAVAILABLE', 'ADS-B provider returned malformed JSON.', {
        cause,
        retryable: true,
      });
    }

    const record = (payload ?? {}) as Record<string, unknown>;
    const rawList = Array.isArray(record['ac']) ? (record['ac'] as unknown[]) : [];
    const aircraft = normalizeAircraftList(rawList);

    return {
      aircraft,
      observedAt: parseObservedAt(record['now']) ?? nowIso(),
      rawCount: rawList.length,
      attribution: this.attribution,
    };
  }
}

/** `Retry-After` is either delta-seconds or an HTTP date; both are honoured. */
export function parseRetryAfter(value: string | undefined): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return null;
}

function parseObservedAt(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  // The field is epoch milliseconds on adsb.fi, but tolerate seconds.
  const ms = value > 1e12 ? value : value * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
