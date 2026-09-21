import { describe, expect, it, vi } from 'vitest';
import type { ScopedHttpClient, ScopedResponse } from '@gca/module-sdk';
import { AdsbFiProvider, parseRetryAfter } from '../src/provider-adsbfi.js';

function client(response: Partial<ScopedResponse> & { text: string }): {
  http: ScopedHttpClient;
  urls: string[];
} {
  const urls: string[] = [];
  const http: ScopedHttpClient = {
    async request(url) {
      urls.push(url);
      const text = response.text;
      return {
        status: response.status ?? 200,
        ok: response.ok ?? (response.status ?? 200) < 300,
        headers: response.headers ?? {},
        text,
        json: <T>() => JSON.parse(text) as T,
      };
    },
  };
  return { http, urls };
}

const signal = new AbortController().signal;

describe('AdsbFiProvider', () => {
  it('builds the documented v3 URL with six-decimal coordinates', async () => {
    const { http, urls } = client({ text: JSON.stringify({ ac: [], now: 1_790_000_000_000 }) });
    await new AdsbFiProvider(http).fetchNearby(
      { latitude: 51.4775123456, longitude: -0.4614987654, radiusNm: 25 },
      signal,
    );

    expect(urls[0]).toBe('https://opendata.adsb.fi/api/v3/lat/51.477512/lon/-0.461499/dist/25');
  });

  it('clamps the radius to the provider maximum', async () => {
    const { http, urls } = client({ text: JSON.stringify({ ac: [] }) });
    await new AdsbFiProvider(http).fetchNearby(
      { latitude: 0, longitude: 1, radiusNm: 900 },
      signal,
    );
    expect(urls[0]).toContain('/dist/250');
  });

  it('treats an empty ac array as a successful, healthy response', async () => {
    const { http } = client({ text: JSON.stringify({ ac: [], now: 1_790_000_000_000 }) });
    const result = await new AdsbFiProvider(http).fetchNearby(
      { latitude: 51, longitude: 0, radiusNm: 10 },
      signal,
    );

    expect(result.aircraft).toEqual([]);
    expect(result.rawCount).toBe(0);
    expect(result.attribution).toBe('Data: adsb.fi');
  });

  it('normalizes the aircraft array and reports the raw count', async () => {
    const { http } = client({
      text: JSON.stringify({
        now: 1_790_000_000_000,
        ac: [
          { hex: 'abc123', flight: 'BAW117 ', lat: 51.5, lon: -0.4, alt_baro: 10000 },
          { hex: 'bad', lat: 999, lon: 0 },
        ],
      }),
    });

    const result = await new AdsbFiProvider(http).fetchNearby(
      { latitude: 51, longitude: 0, radiusNm: 10 },
      signal,
    );

    expect(result.rawCount).toBe(2);
    expect(result.aircraft).toHaveLength(1);
    expect(result.aircraft[0]?.callsign).toBe('BAW117');
    expect(result.observedAt).toBe('2026-09-21T14:13:20.000Z');
  });

  it('maps HTTP 429 to ADSB_PROVIDER_RATE_LIMITED and surfaces Retry-After', async () => {
    const { http } = client({ status: 429, ok: false, headers: { 'retry-after': '30' }, text: '' });

    await expect(
      new AdsbFiProvider(http).fetchNearby({ latitude: 51, longitude: 0, radiusNm: 10 }, signal),
    ).rejects.toMatchObject({
      code: 'ADSB_PROVIDER_RATE_LIMITED',
      details: { retryAfterSeconds: 30 },
    });
  });

  it('maps 5xx to ADSB_PROVIDER_UNAVAILABLE and marks it retryable', async () => {
    const { http } = client({ status: 503, ok: false, text: 'upstream down' });

    const error = await new AdsbFiProvider(http)
      .fetchNearby({ latitude: 51, longitude: 0, radiusNm: 10 }, signal)
      .catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'ADSB_PROVIDER_UNAVAILABLE', retryable: true });
    // The upstream body must not be echoed into a user-facing message.
    expect(String((error as Error).message)).not.toContain('upstream down');
  });

  it('rejects malformed JSON without throwing a raw SyntaxError', async () => {
    const { http } = client({ text: '{"ac": [' });

    await expect(
      new AdsbFiProvider(http).fetchNearby({ latitude: 51, longitude: 0, radiusNm: 10 }, signal),
    ).rejects.toMatchObject({ code: 'ADSB_PROVIDER_UNAVAILABLE' });
  });

  it('tolerates a response with no ac field at all', async () => {
    const { http } = client({ text: JSON.stringify({ msg: 'No data' }) });
    const result = await new AdsbFiProvider(http).fetchNearby(
      { latitude: 51, longitude: 0, radiusNm: 10 },
      signal,
    );
    expect(result.aircraft).toEqual([]);
  });

  it('passes the caller abort signal through to the HTTP client', async () => {
    const request = vi.fn(async () => ({
      status: 200,
      ok: true,
      headers: {},
      text: '{"ac":[]}',
      json: <T>() => ({ ac: [] }) as T,
    }));
    const controller = new AbortController();

    await new AdsbFiProvider({ request }).fetchNearby(
      { latitude: 51, longitude: 0, radiusNm: 10 },
      controller.signal,
    );

    expect(request.mock.calls[0]?.[1]).toMatchObject({
      signal: controller.signal,
      timeoutMs: 8_000,
    });
  });
});

describe('parseRetryAfter', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfter('30')).toBe(30);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('reads an HTTP date', () => {
    const future = new Date(Date.now() + 45_000).toUTCString();
    const seconds = parseRetryAfter(future);
    expect(seconds).toBeGreaterThanOrEqual(43);
    expect(seconds).toBeLessThanOrEqual(46);
  });

  it('returns null for missing or nonsense values', () => {
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });
});
