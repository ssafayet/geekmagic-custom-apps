import { describe, expect, it } from 'vitest';
import type { ModuleLogger, ScopedHttpClient, ScopedStateStore } from '@gca/module-sdk';
import { parseRouteResponse, ROUTE_CACHE_KEY, RouteResolver } from '../src/route-lookup.js';

const signal = new AbortController().signal;

const silent: ModuleLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function flightroute(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    response: {
      flightroute: {
        callsign: 'BAW117',
        airline: { name: 'British Airways', icao: 'BAW', iata: 'BA' },
        origin: { iata_code: 'LHR', icao_code: 'EGLL', name: 'London Heathrow Airport' },
        destination: { iata_code: 'JFK', icao_code: 'KJFK', name: 'John F Kennedy' },
        ...overrides,
      },
    },
  });
}

/** An http client that answers per-callsign and records every URL it was given. */
function client(answers: Record<string, { status?: number; text?: string } | 'throw'>): {
  http: ScopedHttpClient;
  urls: string[];
} {
  const urls: string[] = [];
  const http: ScopedHttpClient = {
    async request(url) {
      urls.push(url);
      const callsign = url.split('/').pop() ?? '';
      const answer = answers[callsign] ?? { status: 404, text: '{"response":"unknown callsign"}' };
      if (answer === 'throw') throw new Error('socket hang up');
      const status = answer.status ?? 200;
      const text = answer.text ?? '{}';
      return {
        status,
        ok: status < 300,
        headers: {},
        text,
        json: <T>() => JSON.parse(text) as T,
      };
    },
  };
  return { http, urls };
}

function memoryState(): ScopedStateStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(key: string) {
      return (data.get(key) ?? null) as T | null;
    },
    async set(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
  };
}

describe('parseRouteResponse', () => {
  it('reads the airline and both airports, preferring IATA codes', () => {
    expect(parseRouteResponse(JSON.parse(flightroute()))).toEqual({
      airline: 'British Airways',
      origin: 'LHR',
      destination: 'JFK',
    });
  });

  it('falls back to the ICAO code when no IATA code is published', () => {
    const payload = JSON.parse(
      flightroute({
        origin: { icao_code: 'EGLL' },
        destination: { iata_code: '', icao_code: 'KJFK' },
      }),
    );
    expect(parseRouteResponse(payload)).toMatchObject({ origin: 'EGLL', destination: 'KJFK' });
  });

  it('keeps an operator that has no published route', () => {
    const payload = JSON.parse(flightroute({ origin: null, destination: null }));
    expect(parseRouteResponse(payload)).toEqual({
      airline: 'British Airways',
      origin: null,
      destination: null,
    });
  });

  it('returns null for the unknown-callsign body and for junk', () => {
    expect(parseRouteResponse({ response: 'unknown callsign' })).toBeNull();
    expect(parseRouteResponse(null)).toBeNull();
    expect(parseRouteResponse({ response: { flightroute: {} } })).toBeNull();
    expect(parseRouteResponse('nope')).toBeNull();
  });

  it('rejects an airport code that is not a plausible code', () => {
    const payload = JSON.parse(
      flightroute({ origin: { iata_code: '../../etc', icao_code: 'EGLL' } }),
    );
    expect(parseRouteResponse(payload)).toMatchObject({ origin: 'EGLL' });
  });
});

describe('RouteResolver', () => {
  const at = (iso: string) => () => new Date(iso);

  it('looks a callsign up once and serves the rest from cache', async () => {
    const { http, urls } = client({ BAW117: { text: flightroute() } });
    const state = memoryState();
    const resolver = new RouteResolver(http, state, silent, at('2026-09-22T12:00:00Z'));

    const first = await resolver.resolve(['BAW117'], signal);
    expect(first.get('BAW117')).toMatchObject({ airline: 'British Airways', origin: 'LHR' });

    await resolver.resolve(['BAW117'], signal);
    await resolver.resolve(['BAW117'], signal);
    expect(urls).toEqual(['https://api.adsbdb.com/v0/callsign/BAW117']);
  });

  it('caches a 404 so general aviation does not cost a request every poll', async () => {
    const { http, urls } = client({});
    const resolver = new RouteResolver(http, memoryState(), silent, at('2026-09-22T12:00:00Z'));

    const first = await resolver.resolve(['N172SP'], signal);
    expect(first.get('N172SP')).toBeNull();

    await resolver.resolve(['N172SP'], signal);
    expect(urls).toHaveLength(1);
  });

  it('does not cache a transport failure, so an outage is retried', async () => {
    const { http, urls } = client({ BAW117: 'throw' });
    const resolver = new RouteResolver(http, memoryState(), silent, at('2026-09-22T12:00:00Z'));

    expect((await resolver.resolve(['BAW117'], signal)).has('BAW117')).toBe(false);
    await resolver.resolve(['BAW117'], signal);
    expect(urls).toHaveLength(2);
  });

  it('does not cache a 5xx either', async () => {
    const { http, urls } = client({ BAW117: { status: 503, text: 'nope' } });
    const resolver = new RouteResolver(http, memoryState(), silent, at('2026-09-22T12:00:00Z'));

    await resolver.resolve(['BAW117'], signal);
    await resolver.resolve(['BAW117'], signal);
    expect(urls).toHaveLength(2);
  });

  it('refetches a hit once its day is up', async () => {
    const { http, urls } = client({ BAW117: { text: flightroute() } });
    const state = memoryState();

    const monday = new RouteResolver(http, state, silent, at('2026-09-22T12:00:00Z'));
    await monday.resolve(['BAW117'], signal);
    await monday.persist();

    const wednesday = new RouteResolver(http, state, silent, at('2026-09-24T12:00:00Z'));
    await wednesday.load();
    await wednesday.resolve(['BAW117'], signal);
    expect(urls).toHaveLength(2);
  });

  it('restores the cache across a restart', async () => {
    const { http, urls } = client({ BAW117: { text: flightroute() } });
    const state = memoryState();

    const before = new RouteResolver(http, state, silent, at('2026-09-22T12:00:00Z'));
    await before.resolve(['BAW117'], signal);
    await before.persist();
    expect(state.data.get(ROUTE_CACHE_KEY)).toHaveLength(1);

    const after = new RouteResolver(http, state, silent, at('2026-09-22T12:05:00Z'));
    await after.load();
    const resolved = await after.resolve(['BAW117'], signal);

    expect(resolved.get('BAW117')).toMatchObject({ destination: 'JFK' });
    expect(urls).toHaveLength(1);
  });

  it('caps how many uncached callsigns one poll can look up', async () => {
    const { http, urls } = client({});
    const resolver = new RouteResolver(http, memoryState(), silent, at('2026-09-22T12:00:00Z'));

    await resolver.resolve(['AAA111', 'BBB222', 'CCC333', 'DDD444', 'EEE555'], signal);
    expect(urls).toHaveLength(3);
  });

  it('stops asking after a 429 and resumes once the cooldown passes', async () => {
    const { http, urls } = client({
      AAA111: { status: 429, text: '' },
      BBB222: { text: flightroute() },
    });
    let clock = new Date('2026-09-22T12:00:00Z');
    const resolver = new RouteResolver(http, memoryState(), silent, () => clock);

    // The 429 aborts the batch, so the second callsign is never attempted.
    await resolver.resolve(['AAA111', 'BBB222'], signal);
    expect(urls).toHaveLength(1);

    clock = new Date('2026-09-22T12:01:00Z');
    await resolver.resolve(['BBB222'], signal);
    expect(urls).toHaveLength(1);

    clock = new Date('2026-09-22T12:10:00Z');
    await resolver.resolve(['BBB222'], signal);
    expect(urls).toHaveLength(2);
  });

  it('never puts anything but an uppercase alphanumeric callsign in the URL', async () => {
    const { http, urls } = client({});
    const resolver = new RouteResolver(http, memoryState(), silent, at('2026-09-22T12:00:00Z'));

    await resolver.resolve(['../../v0/aircraft/abc', 'BA 117', 'TOOLONGCALLSIGN', 'AB'], signal);
    expect(urls).toEqual([]);

    await resolver.resolve([' baw117 '], signal);
    expect(urls).toEqual(['https://api.adsbdb.com/v0/callsign/BAW117']);
  });

  it('asks once for a callsign that appears twice in one poll', async () => {
    const { http, urls } = client({ BAW117: { text: flightroute() } });
    const resolver = new RouteResolver(http, memoryState(), silent, at('2026-09-22T12:00:00Z'));

    await resolver.resolve(['BAW117', 'BAW117'], signal);
    expect(urls).toHaveLength(1);
  });

  it('writes nothing when there was nothing to remember', async () => {
    const { http } = client({ BAW117: { text: flightroute() } });
    const state = memoryState();
    const resolver = new RouteResolver(http, state, silent, at('2026-09-22T12:00:00Z'));

    await resolver.persist();
    expect(state.data.has(ROUTE_CACHE_KEY)).toBe(false);
  });
});
