import { AppError } from '@gca/shared';
import type { ScopedHttpClient } from '@gca/module-sdk';
import { asRecord, finiteOrNull, parseRetryAfter } from './parse.js';
import type { AirQualityReading, CurrentConditions, WeatherQuery } from './types.js';

export const OPEN_METEO_FORECAST_HOST = 'https://api.open-meteo.com';
export const OPEN_METEO_AIR_QUALITY_HOST = 'https://air-quality-api.open-meteo.com';
/** CC BY 4.0 requires the credit; it rides in the footer of every frame that used it. */
export const OPEN_METEO_ATTRIBUTION = 'Open-Meteo';

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

const CURRENT_VARIABLES = [
  'temperature_2m',
  'apparent_temperature',
  'relative_humidity_2m',
  'dew_point_2m',
  'wind_speed_10m',
  'wind_gusts_10m',
  'wind_direction_10m',
  'weather_code',
  'is_day',
  'uv_index',
  'pressure_msl',
  'precipitation',
  'cloud_cover',
].join(',');

/**
 * Open-Meteo forecast and air-quality APIs. Keyless; free for non-commercial use under
 * 10,000 calls a day, which a ten-minute poll uses about 3% of.
 *
 * Always asks for metric: the frames convert, so the snapshot has one meaning.
 */
export class OpenMeteoProvider {
  readonly attribution = OPEN_METEO_ATTRIBUTION;

  constructor(private readonly http: ScopedHttpClient) {}

  async fetchConditions(query: WeatherQuery, signal: AbortSignal): Promise<CurrentConditions> {
    const params = new URLSearchParams({
      ...coordinates(query),
      current: CURRENT_VARIABLES,
      daily: 'temperature_2m_max,temperature_2m_min',
      // `auto` makes "today" the observer's day, which is what high and low mean.
      timezone: 'auto',
      forecast_days: '1',
    });
    const payload = await this.getJson(`${OPEN_METEO_FORECAST_HOST}/v1/forecast?${params}`, signal);
    return parseForecastResponse(payload);
  }

  async fetchAirQuality(query: WeatherQuery, signal: AbortSignal): Promise<AirQualityReading> {
    const params = new URLSearchParams({
      ...coordinates(query),
      current: 'us_aqi,pm2_5,pm10',
      timezone: 'auto',
    });
    const payload = await this.getJson(
      `${OPEN_METEO_AIR_QUALITY_HOST}/v1/air-quality?${params}`,
      signal,
    );
    return parseAirQualityResponse(payload);
  }

  private async getJson(url: string, signal: AbortSignal): Promise<unknown> {
    const response = await this.http.request(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
      signal,
    });

    if (response.status === 429) {
      throw new AppError('WEATHER_PROVIDER_RATE_LIMITED', 'Open-Meteo is rate limiting requests.', {
        details: { retryAfterSeconds: parseRetryAfter(response.headers['retry-after']) },
        retryable: true,
      });
    }

    let payload: unknown;
    try {
      payload = response.json();
    } catch (cause) {
      throw new AppError('WEATHER_PROVIDER_UNAVAILABLE', 'Open-Meteo returned malformed JSON.', {
        cause,
        retryable: true,
      });
    }

    if (!response.ok) {
      // A 400 carries `{ error: true, reason }`, which is worth more than the status.
      const reason = asRecord(payload)?.['reason'];
      throw new AppError(
        'WEATHER_PROVIDER_UNAVAILABLE',
        typeof reason === 'string' && reason.length > 0
          ? `Open-Meteo: ${reason.slice(0, 160)}`
          : `Open-Meteo returned HTTP ${response.status}.`,
        { details: { status: response.status }, retryable: response.status >= 500 },
      );
    }
    return payload;
  }
}

function coordinates(query: WeatherQuery): { latitude: string; longitude: string } {
  // Four decimals is ~11 m, far finer than the model grid the answer snaps to.
  return { latitude: query.latitude.toFixed(4), longitude: query.longitude.toFixed(4) };
}

export function parseForecastResponse(payload: unknown): CurrentConditions {
  const record = asRecord(payload);
  const current = asRecord(record?.['current']);
  if (!record || !current) {
    throw new AppError(
      'WEATHER_PROVIDER_UNAVAILABLE',
      'Open-Meteo returned no current conditions.',
      {
        retryable: true,
      },
    );
  }
  const daily = asRecord(record['daily']);
  const isDay = finiteOrNull(current['is_day']);

  return {
    observedAt: localTimeToIso(current['time'], record['utc_offset_seconds']),
    temperatureC: finiteOrNull(current['temperature_2m']),
    apparentTemperatureC: finiteOrNull(current['apparent_temperature']),
    relativeHumidityPercent: finiteOrNull(current['relative_humidity_2m']),
    dewPointC: finiteOrNull(current['dew_point_2m']),
    windSpeedKmh: finiteOrNull(current['wind_speed_10m']),
    windGustKmh: finiteOrNull(current['wind_gusts_10m']),
    windDirectionDegrees: finiteOrNull(current['wind_direction_10m']),
    weatherCode: finiteOrNull(current['weather_code']),
    isDay: isDay === null ? null : isDay === 1,
    uvIndex: finiteOrNull(current['uv_index']),
    pressureHpa: finiteOrNull(current['pressure_msl']),
    precipitationMm: finiteOrNull(current['precipitation']),
    cloudCoverPercent: finiteOrNull(current['cloud_cover']),
    todayMaxC: firstOf(daily?.['temperature_2m_max']),
    todayMinC: firstOf(daily?.['temperature_2m_min']),
  };
}

export function parseAirQualityResponse(payload: unknown): AirQualityReading {
  const record = asRecord(payload);
  const current = asRecord(record?.['current']);
  if (!record || !current) {
    throw new AppError('WEATHER_PROVIDER_UNAVAILABLE', 'Open-Meteo returned no air quality.', {
      retryable: true,
    });
  }
  return {
    source: 'open-meteo',
    observedAt: localTimeToIso(current['time'], record['utc_offset_seconds']),
    usAqi: roundedOrNull(current['us_aqi']),
    pm25: finiteOrNull(current['pm2_5']),
    pm10: finiteOrNull(current['pm10']),
    co2Ppm: null,
    tvocIndex: null,
    noxIndex: null,
    locationName: null,
  };
}

/**
 * Open-Meteo reports `current.time` as local wall-clock time with no zone, alongside
 * the offset it used. Falls back to now rather than failing the whole reading.
 */
export function localTimeToIso(time: unknown, offsetSeconds: unknown): string {
  const offset =
    typeof offsetSeconds === 'number' && Number.isFinite(offsetSeconds) ? offsetSeconds : 0;
  if (typeof time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(time)) {
    return new Date().toISOString();
  }
  const asUtc = Date.parse(`${time}Z`);
  if (!Number.isFinite(asUtc)) return new Date().toISOString();
  return new Date(asUtc - offset * 1000).toISOString();
}

function firstOf(value: unknown): number | null {
  return Array.isArray(value) ? finiteOrNull(value[0]) : null;
}

function roundedOrNull(value: unknown): number | null {
  const number = finiteOrNull(value);
  return number === null ? null : Math.round(number);
}
