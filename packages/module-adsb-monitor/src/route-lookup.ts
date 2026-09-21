import { ageSeconds } from '@gca/shared';
import type { ModuleLogger, ScopedHttpClient, ScopedStateStore } from '@gca/module-sdk';
import type { FlightRoute } from './types.js';

export const ADSBDB_HOST = 'https://api.adsbdb.com';
export const ADSBDB_ATTRIBUTION = 'adsbdb';

export const ROUTE_CACHE_KEY = 'route-cache';

const REQUEST_TIMEOUT_MS = 6_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

/** A resolved route is a schedule fact; it does not change under a flight in the air. */
const HIT_TTL_SECONDS = 24 * 60 * 60;
/**
 * A miss is nearly always general aviation, which has no schedule and never will.
 * Caching it is what keeps a circling training flight from costing a request per poll.
 */
const MISS_TTL_SECONDS = 6 * 60 * 60;
/** Bounds the persisted cache so a busy sky cannot grow it without limit. */
const MAX_CACHE_ENTRIES = 512;
/** One request per callsign, so cap them: a rotation of ten must not burst on one poll. */
const MAX_LOOKUPS_PER_REFRESH = 3;
/** How long to stop asking after the provider says we are asking too often. */
const RATE_LIMIT_COOLDOWN_SECONDS = 300;

/**
 * Callsigns are used to build a URL path, and they arrive from a remote provider.
 * Anything outside this set is rejected rather than escaped, so no provider record can
 * steer the request at a different path.
 */
const CALLSIGN_PATTERN = /^[A-Z0-9]{3,8}$/;

interface CacheEntry {
  callsign: string;
  /** Null records a confirmed miss, which is cached as deliberately as a hit. */
  route: FlightRoute | null;
  fetchedAt: string;
}

/**
 * Resolves airline and route for a callsign, with a persisted cache.
 *
 * ADS-B carries neither, so this is a second source and an optional one: every failure
 * degrades to "no route" rather than failing the poll. The display already renders
 * without it, and traffic that would push a free API around is the greater risk.
 */
export class RouteResolver {
  #cache = new Map<string, CacheEntry>();
  #rateLimitedUntil: Date | null = null;
  #dirty = false;

  constructor(
    private readonly http: ScopedHttpClient,
    private readonly state: ScopedStateStore,
    private readonly logger: ModuleLogger,
    private readonly now: () => Date,
  ) {}

  async load(): Promise<void> {
    const stored = await this.state.get<CacheEntry[]>(ROUTE_CACHE_KEY);
    if (!Array.isArray(stored)) return;
    for (const entry of stored) {
      if (!entry || typeof entry.callsign !== 'string' || typeof entry.fetchedAt !== 'string') {
        continue;
      }
      this.#cache.set(entry.callsign, {
        callsign: entry.callsign,
        route: entry.route ?? null,
        fetchedAt: entry.fetchedAt,
      });
    }
  }

  async persist(): Promise<void> {
    if (!this.#dirty) return;
    await this.state.set(ROUTE_CACHE_KEY, [...this.#cache.values()]);
    this.#dirty = false;
  }

  /**
   * Routes for the given callsigns: cached ones immediately, a bounded number of
   * uncached ones fetched. Callsigns with no answer are simply absent from the map.
   */
  async resolve(
    callsigns: readonly string[],
    signal: AbortSignal,
  ): Promise<Map<string, FlightRoute | null>> {
    const now = this.now();
    const resolved = new Map<string, FlightRoute | null>();
    const pending: string[] = [];

    for (const raw of callsigns) {
      const callsign = raw.trim().toUpperCase();
      if (!CALLSIGN_PATTERN.test(callsign)) continue;
      if (resolved.has(callsign) || pending.includes(callsign)) continue;

      const entry = this.#cache.get(callsign);
      if (entry && !isExpired(entry, now)) {
        resolved.set(callsign, entry.route);
        continue;
      }
      pending.push(callsign);
    }

    if (this.cooling(now)) return resolved;

    for (const callsign of pending.slice(0, MAX_LOOKUPS_PER_REFRESH)) {
      if (signal.aborted) break;
      const outcome = await this.fetchOne(callsign, signal);
      if (outcome.kind === 'error') continue;
      if (outcome.kind === 'rate-limited') {
        this.#rateLimitedUntil = new Date(
          this.now().getTime() + RATE_LIMIT_COOLDOWN_SECONDS * 1000,
        );
        this.logger.warn(
          { cooldownSeconds: RATE_LIMIT_COOLDOWN_SECONDS },
          'Route lookups rate limited; pausing them',
        );
        break;
      }
      this.remember(callsign, outcome.route);
      resolved.set(callsign, outcome.route);
    }

    return resolved;
  }

  private cooling(now: Date): boolean {
    if (this.#rateLimitedUntil === null) return false;
    if (this.#rateLimitedUntil.getTime() > now.getTime()) return true;
    this.#rateLimitedUntil = null;
    return false;
  }

  private remember(callsign: string, route: FlightRoute | null): void {
    this.#cache.delete(callsign);
    // The injected clock, not the wall clock: expiry is measured against the same one.
    this.#cache.set(callsign, { callsign, route, fetchedAt: this.now().toISOString() });
    // Map iteration is insertion-ordered, so the oldest write is the first key.
    while (this.#cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.#cache.keys().next();
      if (oldest.done) break;
      this.#cache.delete(oldest.value);
    }
    this.#dirty = true;
  }

  /**
   * One lookup. A 404 is an answer — this callsign has no published route — and is
   * cached. A transport failure is not an answer, so it is dropped and retried later
   * rather than poisoning the cache for the miss TTL.
   */
  private async fetchOne(
    callsign: string,
    signal: AbortSignal,
  ): Promise<
    { kind: 'resolved'; route: FlightRoute | null } | { kind: 'rate-limited' } | { kind: 'error' }
  > {
    try {
      const response = await this.http.request(`${ADSBDB_HOST}/v0/callsign/${callsign}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxBytes: MAX_RESPONSE_BYTES,
        signal,
      });

      if (response.status === 404) return { kind: 'resolved', route: null };
      if (response.status === 429) return { kind: 'rate-limited' };
      if (!response.ok) {
        this.logger.debug({ callsign, status: response.status }, 'Route lookup failed');
        return { kind: 'error' };
      }
      return { kind: 'resolved', route: parseRouteResponse(response.json()) };
    } catch (cause) {
      this.logger.debug(
        { callsign, error: cause instanceof Error ? cause.message : String(cause) },
        'Route lookup failed',
      );
      return { kind: 'error' };
    }
  }
}

function isExpired(entry: CacheEntry, now: Date): boolean {
  const age = ageSeconds(entry.fetchedAt, now);
  return age > (entry.route === null ? MISS_TTL_SECONDS : HIT_TTL_SECONDS);
}

/**
 * Reads the adsbdb `flightroute` shape, tolerating every field being missing.
 *
 * Returns null when nothing usable came back, which the caller caches as a miss: an
 * answer of "no route for this callsign" is worth remembering.
 */
export function parseRouteResponse(payload: unknown): FlightRoute | null {
  const response = asRecord(payload)?.['response'];
  const flightroute = asRecord(response)?.['flightroute'];
  const record = asRecord(flightroute);
  if (!record) return null;

  const route: FlightRoute = {
    airline: cleanName(asRecord(record['airline'])?.['name']),
    origin: airportCode(record['origin']),
    destination: airportCode(record['destination']),
  };
  // Nothing worth showing is still a definite answer for this callsign.
  if (route.airline === null && route.origin === null && route.destination === null) return null;
  return route;
}

/** IATA is what a passenger reads on a boarding pass, and it is three characters. */
function airportCode(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  const iata = cleanCode(record['iata_code']);
  if (iata) return iata;
  return cleanCode(record['icao_code']);
}

function cleanCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toUpperCase();
  return /^[A-Z0-9]{3,4}$/.test(trimmed) ? trimmed : null;
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // Collapse whitespace: the panel has one short line for this and no room for runs.
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.length > 0 ? trimmed.slice(0, 40) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
