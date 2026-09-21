import { AppError, nowIso } from '@gca/shared';
import type { ScopedHttpClient } from '@gca/module-sdk';
import type {
  Aircraft,
  AircraftProvider,
  AircraftProviderResult,
  NearbyAircraftQuery,
} from './types.js';

export const OPENSKY_HOST = 'https://opensky-network.org';
export const OPENSKY_AUTH_HOST = 'https://auth.opensky-network.org';
export const OPENSKY_ATTRIBUTION = 'Data: OpenSky Network';

/**
 * OpenSky reports SI units; the rest of this module works in aviation units.
 * Getting these wrong turns 381 m into "381 ft", so they are named and used once.
 */
const FEET_PER_METRE = 3.280839895;
const KNOTS_PER_METRE_PER_SECOND = 1.943844492;
const FEET_PER_MINUTE_PER_METRE_PER_SECOND = 196.8503937;

/** One degree of latitude is 60 NM; longitude shrinks by cos(latitude). */
const NM_PER_DEGREE_LATITUDE = 60;

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Daily request budgets, which are the binding constraint on this provider.
 *
 * OpenSky bills per request and resets daily, so the poll interval — not the rate
 * limit per second — is what decides whether a deployment runs out by lunchtime.
 */
export const OPENSKY_DAILY_CREDITS_ANONYMOUS = 400;
export const OPENSKY_DAILY_CREDITS_AUTHENTICATED = 4_000;

/** Slowest safe poll for a whole day within budget, with a little headroom. */
export function openSkyMinimumPollSeconds(authenticated: boolean): number {
  const credits = authenticated
    ? OPENSKY_DAILY_CREDITS_AUTHENTICATED
    : OPENSKY_DAILY_CREDITS_ANONYMOUS;
  return Math.ceil((86_400 / credits) * 1.1);
}

export interface OpenSkyCredentials {
  clientId: string;
  clientSecret: string;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

/**
 * OpenSky Network state-vector provider.
 *
 * Chosen when community ADS-B aggregators have no feeders in a region — over much of
 * South Asia, for instance, adsb.fi and adsb.lol return nothing while OpenSky
 * returns traffic.
 *
 * Two things differ from the aggregators and are handled here: everything arrives in
 * SI units, and there is no registration or aircraft-type field, so those stay null
 * rather than being invented.
 */
export class OpenSkyProvider implements AircraftProvider {
  readonly id = 'opensky';
  readonly attribution = OPENSKY_ATTRIBUTION;

  #token: CachedToken | null = null;

  constructor(
    private readonly http: ScopedHttpClient,
    private readonly credentials: OpenSkyCredentials | null = null,
  ) {}

  get authenticated(): boolean {
    return this.credentials !== null;
  }

  async fetchNearby(
    query: NearbyAircraftQuery,
    signal: AbortSignal,
  ): Promise<AircraftProviderResult> {
    const box = boundingBox(query);
    const search = new URLSearchParams({
      lamin: box.latMin.toFixed(4),
      lomin: box.lonMin.toFixed(4),
      lamax: box.latMax.toFixed(4),
      lomax: box.lonMax.toFixed(4),
    });

    const headers: Record<string, string> = { accept: 'application/json' };
    const token = await this.accessToken(signal);
    if (token) headers['authorization'] = `Bearer ${token}`;

    const response = await this.http.request(
      `${OPENSKY_HOST}/api/states/all?${search.toString()}`,
      {
        method: 'GET',
        headers,
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxBytes: MAX_RESPONSE_BYTES,
        signal,
      },
    );

    if (response.status === 401 || response.status === 403) {
      // A cached token may simply have expired; drop it so the next call re-authenticates.
      this.#token = null;
      throw new AppError(
        'ADSB_PROVIDER_UNAVAILABLE',
        this.credentials
          ? 'OpenSky rejected these credentials. Check the client ID and secret.'
          : 'OpenSky refused an anonymous request. Add API credentials in module settings.',
      );
    }
    if (response.status === 429) {
      throw new AppError(
        'ADSB_PROVIDER_RATE_LIMITED',
        this.credentials
          ? 'The OpenSky daily request budget is exhausted. Increase the poll interval.'
          : 'The anonymous OpenSky budget is exhausted. Add credentials or increase the poll interval.',
        { retryable: true },
      );
    }
    if (!response.ok) {
      throw new AppError('ADSB_PROVIDER_UNAVAILABLE', `OpenSky returned HTTP ${response.status}.`, {
        details: { status: response.status },
        retryable: true,
      });
    }

    let payload: { time?: unknown; states?: unknown };
    try {
      payload = response.json();
    } catch (cause) {
      throw new AppError('ADSB_PROVIDER_UNAVAILABLE', 'OpenSky returned malformed JSON.', {
        cause,
        retryable: true,
      });
    }

    const states = Array.isArray(payload.states) ? payload.states : [];
    const serverTime = typeof payload.time === 'number' ? payload.time : null;

    const aircraft: Aircraft[] = [];
    const seen = new Set<string>();
    for (const state of states) {
      const parsed = normalizeStateVector(state, serverTime);
      if (!parsed || seen.has(parsed.hex)) continue;
      seen.add(parsed.hex);
      aircraft.push(parsed);
    }

    return {
      aircraft,
      observedAt: serverTime ? new Date(serverTime * 1000).toISOString() : nowIso(),
      rawCount: states.length,
      attribution: this.attribution,
      // Surfaced so the module can warn before the budget runs out.
      remainingCredits: readRemaining(response.headers),
    };
  }

  /** OAuth2 client-credentials token, cached until shortly before it expires. */
  private async accessToken(signal: AbortSignal): Promise<string | null> {
    if (!this.credentials) return null;
    if (this.#token && this.#token.expiresAt > Date.now()) return this.#token.value;

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
    }).toString();

    const response = await this.http.request(
      `${OPENSKY_AUTH_HOST}/auth/realms/opensky-network/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body,
        timeoutMs: REQUEST_TIMEOUT_MS,
        signal,
      },
    );

    if (!response.ok) {
      throw new AppError(
        'ADSB_PROVIDER_UNAVAILABLE',
        `OpenSky authentication failed with HTTP ${response.status}.`,
        { details: { status: response.status } },
      );
    }

    let token: { access_token?: unknown; expires_in?: unknown };
    try {
      token = response.json();
    } catch (cause) {
      throw new AppError('ADSB_PROVIDER_UNAVAILABLE', 'OpenSky returned a malformed token.', {
        cause,
      });
    }

    if (typeof token.access_token !== 'string' || token.access_token.length === 0) {
      throw new AppError('ADSB_PROVIDER_UNAVAILABLE', 'OpenSky returned no access token.');
    }

    const lifetime =
      typeof token.expires_in === 'number' && token.expires_in > 0 ? token.expires_in : 1800;
    // Refresh a minute early so a request never races the expiry.
    this.#token = {
      value: token.access_token,
      expiresAt: Date.now() + Math.max(30, lifetime - 60) * 1000,
    };
    return this.#token.value;
  }
}

export interface BoundingBox {
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
}

/**
 * Square bounding box covering the search radius.
 *
 * OpenSky has no radius query, so the box is filtered down to a true circle later by
 * the selection step; the box only needs to enclose it.
 */
export function boundingBox(query: NearbyAircraftQuery): BoundingBox {
  const latDelta = query.radiusNm / NM_PER_DEGREE_LATITUDE;
  // Guard the cosine near the poles so the box cannot explode to infinity.
  const cosLat = Math.max(0.01, Math.cos((query.latitude * Math.PI) / 180));
  const lonDelta = Math.min(180, query.radiusNm / (NM_PER_DEGREE_LATITUDE * cosLat));

  return {
    latMin: Math.max(-90, query.latitude - latDelta),
    latMax: Math.min(90, query.latitude + latDelta),
    lonMin: Math.max(-180, query.longitude - lonDelta),
    lonMax: Math.min(180, query.longitude + lonDelta),
  };
}

/**
 * Maps one OpenSky state vector to the module's normalized shape.
 *
 * The vector is a positional array; the indices are fixed by the API and named here
 * so the unit conversions are auditable.
 */
export function normalizeStateVector(state: unknown, serverTime: number | null): Aircraft | null {
  if (!Array.isArray(state)) return null;

  const hex = typeof state[0] === 'string' ? state[0].trim().toLowerCase() : null;
  if (!hex) return null;

  const longitude = finite(state[5]);
  const latitude = finite(state[6]);
  if (latitude === null || longitude === null) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  if (latitude === 0 && longitude === 0) return null;

  const onGround = state[8] === true;
  const baroAltitudeM = finite(state[7]);
  const geoAltitudeM = finite(state[13]);
  const altitudeM = baroAltitudeM ?? geoAltitudeM;

  const velocityMs = finite(state[9]);
  const verticalRateMs = finite(state[11]);

  const timePosition = finite(state[3]) ?? finite(state[4]);
  const positionAgeSeconds =
    serverTime !== null && timePosition !== null
      ? Math.max(0, Math.round(serverTime - timePosition))
      : null;

  const callsign = typeof state[1] === 'string' ? state[1].trim().toUpperCase() : '';

  return {
    hex,
    callsign: callsign.length > 0 ? callsign : null,
    // OpenSky state vectors carry no registration or aircraft type. Leaving these
    // null makes the display say "Unknown" rather than invent an aircraft.
    registration: null,
    typeCode: null,
    latitude,
    longitude,
    altitudeFt: onGround || altitudeM === null ? null : Math.round(altitudeM * FEET_PER_METRE),
    onGround,
    groundSpeedKt: velocityMs === null ? null : Math.round(velocityMs * KNOTS_PER_METRE_PER_SECOND),
    trackDegrees: normalizeTrack(finite(state[10])),
    verticalRateFpm:
      verticalRateMs === null
        ? null
        : Math.round(verticalRateMs * FEET_PER_MINUTE_PER_METRE_PER_SECOND),
    squawk: typeof state[14] === 'string' && state[14].trim() !== '' ? state[14].trim() : null,
    emergency: null,
    positionAgeSeconds,
    sourceType: 'opensky',
  };
}

function normalizeTrack(value: number | null): number | null {
  if (value === null) return null;
  if (value >= 0 && value < 360) return value;
  return ((value % 360) + 360) % 360;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readRemaining(headers: Record<string, string>): number | null {
  const raw = headers['x-rate-limit-remaining'];
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
