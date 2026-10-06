import { describe, expect, it } from 'vitest';
import type { ModuleFrameDraft, WeatherFrameLayout } from '@gca/module-sdk';
import { buildWeatherFrames } from '../src/frames.js';
import { airKeyFor, weatherKeyFor, weatherModule } from '../src/module.js';
import { AIRGRADIENT_TOKEN_SECRET, type WeatherSettings } from '../src/settings.js';
import type { WeatherSnapshot } from '../src/types.js';
import {
  AIR_QUALITY_SAMPLE,
  FORECAST_SAMPLE,
  moduleContext,
  NOW,
  PUBLIC_MONITOR_SAMPLE,
  settingsWith,
  signal,
  stubHttp,
} from './helpers.js';

const OPEN_METEO_ROUTES: Array<[string, { body: unknown }]> = [
  ['https://api.open-meteo.com/', { body: FORECAST_SAMPLE }],
  ['https://air-quality-api.open-meteo.com/', { body: AIR_QUALITY_SAMPLE }],
];

function runtimeFor(
  settings: WeatherSettings,
  routes: Parameters<typeof stubHttp>[0] = OPEN_METEO_ROUTES,
  options: Parameters<typeof moduleContext>[2] = {},
) {
  const { http, urls } = stubHttp(routes);
  const runtime = weatherModule.createRuntime(moduleContext(http, settings, options));
  return { runtime, urls };
}

async function framesFor(runtime: ReturnType<typeof runtimeFor>['runtime'], now = NOW) {
  return runtime.getFrames({ now, timezone: 'UTC', accent: 'cyan' });
}

function weatherLayout(frames: ModuleFrameDraft[]): WeatherFrameLayout {
  const layout = frames.find((frame) => frame.viewId === 'current')?.layout;
  if (layout?.kind !== 'weather') throw new Error(`expected a weather layout, got ${layout?.kind}`);
  return layout;
}

describe('weather runtime', () => {
  it('fetches conditions and air quality and builds both views', async () => {
    const { runtime } = runtimeFor(settingsWith());
    await runtime.refresh('manual', signal);
    const frames = await framesFor(runtime);

    expect(frames.map((frame) => frame.viewId)).toEqual(['current', 'air-quality']);
    const layout = weatherLayout(frames);
    expect(layout.temperatureText).toBe('31°');
    expect(layout.condition).toBe('Clear');
    expect(layout.summary).toBe('Feels 36° · H 35° L 26°');
    expect(layout.tiles).toEqual([
      { label: 'Humidity', value: '58%' },
      // From 87° (east); the arrow points where the air goes, roughly west.
      { label: 'Wind', value: '4 km/h', detail: 'E', arrowDegrees: 267 },
      { label: 'AQI', value: '172', detail: 'Unhealthy', tone: 'red' },
      { label: 'UV index', value: '2', detail: 'Low', tone: 'green' },
    ]);
    expect(layout.attribution).toBe('Open-Meteo');
  });

  it('converts units locally, so the snapshot stays metric', async () => {
    const { runtime, urls } = runtimeFor(
      settingsWith({ units: 'imperial', windSpeedUnit: 'mph', extraReading: 'pressure' }),
    );
    const snapshot = await runtime.refresh('manual', signal);
    const layout = weatherLayout(await framesFor(runtime));

    expect(snapshot.conditions?.temperatureC).toBe(31.4);
    expect(urls.some((url) => url.includes('fahrenheit'))).toBe(false);
    expect(layout.temperatureText).toBe('89°');
    expect(layout.tiles[1]?.value).toBe('2 mph');
    expect(layout.tiles[3]).toEqual({ label: 'Pressure', value: '29.96 inHg' });
  });

  it('fills the AQI slot with another reading when air quality is off', async () => {
    const { runtime, urls } = runtimeFor(settingsWith({ airQualitySource: 'off' }));
    await runtime.refresh('manual', signal);
    const frames = await framesFor(runtime);

    expect(urls.every((url) => !url.includes('air-quality'))).toBe(true);
    // No air frame: the host falls back to the weather view for that playlist slot.
    expect(frames.map((frame) => frame.viewId)).toEqual(['current']);
    expect(weatherLayout(frames).tiles.map((tile) => tile.label)).toEqual([
      'Humidity',
      'Wind',
      'Pressure',
      'UV index',
    ]);
  });

  it('keeps showing the weather when only air quality fails', async () => {
    const { runtime } = runtimeFor(settingsWith(), [
      ['https://api.open-meteo.com/', { body: FORECAST_SAMPLE }],
      ['https://air-quality-api.open-meteo.com/', { status: 503, body: 'down' }],
    ]);

    // The poll itself succeeds: air quality is a tile, not the panel.
    const snapshot = await runtime.refresh('manual', signal);
    expect(snapshot.airError?.code).toBe('WEATHER_PROVIDER_UNAVAILABLE');

    const frames = await framesFor(runtime);
    expect(weatherLayout(frames).tiles[2]).toEqual({ label: 'AQI', value: '—' });
    expect(frames.find((frame) => frame.viewId === 'air-quality')?.layout).toMatchObject({
      kind: 'error',
      headline: 'Air quality unavailable',
    });
    expect(await runtime.getHealth()).toMatchObject({ status: 'degraded' });
  });

  it('degrades through stale to offline rather than blanking or lying', async () => {
    let now = NOW;
    const routes: Parameters<typeof stubHttp>[0] = [...OPEN_METEO_ROUTES];
    const { runtime } = runtimeFor(settingsWith(), routes, { now: () => now });
    await runtime.refresh('manual', signal);

    // Open-Meteo goes down.
    routes.splice(0, routes.length, ['https://', new Error('connect ECONNREFUSED')]);
    await expect(runtime.refresh('scheduled', signal)).rejects.toThrow();

    const fresh = (await framesFor(runtime, now))[0]!;
    expect(fresh.badge).toBeUndefined();
    expect(fresh.layout.kind).toBe('weather');

    now = new Date(NOW.getTime() + 45 * 60_000);
    const stale = (await framesFor(runtime, now))[0]!;
    expect(stale.badge).toEqual({ text: 'stale', tone: 'amber' });
    expect(stale.layout.kind).toBe('weather');

    now = new Date(NOW.getTime() + 4 * 60 * 60_000);
    const offline = (await framesFor(runtime, now))[0]!;
    expect(offline.layout).toMatchObject({ kind: 'error', headline: 'Weather offline' });
    expect(await runtime.getHealth()).toMatchObject({ status: 'error' });
  });

  it('refuses to poll for the unset default coordinates', async () => {
    const { runtime, urls } = runtimeFor(settingsWith({ latitude: 0, longitude: 0 }));
    await expect(runtime.refresh('startup', signal)).rejects.toMatchObject({
      code: 'WEATHER_LOCATION_INVALID',
    });
    expect(urls).toEqual([]);
    expect((await framesFor(runtime))[0]?.layout).toMatchObject({ kind: 'error' });
  });
});

describe('AirGradient through the runtime', () => {
  const ownMonitor = {
    locationId: 101,
    locationName: 'Living room',
    pm02_corrected: 4.1,
    rco2: 640,
    tvocIndex: 87,
    noxIndex: 1,
    timestamp: '2026-10-06T03:50:00Z',
  };

  it('reads your own monitor with the stored token and shows its gases', async () => {
    const { runtime, urls } = runtimeFor(
      settingsWith({ airQualitySource: 'airgradient' }),
      [
        ['https://api.open-meteo.com/', { body: FORECAST_SAMPLE }],
        ['https://api.airgradient.com/', { body: [ownMonitor] }],
      ],
      { secrets: { [AIRGRADIENT_TOKEN_SECRET]: 'token-123' } },
    );
    await runtime.refresh('manual', signal);
    const frames = await framesFor(runtime);

    expect(urls.some((url) => url.includes('token=token-123'))).toBe(true);
    const weather = weatherLayout(frames);
    expect(weather.tiles[2]).toEqual({
      label: 'AQI · sensor',
      value: '23',
      detail: 'Good',
      tone: 'green',
    });
    expect(weather.attribution).toBe('Open-Meteo · AirGradient');

    const air = frames.find((frame) => frame.viewId === 'air-quality')!;
    // Your own monitor's name is the useful header.
    expect(air.title).toBe('Living room');
    expect(air.layout).toMatchObject({
      kind: 'hero',
      value: '23',
      unit: 'US AQI',
      caption: 'Good',
      supporting: [
        { label: 'PM2.5', value: '4.1 µg/m³' },
        { label: 'CO₂', value: '640 ppm' },
        { label: 'TVOC index', value: '87' },
      ],
    });
  });

  it('explains a missing token without failing the weather', async () => {
    const { runtime } = runtimeFor(settingsWith({ airQualitySource: 'airgradient' }), [
      ['https://api.open-meteo.com/', { body: FORECAST_SAMPLE }],
    ]);
    const snapshot = await runtime.refresh('manual', signal);
    expect(snapshot.conditions).not.toBeNull();
    expect(snapshot.airError?.code).toBe('AIRGRADIENT_NOT_CONFIGURED');
  });

  it('says the monitor stopped reporting instead of showing an old reading as current', async () => {
    const old = { ...ownMonitor, timestamp: '2026-10-05T20:00:00Z' };
    const { runtime } = runtimeFor(
      settingsWith({ airQualitySource: 'airgradient' }),
      [
        ['https://api.open-meteo.com/', { body: FORECAST_SAMPLE }],
        ['https://api.airgradient.com/', { body: [old] }],
      ],
      { secrets: { [AIRGRADIENT_TOKEN_SECRET]: 't' } },
    );
    await runtime.refresh('manual', signal);
    const frames = await framesFor(runtime);

    expect(weatherLayout(frames).tiles[2]).toEqual({ label: 'AQI', value: '—' });
    expect(frames.find((frame) => frame.viewId === 'air-quality')?.layout).toMatchObject({
      kind: 'error',
      headline: 'Monitor not reporting',
      footer: 'Last reading 7h 52m ago',
    });
  });

  it('keeps your label in the header for a public monitor', async () => {
    const { runtime } = runtimeFor(
      settingsWith({ airQualitySource: 'airgradient-public', airGradientLocationId: 178634 }),
      [
        ['https://api.open-meteo.com/', { body: FORECAST_SAMPLE }],
        ['https://api.airgradient.com/', { body: PUBLIC_MONITOR_SAMPLE }],
      ],
    );
    await runtime.refresh('manual', signal);
    const air = (await framesFor(runtime)).find((frame) => frame.viewId === 'air-quality')!;
    expect(air.title).toBe('Dhaka');
  });
});

describe('snapshot hydration', () => {
  async function snapshotFor(settings: WeatherSettings): Promise<WeatherSnapshot> {
    const { runtime } = runtimeFor(settings);
    return runtime.refresh('manual', signal);
  }

  it('restores a snapshot fetched for the same place and source', async () => {
    const settings = settingsWith();
    const snapshot = await snapshotFor(settings);
    const { runtime } = runtimeFor(settings);
    runtime.hydrate?.(snapshot);

    expect(runtime.getSnapshot()?.conditions?.temperatureC).toBe(31.4);
    expect(runtime.getSnapshot()?.air?.usAqi).toBe(172);
  });

  it('drops the old city’s weather after the location moves', async () => {
    const snapshot = await snapshotFor(settingsWith());
    const moved = settingsWith({ locationLabel: 'Chittagong', latitude: 22.36, longitude: 91.78 });
    const { runtime } = runtimeFor(moved);
    runtime.hydrate?.(snapshot);

    expect(runtime.getSnapshot()?.conditions).toBeNull();
    // The modelled AQI is per-coordinate too, so it goes with it.
    expect(runtime.getSnapshot()?.air).toBeNull();
    expect((await framesFor(runtime))[0]?.layout).toMatchObject({ kind: 'empty' });
  });

  it('drops only the air reading when the air source changes', async () => {
    const snapshot = await snapshotFor(settingsWith());
    const { runtime } = runtimeFor(
      settingsWith({ airQualitySource: 'airgradient-public', airGradientLocationId: 5 }),
    );
    runtime.hydrate?.(snapshot);

    expect(runtime.getSnapshot()?.conditions).not.toBeNull();
    expect(runtime.getSnapshot()?.air).toBeNull();
  });

  it('keys air readings by monitor, not just by source', () => {
    const a = settingsWith({ airQualitySource: 'airgradient', airGradientLocationId: 1 });
    const b = settingsWith({ airQualitySource: 'airgradient', airGradientLocationId: 2 });
    expect(airKeyFor(a)).not.toBe(airKeyFor(b));
    expect(airKeyFor(settingsWith({ airQualitySource: 'off' }))).toBeNull();
    expect(weatherKeyFor(a)).toBe(weatherKeyFor(b));
  });
});

describe('test action', () => {
  it('tests unsaved coordinates and lists the nearest public monitors', async () => {
    const world = [
      { ...PUBLIC_MONITOR_SAMPLE, locationId: 7, latitude: 51.51, longitude: -0.12 },
      { ...PUBLIC_MONITOR_SAMPLE, locationId: 8, latitude: 23.82, longitude: 90.41 },
    ];
    const { runtime, urls } = runtimeFor(settingsWith(), [
      ['https://api.open-meteo.com/', { body: FORECAST_SAMPLE }],
      ['https://api.airgradient.com/public/api/v1/world/locations/measures', { body: world }],
    ]);

    const result = await runtime.runAction!(
      'weather.test',
      { latitude: 51.5, longitude: -0.1, airQualitySource: 'airgradient-public' },
      signal,
    );

    expect(result.ok).toBe(true);
    expect(new URL(urls[0]!).searchParams.get('latitude')).toBe('51.5000');
    expect(result.panel?.rows.map((row) => row.label)).toEqual(['Now', '#7', '#8']);
  });

  it('reports a weather failure as a failed test', async () => {
    const { runtime } = runtimeFor(settingsWith(), [['https://', new Error('offline')]]);
    const result = await runtime.runAction!('weather.test', {}, signal);
    expect(result.ok).toBe(false);
  });
});

describe('validateSettings', () => {
  const ctx = (configured: string[] = []) => ({
    instanceId: null,
    secretConfigured: (key: string) => configured.includes(key),
  });

  it('requires a token to read your own monitor', async () => {
    const result = await weatherModule.validateSettings(
      settingsWith({ airQualitySource: 'airgradient' }),
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.path).toBe('/airGradientToken');

    const withToken = await weatherModule.validateSettings(
      settingsWith({ airQualitySource: 'airgradient' }),
      ctx([AIRGRADIENT_TOKEN_SECRET]),
    );
    expect(withToken.ok).toBe(true);
  });

  it('requires a location ID for a public monitor, since there is no default', async () => {
    const result = await weatherModule.validateSettings(
      settingsWith({ airQualitySource: 'airgradient-public' }),
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.path).toBe('/airGradientLocationId');
  });

  it('warns that polling faster than Open-Meteo updates gains nothing', async () => {
    const result = await weatherModule.validateSettings(
      settingsWith({ pollIntervalSeconds: 120 }),
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings?.[0]).toMatch(/15 minutes/);
  });
});

describe('frames without a snapshot', () => {
  it('shows a starting-up state rather than empty readings', () => {
    const frames = buildWeatherFrames({
      snapshot: null,
      settings: settingsWith(),
      ctx: { now: NOW, timezone: 'UTC', accent: 'cyan' },
      configurationError: null,
    });
    expect(frames[0]?.layout).toMatchObject({ kind: 'empty', headline: 'Starting up' });
  });
});
