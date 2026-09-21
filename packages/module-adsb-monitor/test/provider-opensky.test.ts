import { describe, expect, it, vi } from 'vitest';
import type { ScopedHttpClient, ScopedResponse } from '@gca/module-sdk';
import {
  boundingBox,
  normalizeStateVector,
  openSkyMinimumPollSeconds,
  OpenSkyProvider,
  OPENSKY_DAILY_CREDITS_ANONYMOUS,
  OPENSKY_DAILY_CREDITS_AUTHENTICATED,
} from '../src/provider-opensky.js';

const signal = new AbortController().signal;

/**
 * A real state vector captured from OpenSky over Dhaka: UBG158 on approach.
 * Index order is fixed by the API, and everything is SI.
 */
const UBG158 = [
  '702098',
  'UBG158  ',
  'Bangladesh',
  1790002744,
  1790002745,
  90.3515,
  23.9017,
  381,
  false,
  61.12,
  143.9,
  -2.93,
  null,
  358.14,
  '5571',
  false,
  0,
];

/** BBC606, taxiing: on the ground with no altitude. */
const BBC606 = [
  '7020a5',
  'BBC606  ',
  'Bangladesh',
  1790002733,
  1790002733,
  90.4015,
  23.8509,
  null,
  true,
  1.29,
  53.44,
  null,
  null,
  null,
  '6063',
  false,
  0,
];

function client(
  handler: (
    url: string,
    options?: Record<string, unknown>,
  ) => Partial<ScopedResponse> & { text: string },
): { http: ScopedHttpClient; calls: Array<{ url: string; options?: Record<string, unknown> }> } {
  const calls: Array<{ url: string; options?: Record<string, unknown> }> = [];
  const http: ScopedHttpClient = {
    async request(url, options) {
      calls.push({ url, options: options as Record<string, unknown> });
      const result = handler(url, options as Record<string, unknown>);
      const status = result.status ?? 200;
      return {
        status,
        ok: result.ok ?? (status >= 200 && status < 300),
        headers: result.headers ?? {},
        text: result.text,
        json: <T>() => JSON.parse(result.text) as T,
      };
    },
  };
  return { http, calls };
}

describe('normalizeStateVector', () => {
  it('converts SI units to aviation units', () => {
    const aircraft = normalizeStateVector(UBG158, 1790002745);

    expect(aircraft).toMatchObject({
      hex: '702098',
      callsign: 'UBG158',
      onGround: false,
      squawk: '5571',
      sourceType: 'opensky',
    });
    // 381 m -> 1250 ft, 61.12 m/s -> 119 kt, -2.93 m/s -> -577 fpm.
    expect(aircraft?.altitudeFt).toBe(1250);
    expect(aircraft?.groundSpeedKt).toBe(119);
    expect(aircraft?.verticalRateFpm).toBe(-577);
    expect(aircraft?.trackDegrees).toBeCloseTo(143.9, 5);
  });

  it('never reports metres as feet', () => {
    // The whole point: a 381 m altitude must not surface as "381 ft".
    expect(normalizeStateVector(UBG158, null)?.altitudeFt).not.toBe(381);
  });

  it('marks ground traffic and withholds its altitude', () => {
    const aircraft = normalizeStateVector(BBC606, 1790002745);
    expect(aircraft).toMatchObject({ hex: '7020a5', callsign: 'BBC606', onGround: true });
    expect(aircraft?.altitudeFt).toBeNull();
  });

  it('computes position age from the server clock', () => {
    expect(normalizeStateVector(BBC606, 1790002745)?.positionAgeSeconds).toBe(12);
    expect(normalizeStateVector(UBG158, 1790002745)?.positionAgeSeconds).toBe(1);
  });

  it('leaves registration and type null rather than inventing them', () => {
    const aircraft = normalizeStateVector(UBG158, null);
    expect(aircraft?.registration).toBeNull();
    expect(aircraft?.typeCode).toBeNull();
  });

  it('falls back to geometric altitude when barometric is absent', () => {
    const state = [...UBG158];
    state[7] = null;
    state[13] = 1000;
    expect(normalizeStateVector(state, null)?.altitudeFt).toBe(3281);
  });

  it('rejects vectors with no usable position', () => {
    expect(
      normalizeStateVector([...UBG158.slice(0, 5), null, null, ...UBG158.slice(7)], null),
    ).toBeNull();
    expect(normalizeStateVector(['', 'X', 'C', 1, 1, 10, 10], null)).toBeNull();
    expect(normalizeStateVector('not-an-array', null)).toBeNull();
    // Null Island is a bad record, not a position off West Africa.
    const nullIsland = [...UBG158];
    nullIsland[5] = 0;
    nullIsland[6] = 0;
    expect(normalizeStateVector(nullIsland, null)).toBeNull();
  });

  it('trims the space-padded callsign and drops an empty one', () => {
    expect(normalizeStateVector(UBG158, null)?.callsign).toBe('UBG158');
    const blank = [...UBG158];
    blank[1] = '        ';
    expect(normalizeStateVector(blank, null)?.callsign).toBeNull();
  });
});

describe('boundingBox', () => {
  it('encloses the search radius', () => {
    const box = boundingBox({ latitude: 51.4706, longitude: -0.4619, radiusNm: 25 });
    // 25 NM is 25/60 of a degree of latitude.
    expect(box.latMax - box.latMin).toBeCloseTo((25 / 60) * 2, 5);
    // Longitude spans wider than latitude away from the equator.
    expect(box.lonMax - box.lonMin).toBeGreaterThan(box.latMax - box.latMin);
  });

  it('clamps at the poles instead of exploding', () => {
    const box = boundingBox({ latitude: 89.9, longitude: 0, radiusNm: 250 });
    expect(box.latMax).toBeLessThanOrEqual(90);
    expect(box.lonMin).toBeGreaterThanOrEqual(-180);
    expect(box.lonMax).toBeLessThanOrEqual(180);
  });
});

describe('OpenSkyProvider', () => {
  const payload = JSON.stringify({ time: 1790002745, states: [UBG158, BBC606] });

  it('queries a bounding box and normalizes the states', async () => {
    const { http, calls } = client(() => ({ text: payload }));
    const result = await new OpenSkyProvider(http).fetchNearby(
      { latitude: 51.4706, longitude: -0.4619, radiusNm: 25 },
      signal,
    );

    const url = new URL(calls[0]?.url ?? '');
    expect(url.host).toBe('opensky-network.org');
    expect(url.pathname).toBe('/api/states/all');
    for (const key of ['lamin', 'lomin', 'lamax', 'lomax']) {
      expect(url.searchParams.get(key)).toBeTruthy();
    }

    expect(result.aircraft.map((a) => a.callsign)).toEqual(['UBG158', 'BBC606']);
    expect(result.rawCount).toBe(2);
    expect(result.attribution).toBe('Data: OpenSky Network');
    expect(result.observedAt).toBe('2026-09-21T14:59:05.000Z');
  });

  it('reports the remaining daily budget', async () => {
    const { http } = client(() => ({
      text: payload,
      headers: { 'x-rate-limit-remaining': '398' },
    }));
    const result = await new OpenSkyProvider(http).fetchNearby(
      { latitude: 23, longitude: 90, radiusNm: 25 },
      signal,
    );
    expect(result.remainingCredits).toBe(398);
  });

  it('sends no authorization header when anonymous', async () => {
    const { http, calls } = client(() => ({ text: payload }));
    await new OpenSkyProvider(http).fetchNearby(
      { latitude: 23, longitude: 90, radiusNm: 25 },
      signal,
    );

    const headers = (calls[0]?.options?.['headers'] ?? {}) as Record<string, string>;
    expect(headers['authorization']).toBeUndefined();
  });

  it('exchanges client credentials for a token and reuses it', async () => {
    const { http, calls } = client((url) =>
      url.includes('/token')
        ? { text: JSON.stringify({ access_token: 'tok-123', expires_in: 1800 }) }
        : { text: payload },
    );
    const provider = new OpenSkyProvider(http, { clientId: 'id', clientSecret: 'shh' });

    await provider.fetchNearby({ latitude: 23, longitude: 90, radiusNm: 25 }, signal);
    await provider.fetchNearby({ latitude: 23, longitude: 90, radiusNm: 25 }, signal);

    const tokenCalls = calls.filter((call) => call.url.includes('/token'));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]?.url.startsWith('https://auth.opensky-network.org/')).toBe(true);
    // The secret goes in the form body, never the URL.
    expect(tokenCalls[0]?.url).not.toContain('shh');

    const dataCalls = calls.filter((call) => call.url.includes('/api/states/all'));
    expect(dataCalls).toHaveLength(2);
    for (const call of dataCalls) {
      expect((call.options?.['headers'] as Record<string, string>)['authorization']).toBe(
        'Bearer tok-123',
      );
    }
  });

  it('maps 429 to a rate-limit error naming the budget', async () => {
    const { http } = client(() => ({ status: 429, ok: false, text: '' }));
    const error = await new OpenSkyProvider(http)
      .fetchNearby({ latitude: 23, longitude: 90, radiusNm: 25 }, signal)
      .catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'ADSB_PROVIDER_RATE_LIMITED' });
    expect(String((error as Error).message)).toMatch(/budget/i);
  });

  it('clears a cached token when the API rejects it', async () => {
    let reject = false;
    const { http, calls } = client((url) => {
      if (url.includes('/token'))
        return { text: JSON.stringify({ access_token: 'tok', expires_in: 1800 }) };
      return reject ? { status: 401, ok: false, text: '' } : { text: payload };
    });
    const provider = new OpenSkyProvider(http, { clientId: 'id', clientSecret: 'shh' });

    await provider.fetchNearby({ latitude: 23, longitude: 90, radiusNm: 25 }, signal);
    reject = true;
    await provider
      .fetchNearby({ latitude: 23, longitude: 90, radiusNm: 25 }, signal)
      .catch(() => undefined);
    reject = false;
    await provider.fetchNearby({ latitude: 23, longitude: 90, radiusNm: 25 }, signal);

    // Re-authenticated rather than reusing a token the server refused.
    expect(calls.filter((call) => call.url.includes('/token'))).toHaveLength(2);
  });

  it('rejects malformed JSON without leaking a SyntaxError', async () => {
    const { http } = client(() => ({ text: '{"states": [' }));
    await expect(
      new OpenSkyProvider(http).fetchNearby({ latitude: 23, longitude: 90, radiusNm: 25 }, signal),
    ).rejects.toMatchObject({ code: 'ADSB_PROVIDER_UNAVAILABLE' });
  });

  it('treats an empty sky as a success', async () => {
    const { http } = client(() => ({ text: JSON.stringify({ time: 1790002745, states: null }) }));
    const result = await new OpenSkyProvider(http).fetchNearby(
      { latitude: 23, longitude: 90, radiusNm: 25 },
      signal,
    );
    expect(result.aircraft).toEqual([]);
    expect(result.rawCount).toBe(0);
  });

  it('passes the abort signal through', async () => {
    const request = vi.fn(async () => ({
      status: 200,
      ok: true,
      headers: {},
      text: payload,
      json: <T>() => JSON.parse(payload) as T,
    }));
    const controller = new AbortController();
    await new OpenSkyProvider({ request }).fetchNearby(
      { latitude: 23, longitude: 90, radiusNm: 25 },
      controller.signal,
    );
    expect(request.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
  });
});

describe('openSkyMinimumPollSeconds', () => {
  it('derives a poll interval that lasts a whole day', () => {
    const anonymous = openSkyMinimumPollSeconds(false);
    const authenticated = openSkyMinimumPollSeconds(true);

    expect(86_400 / anonymous).toBeLessThanOrEqual(OPENSKY_DAILY_CREDITS_ANONYMOUS);
    expect(86_400 / authenticated).toBeLessThanOrEqual(OPENSKY_DAILY_CREDITS_AUTHENTICATED);
    expect(authenticated).toBeLessThan(anonymous);
    // A 5s poll must never be considered acceptable for either tier.
    expect(anonymous).toBeGreaterThan(5);
    expect(authenticated).toBeGreaterThan(5);
  });
});
