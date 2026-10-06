import {
  AppError,
  ageSeconds,
  formatAge,
  isValidLatitude,
  isValidLongitude,
  nowIso,
  roundCoordinateForLog,
  toAppError,
} from '@gca/shared';
import type {
  AppModule,
  FrameContext,
  ModuleActionResult,
  ModuleContext,
  ModuleFrameDraft,
  ModuleHealth,
  ModuleManifest,
  ModuleRuntime,
  RefreshReason,
  ValidationContext,
  ValidationResult,
} from '@gca/module-sdk';
import { aqiCategory } from './aqi.js';
import { describeCondition } from './conditions.js';
import { formatTemperature } from './format.js';
import {
  buildWeatherFrames,
  displayableAir,
  staleAfterSeconds,
  weatherAgeSeconds,
  WEATHER_VIEW_AIR,
  WEATHER_VIEW_CURRENT,
} from './frames.js';
import { AirGradientProvider, type AirGradientLocation } from './provider-airgradient.js';
import { OpenMeteoProvider } from './provider-open-meteo.js';
import {
  AIRGRADIENT_TOKEN_SECRET,
  WEATHER_DEFAULT_SETTINGS,
  WEATHER_MAX_POLL_SECONDS,
  WEATHER_MIN_POLL_SECONDS,
  WEATHER_SETTINGS_SCHEMA,
  WEATHER_UI_SCHEMA,
  type WeatherSettings,
} from './settings.js';
import type { AirQualityReading, SourceError, WeatherSnapshot } from './types.js';

type PanelRow = NonNullable<ModuleActionResult['panel']>['rows'][number];

/** How many public monitors the test action suggests. */
const NEARBY_SUGGESTIONS = 5;

export const weatherManifest: ModuleManifest = {
  id: 'weather',
  version: '1.0.0',
  settingsVersion: 1,
  displayName: 'Weather',
  description:
    'Current conditions for a location — temperature, feels-like, humidity, wind and UV — with air quality from Open-Meteo or an AirGradient monitor.',
  icon: 'thermometer',
  category: 'monitoring',
  // One instance per place: a second city is a second instance, not a setting.
  singleton: false,
  refresh: {
    defaultSeconds: WEATHER_DEFAULT_SETTINGS.pollIntervalSeconds,
    minimumSeconds: WEATHER_MIN_POLL_SECONDS,
    maximumSeconds: WEATHER_MAX_POLL_SECONDS,
  },
  permissions: [
    'network:open-meteo',
    'network:airgradient',
    'location:configured',
    'secrets:read-own',
  ],
  views: [
    {
      id: WEATHER_VIEW_CURRENT,
      displayName: 'Current conditions',
      description: 'Temperature, condition, humidity, wind, air quality and one more reading',
      selectable: true,
    },
    {
      id: WEATHER_VIEW_AIR,
      displayName: 'Air quality',
      description: 'US AQI with PM2.5, and CO₂ and TVOC from an AirGradient monitor',
      selectable: true,
    },
  ],
  actions: [
    {
      id: 'weather.test',
      displayName: 'Test location and source',
      description:
        'Fetches conditions and air quality for the values on screen without saving them, and lists AirGradient monitors to choose from.',
      confirmation: 'none',
      timeoutMs: 20_000,
      inputSchema: {
        type: 'object',
        properties: {
          latitude: { type: 'number', minimum: -90, maximum: 90 },
          longitude: { type: 'number', minimum: -180, maximum: 180 },
          airQualitySource: {
            type: 'string',
            enum: ['open-meteo', 'airgradient', 'airgradient-public', 'off'],
          },
          airGradientLocationId: { type: ['integer', 'null'], minimum: 1 },
        },
      },
    },
  ],
};

class WeatherRuntime implements ModuleRuntime<WeatherSnapshot> {
  #snapshot: WeatherSnapshot | null = null;
  readonly #openMeteo: OpenMeteoProvider;
  readonly #airGradient: AirGradientProvider;

  constructor(private readonly ctx: ModuleContext<WeatherSettings>) {
    this.#openMeteo = new OpenMeteoProvider(ctx.http);
    this.#airGradient = new AirGradientProvider(ctx.http);
  }

  async start(): Promise<void> {
    this.ctx.logger.debug(
      {
        location: this.ctx.settings.locationLabel,
        latitude: roundCoordinateForLog(this.ctx.settings.latitude),
        longitude: roundCoordinateForLog(this.ctx.settings.longitude),
        airQuality: this.ctx.settings.airQualitySource,
      },
      'Weather module started',
    );
  }

  async stop(): Promise<void> {}

  getSnapshot(): WeatherSnapshot | null {
    return this.#snapshot;
  }

  /**
   * Restores what still describes the current settings and drops what does not, so a
   * moved location or a switched air source never shows the previous answer.
   */
  hydrate(snapshot: unknown): void {
    if (!isWeatherSnapshot(snapshot)) return;
    const weatherMatches = snapshot.weatherKey === weatherKeyFor(this.ctx.settings);
    const airMatches = snapshot.airKey !== null && snapshot.airKey === airKeyFor(this.ctx.settings);
    this.#snapshot = {
      ...snapshot,
      conditions: weatherMatches ? snapshot.conditions : null,
      lastWeatherSuccessAt: weatherMatches ? snapshot.lastWeatherSuccessAt : null,
      weatherError: weatherMatches ? snapshot.weatherError : null,
      weatherKey: weatherMatches ? snapshot.weatherKey : null,
      air: airMatches ? snapshot.air : null,
      lastAirSuccessAt: airMatches ? snapshot.lastAirSuccessAt : null,
      airError: airMatches ? snapshot.airError : null,
      airKey: airMatches ? snapshot.airKey : null,
    };
  }

  async refresh(_reason: RefreshReason, signal: AbortSignal): Promise<WeatherSnapshot> {
    const settings = this.ctx.settings;
    const configError = validateLocation(settings);
    if (configError) throw new AppError('WEATHER_LOCATION_INVALID', configError);

    const query = { latitude: settings.latitude, longitude: settings.longitude };
    const [weather, air] = await Promise.allSettled([
      this.#openMeteo.fetchConditions(query, signal),
      this.fetchAir(settings, signal),
    ]);

    const previous = this.#snapshot;
    const at = nowIso();
    const next: WeatherSnapshot = {
      capturedAt: at,
      conditions: previous?.conditions ?? null,
      air: previous?.air ?? null,
      weatherError: null,
      airError: null,
      lastWeatherSuccessAt: previous?.lastWeatherSuccessAt ?? null,
      lastAirSuccessAt: previous?.lastAirSuccessAt ?? null,
      weatherKey: weatherKeyFor(settings),
      airKey: airKeyFor(settings),
    };

    let weatherFailure: AppError | null = null;
    if (weather.status === 'fulfilled') {
      next.conditions = weather.value;
      next.lastWeatherSuccessAt = at;
    } else {
      // Keep the previous reading: the display degrades through `stale` to `offline`
      // instead of blanking on the first transient failure.
      weatherFailure = toAppError(weather.reason, 'Open-Meteo request failed');
      next.weatherError = sourceError(weatherFailure, at);
    }

    if (air.status === 'fulfilled') {
      next.air = air.value;
      next.lastAirSuccessAt = air.value ? at : null;
    } else {
      // Air quality is a tile on a weather panel. Its failure is reported in health and
      // on its own view, but it never fails the poll or blanks the temperature.
      const failure = toAppError(air.reason, 'Air quality request failed');
      next.airError = sourceError(failure, at);
      this.ctx.logger.debug(
        { code: failure.code, error: failure.message },
        'Air quality fetch failed; keeping the previous reading',
      );
    }

    this.#snapshot = next;
    if (weatherFailure) throw weatherFailure;
    return next;
  }

  async getFrames(ctx: FrameContext): Promise<ModuleFrameDraft[]> {
    return buildWeatherFrames({
      snapshot: this.#snapshot,
      settings: this.ctx.settings,
      ctx,
      configurationError: validateLocation(this.ctx.settings),
    });
  }

  async getHealth(): Promise<ModuleHealth> {
    const settings = this.ctx.settings;
    const configError = validateLocation(settings);
    if (configError) {
      return { status: 'error', message: configError, code: 'WEATHER_LOCATION_INVALID' };
    }
    const snapshot = this.#snapshot;
    if (!snapshot) return { status: 'unknown', message: 'No poll completed yet.' };

    const now = this.ctx.now();
    const age = weatherAgeSeconds(snapshot, now);
    if (snapshot.weatherError) {
      const stale = age === null || age > staleAfterSeconds(settings);
      return {
        status: stale ? 'error' : 'degraded',
        message: snapshot.weatherError.message,
        code: snapshot.weatherError.code,
      };
    }
    if (snapshot.airError) {
      return {
        status: 'degraded',
        message: `Weather is current; air quality failed: ${snapshot.airError.message}`,
        code: snapshot.airError.code,
      };
    }

    const conditions = snapshot.conditions;
    if (!conditions) return { status: 'unknown', message: 'No reading yet.' };
    const temperature = formatTemperature(conditions.temperatureC, settings.units);
    const unit = settings.units === 'imperial' ? 'F' : 'C';
    return {
      status: 'healthy',
      message: `${temperature}${unit}, ${describeCondition(conditions.weatherCode, conditions.isDay).label.toLowerCase()}.`,
    };
  }

  async getStatusPanel(): Promise<ModuleActionResult['panel'] | null> {
    const settings = this.ctx.settings;
    const snapshot = this.#snapshot;
    const now = this.ctx.now();
    const age = weatherAgeSeconds(snapshot, now);
    const air = displayableAir(snapshot, settings, now);

    return {
      title: 'Sources',
      rows: [
        {
          label: 'Weather',
          value: 'Open-Meteo',
          ...(snapshot?.weatherError
            ? { tone: 'bad' as const, hint: snapshot.weatherError.message }
            : {}),
        },
        {
          label: 'Air quality',
          value: AIR_SOURCE_LABELS[settings.airQualitySource],
          ...(snapshot?.airError ? { tone: 'warn' as const, hint: snapshot.airError.message } : {}),
        },
        {
          label: 'Location',
          value: `${settings.locationLabel} (${settings.latitude.toFixed(3)}, ${settings.longitude.toFixed(3)})`,
        },
        {
          label: 'Last update',
          value: age === null ? 'never' : `${formatAge(age)} ago`,
          tone: age === null ? 'warn' : 'neutral',
        },
        ...(settings.airQualitySource === 'off'
          ? []
          : [
              {
                label: 'US AQI',
                value:
                  air?.usAqi === null || air?.usAqi === undefined
                    ? '—'
                    : `${air.usAqi} · ${aqiCategory(air.usAqi).label}`,
                ...(air
                  ? { hint: `Measured ${formatAge(ageSeconds(air.observedAt, now))} ago` }
                  : {}),
              },
            ]),
      ],
    };
  }

  async runAction(
    actionId: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<ModuleActionResult> {
    if (actionId !== 'weather.test') {
      throw new AppError('MODULE_ACTION_UNKNOWN', `Unknown action "${actionId}".`);
    }

    const payload = (input ?? {}) as Partial<WeatherSettings>;
    const settings: WeatherSettings = {
      ...this.ctx.settings,
      ...(payload.latitude === undefined ? {} : { latitude: payload.latitude }),
      ...(payload.longitude === undefined ? {} : { longitude: payload.longitude }),
      ...(payload.airQualitySource === undefined
        ? {}
        : { airQualitySource: payload.airQualitySource }),
      ...(payload.airGradientLocationId === undefined
        ? {}
        : { airGradientLocationId: payload.airGradientLocationId }),
    };

    const configError = validateLocation(settings);
    if (configError) return { ok: false, message: configError, code: 'WEATHER_LOCATION_INVALID' };

    const query = { latitude: settings.latitude, longitude: settings.longitude };
    const rows: PanelRow[] = [];

    try {
      const conditions = await this.#openMeteo.fetchConditions(query, signal);
      const condition = describeCondition(conditions.weatherCode, conditions.isDay);
      rows.push({
        label: 'Now',
        value: `${formatTemperature(conditions.temperatureC, settings.units)} · ${condition.label}`,
        tone: 'good',
      });
    } catch (error) {
      const appError = toAppError(error, 'Open-Meteo request failed');
      return { ok: false, message: appError.message, code: appError.code };
    }

    const airResult = await this.testAir(settings, query, signal);
    rows.push(...airResult.rows);

    return {
      ok: true,
      message: airResult.message ?? 'Open-Meteo answered for these coordinates.',
      panel: { title: 'Test result', rows },
    };
  }

  /** The air-quality half of the test. Never fails the action: weather already worked. */
  private async testAir(
    settings: WeatherSettings,
    query: { latitude: number; longitude: number },
    signal: AbortSignal,
  ): Promise<{ message?: string; rows: PanelRow[] }> {
    try {
      switch (settings.airQualitySource) {
        case 'off':
          return { rows: [{ label: 'Air quality', value: 'off', tone: 'neutral' }] };

        case 'open-meteo': {
          const reading = await this.#openMeteo.fetchAirQuality(query, signal);
          return { rows: [aqiRow('Modelled AQI', reading)] };
        }

        case 'airgradient': {
          const token = await this.ctx.secrets.get(AIRGRADIENT_TOKEN_SECRET);
          if (!token) {
            return {
              message: 'Weather works. Save an AirGradient API token to test the monitor.',
              rows: [{ label: 'AirGradient', value: 'no token saved', tone: 'warn' }],
            };
          }
          const locations = await this.#airGradient.listOwnLocations(token, signal);
          if (locations.length === 0) {
            return {
              message: 'The token works, but the account has no monitors with readings.',
              rows: [{ label: 'AirGradient', value: 'no monitors', tone: 'warn' }],
            };
          }
          const chosenMissing =
            settings.airGradientLocationId !== null &&
            !locations.some((entry) => entry.locationId === settings.airGradientLocationId);
          return {
            message: chosenMissing
              ? `Location ${settings.airGradientLocationId} is not on this account. Pick one of the IDs below.`
              : `The token works. ${locations.length} monitor${locations.length === 1 ? '' : 's'} on the account.`,
            rows: locations.map((entry) =>
              locationRow(entry, entry.locationId === settings.airGradientLocationId),
            ),
          };
        }

        case 'airgradient-public': {
          const nearby = await this.#airGradient.findNearbyPublic(
            query,
            NEARBY_SUGGESTIONS,
            signal,
          );
          const rows: PanelRow[] = nearby.map((entry) =>
            locationRow(entry, entry.locationId === settings.airGradientLocationId),
          );
          if (settings.airGradientLocationId !== null) {
            const reading = await this.#airGradient.fetchReading(
              { kind: 'public' },
              settings.airGradientLocationId,
              signal,
            );
            rows.unshift(aqiRow(`#${settings.airGradientLocationId}`, reading));
          }
          return {
            message:
              nearby.length === 0
                ? 'No public AirGradient monitors are reporting right now.'
                : 'Nearest public AirGradient monitors. Put one of these IDs in Location ID.',
            rows,
          };
        }
      }
    } catch (error) {
      const appError = toAppError(error, 'Air quality request failed');
      return {
        message: `Weather works; air quality failed: ${appError.message}`,
        rows: [{ label: 'Air quality', value: appError.code, tone: 'bad', hint: appError.message }],
      };
    }
  }

  /** Null means "no air quality configured", which is an answer, not a failure. */
  private async fetchAir(
    settings: WeatherSettings,
    signal: AbortSignal,
  ): Promise<AirQualityReading | null> {
    const query = { latitude: settings.latitude, longitude: settings.longitude };
    switch (settings.airQualitySource) {
      case 'off':
        return null;
      case 'open-meteo':
        return this.#openMeteo.fetchAirQuality(query, signal);
      case 'airgradient-public':
        return this.#airGradient.fetchReading(
          { kind: 'public' },
          settings.airGradientLocationId,
          signal,
        );
      case 'airgradient': {
        // Read per poll rather than cached, so a token added in the UI takes effect
        // without restarting the instance.
        const token = await this.ctx.secrets.get(AIRGRADIENT_TOKEN_SECRET);
        if (!token) {
          throw new AppError(
            'AIRGRADIENT_NOT_CONFIGURED',
            'Add an AirGradient API token in module settings.',
          );
        }
        return this.#airGradient.fetchReading(
          { kind: 'token', token },
          settings.airGradientLocationId,
          signal,
        );
      }
    }
  }
}

const AIR_SOURCE_LABELS: Record<WeatherSettings['airQualitySource'], string> = {
  'open-meteo': 'Open-Meteo (modelled)',
  airgradient: 'AirGradient monitor',
  'airgradient-public': 'Public AirGradient monitor',
  off: 'off',
};

function aqiRow(label: string, reading: AirQualityReading): PanelRow {
  if (reading.usAqi === null) {
    return { label, value: 'no PM2.5 reported', tone: 'warn' };
  }
  return {
    label,
    value: `${reading.usAqi} · ${aqiCategory(reading.usAqi).label}`,
    tone: 'good',
  };
}

function locationRow(entry: AirGradientLocation, selected: boolean): PanelRow {
  const parts = [
    entry.name ?? 'Unnamed',
    ...(entry.distanceKm === undefined ? [] : [`${formatDistanceKm(entry.distanceKm)}`]),
    entry.usAqi === null ? 'no PM2.5' : `AQI ${entry.usAqi}`,
  ];
  return {
    label: `#${entry.locationId}${selected ? ' (selected)' : ''}`,
    value: parts.join(' · '),
    tone: selected ? 'good' : 'neutral',
  };
}

function formatDistanceKm(km: number): string {
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

function sourceError(error: AppError, at: string): SourceError {
  return { code: error.code, message: error.message, at };
}

export function weatherKeyFor(settings: WeatherSettings): string {
  return `${settings.latitude.toFixed(4)},${settings.longitude.toFixed(4)}`;
}

export function airKeyFor(settings: WeatherSettings): string | null {
  switch (settings.airQualitySource) {
    case 'off':
      return null;
    case 'open-meteo':
      return `open-meteo@${weatherKeyFor(settings)}`;
    case 'airgradient':
      return `airgradient:${settings.airGradientLocationId ?? 'first'}`;
    case 'airgradient-public':
      return `airgradient-public:${settings.airGradientLocationId ?? 'unset'}`;
  }
}

export function validateLocation(settings: WeatherSettings): string | null {
  if (!isValidLatitude(settings.latitude) || !isValidLongitude(settings.longitude)) {
    return 'Set a latitude and longitude in module settings.';
  }
  // The default. Somewhere in the Gulf of Guinea is a valid place but never a setting.
  if (settings.latitude === 0 && settings.longitude === 0) {
    return 'Set a latitude and longitude in module settings.';
  }
  return null;
}

export const weatherModule: AppModule<WeatherSettings, WeatherSnapshot> = {
  manifest: weatherManifest,
  settingsSchema: WEATHER_SETTINGS_SCHEMA,
  uiSchema: WEATHER_UI_SCHEMA,
  defaultSettings: WEATHER_DEFAULT_SETTINGS,
  secretKeys: [AIRGRADIENT_TOKEN_SECRET],

  async validateSettings(
    settings: unknown,
    ctx: ValidationContext,
  ): Promise<ValidationResult<WeatherSettings>> {
    const value = { ...WEATHER_DEFAULT_SETTINGS, ...(settings as Partial<WeatherSettings>) };
    const errors: Array<{ path: string; message: string }> = [];

    if (!isValidLatitude(value.latitude)) {
      errors.push({ path: '/latitude', message: 'Latitude must be between -90 and 90.' });
    }
    if (!isValidLongitude(value.longitude)) {
      errors.push({ path: '/longitude', message: 'Longitude must be between -180 and 180.' });
    }
    if (
      value.airQualitySource === 'airgradient' &&
      !ctx.secretConfigured(AIRGRADIENT_TOKEN_SECRET)
    ) {
      errors.push({
        path: `/${AIRGRADIENT_TOKEN_SECRET}`,
        message: 'Reading your own AirGradient monitor needs its API token.',
      });
    }
    if (value.airQualitySource === 'airgradient-public' && value.airGradientLocationId === null) {
      errors.push({
        path: '/airGradientLocationId',
        message: 'Pick a public monitor by location ID. Test the source to list the nearest.',
      });
    }
    if (errors.length > 0) return { ok: false, errors };

    const warnings: string[] = [];
    if (value.pollIntervalSeconds < 300) {
      warnings.push(
        'Open-Meteo recomputes current conditions every 15 minutes, so polling faster than every 5 minutes shows nothing new.',
      );
    }
    return { ok: true, value, ...(warnings.length > 0 ? { warnings } : {}) };
  },

  async migrateSettings(fromVersion: number, settings: unknown) {
    // Version 1 is the first schema; later versions append cases here.
    return { version: Math.max(1, fromVersion), settings };
  },

  createRuntime(ctx) {
    return new WeatherRuntime(ctx);
  },

  snapshotIsValid: isWeatherSnapshot,
};

function isWeatherSnapshot(value: unknown): value is WeatherSnapshot {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<WeatherSnapshot>;
  return typeof record.capturedAt === 'string' && 'conditions' in record && 'air' in record;
}
