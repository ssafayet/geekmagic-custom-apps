import { describe, expect, it } from 'vitest';
import { AppError } from '@gca/shared';
import { describeCondition } from '../src/conditions.js';
import { AirGradientProvider, parseMeasure } from '../src/provider-airgradient.js';
import { localTimeToIso, OpenMeteoProvider } from '../src/provider-open-meteo.js';
import {
  AIR_QUALITY_SAMPLE,
  FORECAST_SAMPLE,
  PUBLIC_MONITOR_SAMPLE,
  signal,
  stubHttp,
} from './helpers.js';

const DHAKA = { latitude: 23.81, longitude: 90.41 };

describe('OpenMeteoProvider', () => {
  it('asks for metric current conditions and today’s range in local time', async () => {
    const { http, urls } = stubHttp([['https://api.open-meteo.com/', { body: FORECAST_SAMPLE }]]);
    await new OpenMeteoProvider(http).fetchConditions(DHAKA, signal);

    const url = new URL(urls[0]!);
    expect(url.pathname).toBe('/v1/forecast');
    expect(url.searchParams.get('latitude')).toBe('23.8100');
    expect(url.searchParams.get('current')).toContain('apparent_temperature');
    expect(url.searchParams.get('current')).toContain('wind_direction_10m');
    expect(url.searchParams.get('daily')).toBe('temperature_2m_max,temperature_2m_min');
    expect(url.searchParams.get('timezone')).toBe('auto');
    // Units are converted locally, so the request never asks for anything but metric.
    expect(url.searchParams.has('temperature_unit')).toBe(false);
  });

  it('parses a live response', async () => {
    const { http } = stubHttp([['https://api.open-meteo.com/', { body: FORECAST_SAMPLE }]]);
    const conditions = await new OpenMeteoProvider(http).fetchConditions(DHAKA, signal);

    expect(conditions).toEqual({
      observedAt: '2026-10-06T03:30:00.000Z',
      temperatureC: 31.4,
      apparentTemperatureC: 36.2,
      relativeHumidityPercent: 58,
      dewPointC: 22.2,
      windSpeedKmh: 4,
      windGustKmh: 19.4,
      windDirectionDegrees: 87,
      weatherCode: 0,
      isDay: true,
      uvIndex: 2.4,
      pressureHpa: 1014.6,
      precipitationMm: 0,
      cloudCoverPercent: 1,
      todayMaxC: 34.9,
      todayMinC: 25.6,
    });
  });

  it('keeps a missing variable as null rather than zero', async () => {
    const current = { ...FORECAST_SAMPLE.current, uv_index: null, relative_humidity_2m: 'n/a' };
    const { http } = stubHttp([
      ['https://api.open-meteo.com/', { body: { ...FORECAST_SAMPLE, current, daily: undefined } }],
    ]);
    const conditions = await new OpenMeteoProvider(http).fetchConditions(DHAKA, signal);

    expect(conditions.uvIndex).toBeNull();
    expect(conditions.relativeHumidityPercent).toBeNull();
    expect(conditions.todayMaxC).toBeNull();
  });

  it('reads air quality from its own host', async () => {
    const { http, urls } = stubHttp([
      ['https://air-quality-api.open-meteo.com/', { body: AIR_QUALITY_SAMPLE }],
    ]);
    const reading = await new OpenMeteoProvider(http).fetchAirQuality(DHAKA, signal);

    expect(new URL(urls[0]!).searchParams.get('current')).toBe('us_aqi,pm2_5,pm10');
    expect(reading).toMatchObject({
      source: 'open-meteo',
      usAqi: 172,
      pm25: 74.3,
      pm10: 83.6,
      co2Ppm: null,
      observedAt: '2026-10-06T03:00:00.000Z',
    });
  });

  it('surfaces the reason Open-Meteo gives for a bad request', async () => {
    const { http } = stubHttp([
      [
        'https://api.open-meteo.com/',
        { status: 400, body: { error: true, reason: 'Latitude must be in range of -90 to 90°.' } },
      ],
    ]);
    const failure = await new OpenMeteoProvider(http)
      .fetchConditions(DHAKA, signal)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).message).toContain('Latitude must be in range');
    // A 400 will not fix itself; retrying it only burns the daily budget.
    expect((failure as AppError).retryable).toBe(false);
  });

  it('reports a rate limit as retryable with its own code', async () => {
    const { http } = stubHttp([
      ['https://api.open-meteo.com/', { status: 429, body: {}, headers: { 'retry-after': '60' } }],
    ]);
    await expect(new OpenMeteoProvider(http).fetchConditions(DHAKA, signal)).rejects.toMatchObject({
      code: 'WEATHER_PROVIDER_RATE_LIMITED',
      retryable: true,
      details: { retryAfterSeconds: 60 },
    });
  });

  it('treats a server error as retryable', async () => {
    const { http } = stubHttp([['https://api.open-meteo.com/', { status: 503, body: 'down' }]]);
    await expect(new OpenMeteoProvider(http).fetchConditions(DHAKA, signal)).rejects.toMatchObject({
      code: 'WEATHER_PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });
});

describe('localTimeToIso', () => {
  it('applies the offset Open-Meteo reports alongside a zoneless time', () => {
    expect(localTimeToIso('2026-10-06T09:30', 21600)).toBe('2026-10-06T03:30:00.000Z');
    expect(localTimeToIso('2026-10-05T23:45', -14400)).toBe('2026-10-06T03:45:00.000Z');
  });
});

describe('describeCondition', () => {
  it('swaps the sun for the moon at night', () => {
    expect(describeCondition(0, true).icon).toBe('clear-day');
    expect(describeCondition(0, false).icon).toBe('clear-night');
    expect(describeCondition(2, false).icon).toBe('partly-cloudy-night');
    // Rain looks the same by night.
    expect(describeCondition(63, false).icon).toBe('rain');
  });

  it('knows code 97, which older copies of the WMO table lack', () => {
    expect(describeCondition(97, true)).toEqual({
      label: 'Heavy thunderstorm',
      icon: 'thunderstorm',
    });
  });

  it('says so for an unknown code instead of guessing a sky', () => {
    expect(describeCondition(42, true)).toEqual({ label: 'Conditions unknown', icon: 'cloudy' });
    expect(describeCondition(null, true).label).toBe('Conditions unknown');
  });
});

describe('AirGradientProvider', () => {
  const own = [
    {
      locationId: 101,
      locationName: 'Living room',
      pm02: 20,
      pm02_corrected: 14.2,
      rco2: 812,
      tvocIndex: 98,
      timestamp: '2026-10-06T03:50:00Z',
    },
    { locationId: 202, locationName: 'Balcony', pm02: 40, timestamp: '2026-10-06T03:50:00Z' },
  ];

  it('passes the token as a query parameter and reads the first monitor by default', async () => {
    const { http, urls } = stubHttp([['https://api.airgradient.com/', { body: own }]]);
    const reading = await new AirGradientProvider(http).fetchReading(
      { kind: 'token', token: 'tok/en+1' },
      null,
      signal,
    );

    expect(urls[0]).toBe(
      'https://api.airgradient.com/public/api/v1/locations/measures/current?token=tok%2Fen%2B1',
    );
    expect(reading).toMatchObject({
      source: 'airgradient',
      locationName: 'Living room',
      co2Ppm: 812,
      tvocIndex: 98,
    });
  });

  it('prefers the EPA-corrected PM2.5 and computes the index from it', async () => {
    const { http } = stubHttp([['https://api.airgradient.com/', { body: own }]]);
    const reading = await new AirGradientProvider(http).fetchReading(
      { kind: 'token', token: 't' },
      101,
      signal,
    );
    expect(reading.pm25).toBe(14.2);
    expect(reading.usAqi).toBe(61);
  });

  it('falls back to the raw PM2.5 when no corrected value is published', async () => {
    const { http } = stubHttp([['https://api.airgradient.com/', { body: own }]]);
    const reading = await new AirGradientProvider(http).fetchReading(
      { kind: 'token', token: 't' },
      202,
      signal,
    );
    expect(reading.pm25).toBe(40);
  });

  it('names a configured location the account does not have', async () => {
    const { http } = stubHttp([['https://api.airgradient.com/', { body: own }]]);
    await expect(
      new AirGradientProvider(http).fetchReading({ kind: 'token', token: 't' }, 999, signal),
    ).rejects.toMatchObject({
      code: 'AIRGRADIENT_LOCATION_NOT_FOUND',
      message: expect.stringContaining('999'),
    });
  });

  it('recognises the 422 the API sends for a bad token as a credential problem', async () => {
    const { http } = stubHttp([
      [
        'https://api.airgradient.com/',
        {
          status: 422,
          body: { errors: [{ location: 'query', param: 'token', msg: 'Invalid value' }] },
        },
      ],
    ]);
    await expect(
      new AirGradientProvider(http).fetchReading({ kind: 'token', token: 'bad' }, null, signal),
    ).rejects.toMatchObject({ code: 'AIRGRADIENT_CREDENTIAL_INVALID', retryable: false });
  });

  it('never echoes the token in an error message', async () => {
    const { http } = stubHttp([['https://api.airgradient.com/', { status: 500, body: 'oops' }]]);
    const failure = (await new AirGradientProvider(http)
      .fetchReading({ kind: 'token', token: 'super-secret-token' }, null, signal)
      .catch((error: unknown) => error)) as AppError;

    expect(failure.code).toBe('AIRGRADIENT_UNAVAILABLE');
    expect(JSON.stringify({ message: failure.message, details: failure.details })).not.toContain(
      'super-secret-token',
    );
  });

  it('reads a public monitor without a token', async () => {
    const { http, urls } = stubHttp([
      ['https://api.airgradient.com/', { body: PUBLIC_MONITOR_SAMPLE }],
    ]);
    const reading = await new AirGradientProvider(http).fetchReading(
      { kind: 'public' },
      178634,
      signal,
    );

    expect(urls[0]).toBe(
      'https://api.airgradient.com/public/api/v1/world/locations/178634/measures/current',
    );
    expect(reading).toMatchObject({ pm25: 120.3, usAqi: 196, co2Ppm: 461, tvocIndex: 119 });
    expect(reading.observedAt).toBe('2026-10-06T03:42:13.000Z');
  });

  it('turns a missing public location into a message naming it', async () => {
    const { http } = stubHttp([['https://api.airgradient.com/', { status: 404, body: {} }]]);
    await expect(
      new AirGradientProvider(http).fetchReading({ kind: 'public' }, 5, signal),
    ).rejects.toMatchObject({
      code: 'AIRGRADIENT_LOCATION_NOT_FOUND',
      message: expect.stringContaining('5'),
    });
  });

  it('suggests the nearest public monitors that are reporting, closest first', async () => {
    const world = [
      { ...PUBLIC_MONITOR_SAMPLE, locationId: 1, latitude: 24.5, longitude: 90.4 },
      { ...PUBLIC_MONITOR_SAMPLE, locationId: 2, latitude: 23.82, longitude: 90.41 },
      { ...PUBLIC_MONITOR_SAMPLE, locationId: 3, latitude: 23.81, longitude: 90.41, offline: true },
      { locationId: 4, latitude: 23.81, longitude: 90.41 },
    ];
    const { http } = stubHttp([['https://api.airgradient.com/', { body: world }]]);
    const nearby = await new AirGradientProvider(http).findNearbyPublic(DHAKA, 5, signal);

    // Offline monitors and ones with no readings would only configure a blank tile.
    expect(nearby.map((entry) => entry.locationId)).toEqual([2, 1]);
    expect(nearby[0]?.distanceKm).toBeCloseTo(1.1, 1);
  });
});

describe('parseMeasure', () => {
  it('returns null for a record with nothing to show', () => {
    expect(parseMeasure({ locationId: 1, wifi: -50 })).toBeNull();
    expect(parseMeasure(null)).toBeNull();
    expect(parseMeasure([])).toBeNull();
  });
});
