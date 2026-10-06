import type { ModuleContext, ScopedHttpClient, ScopedResponse } from '@gca/module-sdk';
import { WEATHER_DEFAULT_SETTINGS, type WeatherSettings } from '../src/settings.js';

export interface StubResponse {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

/**
 * HTTP stub that answers by URL prefix, in order. A request nothing matches fails the
 * test loudly instead of hanging or hitting the network.
 */
export function stubHttp(routes: Array<[prefix: string, response: StubResponse | Error]>): {
  http: ScopedHttpClient;
  urls: string[];
} {
  const urls: string[] = [];
  const http: ScopedHttpClient = {
    async request(url) {
      urls.push(url);
      const match = routes.find(([prefix]) => url.startsWith(prefix));
      if (!match) throw new Error(`Unexpected request: ${url}`);
      const response = match[1];
      if (response instanceof Error) throw response;
      const text =
        typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
      const status = response.status ?? 200;
      return {
        status,
        ok: status >= 200 && status < 300,
        headers: response.headers ?? {},
        text,
        json: <T>() => JSON.parse(text) as T,
      } satisfies ScopedResponse;
    },
  };
  return { http, urls };
}

export const signal = new AbortController().signal;

export const NOW = new Date('2026-10-06T03:52:00Z');

export const DHAKA: Partial<WeatherSettings> = {
  locationLabel: 'Dhaka',
  latitude: 23.81,
  longitude: 90.41,
};

export function settingsWith(overrides: Partial<WeatherSettings> = {}): WeatherSettings {
  return { ...WEATHER_DEFAULT_SETTINGS, ...DHAKA, ...overrides };
}

export function moduleContext(
  http: ScopedHttpClient,
  settings: WeatherSettings,
  options: { secrets?: Record<string, string>; now?: () => Date } = {},
): ModuleContext<WeatherSettings> {
  const secrets = options.secrets ?? {};
  const noop = () => undefined;
  return {
    instanceId: 'instance-1',
    moduleId: 'weather',
    instanceName: 'Weather',
    settings,
    logger: { debug: noop, info: noop, warn: noop, error: noop },
    http,
    secrets: {
      get: async (key) => secrets[key] ?? null,
      has: async (key) => key in secrets,
    },
    state: { get: async () => null, set: async () => undefined, delete: async () => undefined },
    events: {
      requestDisplayRefresh: noop,
      requestAttention: noop,
      releaseAttention: noop,
      reportHealth: noop,
    },
    now: options.now ?? (() => NOW),
    host: {},
  };
}

/** Live responses captured on 2026-10-06 for Dhaka, trimmed to what the parsers read. */
export const FORECAST_SAMPLE = {
  latitude: 23.796133,
  longitude: 90.38055,
  utc_offset_seconds: 21600,
  timezone: 'Asia/Dhaka',
  current: {
    time: '2026-10-06T09:30',
    interval: 900,
    temperature_2m: 31.4,
    apparent_temperature: 36.2,
    relative_humidity_2m: 58,
    wind_speed_10m: 4.0,
    wind_direction_10m: 87,
    wind_gusts_10m: 19.4,
    weather_code: 0,
    is_day: 1,
    uv_index: 2.4,
    pressure_msl: 1014.6,
    precipitation: 0.0,
    cloud_cover: 1,
    dew_point_2m: 22.2,
  },
  daily: {
    time: ['2026-10-06'],
    temperature_2m_max: [34.9],
    temperature_2m_min: [25.6],
  },
};

export const AIR_QUALITY_SAMPLE = {
  latitude: 23.800003,
  longitude: 90.399994,
  utc_offset_seconds: 21600,
  current: { time: '2026-10-06T09:00', interval: 3600, us_aqi: 172, pm2_5: 74.3, pm10: 83.6 },
};

export const PUBLIC_MONITOR_SAMPLE = {
  locationId: 178634,
  locationName: 'RAJUK Uttara Apartment Project, Sector - 18, Uttara',
  publicLocationName: 'RAJUK Uttara Apartment Project, Sector - 18, Uttara',
  latitude: 23.856237,
  longitude: 90.356837,
  offline: false,
  pm01: 69.0,
  pm02: 120.3,
  pm10: 125.3,
  atmp: 31.6,
  rhum: 58,
  rco2: 461,
  tvoc: 112.2,
  timestamp: '2026-10-06T03:42:13.000Z',
  tvocIndex: 119,
  noxIndex: 1,
  model: 'O-1PST',
};
