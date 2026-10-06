import { ageSeconds, bearingToCompass, formatAge } from '@gca/shared';
import type {
  FrameContext,
  ModuleFrameDraft,
  SemanticColor,
  SupportingItem,
  WeatherTile,
} from '@gca/module-sdk';
import { aqiCategory } from './aqi.js';
import { describeCondition } from './conditions.js';
import {
  formatPercent,
  formatPrecipitation,
  formatPressure,
  formatTemperature,
  formatWindSpeed,
  MISSING,
  uvCategory,
  windArrowDegrees,
} from './format.js';
import { AIRGRADIENT_ATTRIBUTION } from './provider-airgradient.js';
import { OPEN_METEO_ATTRIBUTION } from './provider-open-meteo.js';
import type { ExtraReading, WeatherSettings } from './settings.js';
import type { AirQualityReading, CurrentConditions, WeatherSnapshot } from './types.js';

export const WEATHER_VIEW_CURRENT = 'current';
export const WEATHER_VIEW_AIR = 'air-quality';

/** Past this, the last good reading stays up with a `stale` badge. */
const MIN_STALE_SECONDS = 30 * 60;
const STALE_POLL_MULTIPLIER = 3;
/** Past this, a temperature is history rather than weather, and the panel says so. */
const WEATHER_OFFLINE_SECONDS = 3 * 60 * 60;
/**
 * A monitor that stopped reporting keeps its last reading in the cloud indefinitely,
 * so the reading's own timestamp — not when it was fetched — decides whether it shows.
 */
const AIR_READING_MAX_AGE_SECONDS = 2 * 60 * 60;

export interface FrameInput {
  snapshot: WeatherSnapshot | null;
  settings: WeatherSettings;
  ctx: FrameContext;
  configurationError: string | null;
}

export function staleAfterSeconds(settings: WeatherSettings): number {
  return Math.max(MIN_STALE_SECONDS, settings.pollIntervalSeconds * STALE_POLL_MULTIPLIER);
}

export function weatherAgeSeconds(snapshot: WeatherSnapshot | null, now: Date): number | null {
  if (!snapshot?.lastWeatherSuccessAt) return null;
  return ageSeconds(snapshot.lastWeatherSuccessAt, now);
}

/** The reading to display, or null when there is none or it is too old to trust. */
export function displayableAir(
  snapshot: WeatherSnapshot | null,
  settings: WeatherSettings,
  now: Date,
): AirQualityReading | null {
  if (settings.airQualitySource === 'off' || !snapshot?.air) return null;
  return ageSeconds(snapshot.air.observedAt, now) > AIR_READING_MAX_AGE_SECONDS
    ? null
    : snapshot.air;
}

export function buildWeatherFrames(input: FrameInput): ModuleFrameDraft[] {
  const frames = [buildCurrentFrame(input)];
  const air = buildAirFrame(input);
  // With air quality off there is no frame; the host falls back to the weather view.
  if (air) frames.push(air);
  return frames;
}

function base(
  id: string,
  viewId: string,
  settings: WeatherSettings,
  icon: string,
): Pick<ModuleFrameDraft, 'id' | 'viewId' | 'title' | 'icon' | 'accent' | 'priority'> {
  return {
    id,
    viewId,
    title: settings.locationLabel,
    icon,
    accent: settings.accent as SemanticColor,
    priority: 'normal',
  };
}

export function buildCurrentFrame(input: FrameInput): ModuleFrameDraft {
  const { snapshot, settings, ctx, configurationError } = input;
  const frame = base('weather-current', WEATHER_VIEW_CURRENT, settings, 'thermometer');

  if (configurationError) {
    return {
      ...frame,
      layout: {
        kind: 'error',
        severity: 'error',
        headline: 'Location invalid',
        detail: configurationError,
        code: 'WEATHER_LOCATION_INVALID',
      },
    };
  }

  const age = weatherAgeSeconds(snapshot, ctx.now);
  const conditions = snapshot?.conditions ?? null;

  if (!snapshot || (!conditions && !snapshot.weatherError)) {
    return {
      ...frame,
      layout: {
        kind: 'empty',
        icon: 'thermometer',
        headline: 'Starting up',
        detail: `Waiting for the first reading for ${settings.locationLabel}`,
      },
    };
  }

  if (!conditions || age === null || age > WEATHER_OFFLINE_SECONDS) {
    const error = snapshot.weatherError;
    const rateLimited = error?.code === 'WEATHER_PROVIDER_RATE_LIMITED';
    return {
      ...frame,
      badge: { text: rateLimited ? 'wait' : 'offline', tone: rateLimited ? 'amber' : 'red' },
      layout: {
        kind: 'error',
        severity: rateLimited ? 'warn' : 'error',
        headline: rateLimited ? 'Rate limited' : 'Weather offline',
        detail: error?.message ?? 'No recent reading from Open-Meteo.',
        ...(error ? { code: error.code } : {}),
        footer: age === null ? 'No successful reading yet' : `Last reading ${formatAge(age)} ago`,
      },
    };
  }

  const condition = describeCondition(conditions.weatherCode, conditions.isDay);
  const air = displayableAir(snapshot, settings, ctx.now);
  const stale = age > staleAfterSeconds(settings);
  const attribution =
    air?.source === 'airgradient'
      ? `${OPEN_METEO_ATTRIBUTION} · ${AIRGRADIENT_ATTRIBUTION}`
      : OPEN_METEO_ATTRIBUTION;

  return {
    ...frame,
    ...(stale ? { badge: { text: 'stale', tone: 'amber' as const } } : {}),
    layout: {
      kind: 'weather',
      temperatureText: formatTemperature(conditions.temperatureC, settings.units),
      condition: condition.label,
      conditionIcon: condition.icon,
      ...optional('summary', summaryLine(conditions, settings)),
      tiles: buildTiles(conditions, air, settings),
      attribution,
      footer: `${formatAge(age)} ago`,
    },
  };
}

function summaryLine(conditions: CurrentConditions, settings: WeatherSettings): string | null {
  const parts: string[] = [];
  if (conditions.apparentTemperatureC !== null) {
    parts.push(`Feels ${formatTemperature(conditions.apparentTemperatureC, settings.units)}`);
  }
  const high = conditions.todayMaxC;
  const low = conditions.todayMinC;
  if (high !== null || low !== null) {
    parts.push(
      `H ${formatTemperature(high, settings.units)} L ${formatTemperature(low, settings.units)}`,
    );
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

function buildTiles(
  conditions: CurrentConditions,
  air: AirQualityReading | null,
  settings: WeatherSettings,
): WeatherTile[] {
  const tiles: WeatherTile[] = [
    { label: 'Humidity', value: formatPercent(conditions.relativeHumidityPercent) },
    windTile(conditions, settings),
  ];

  if (settings.airQualitySource === 'off') {
    // Without an AQI tile the grid would have a hole; a second reading fills it.
    const second = EXTRA_FALLBACK_ORDER.find((reading) => reading !== settings.extraReading);
    if (second) tiles.push(extraTile(second, conditions, settings));
  } else {
    tiles.push(aqiTile(air));
  }

  tiles.push(extraTile(settings.extraReading, conditions, settings));
  return tiles;
}

const EXTRA_FALLBACK_ORDER: readonly ExtraReading[] = ['pressure', 'uv', 'gusts', 'dew-point'];

function windTile(conditions: CurrentConditions, settings: WeatherSettings): WeatherTile {
  const value = formatWindSpeed(conditions.windSpeedKmh, settings.windSpeedUnit);
  const from = conditions.windDirectionDegrees;
  // Calm air has a direction in the data but not in any useful sense.
  if (from === null || conditions.windSpeedKmh === null || conditions.windSpeedKmh < 1) {
    return { label: 'Wind', value: conditions.windSpeedKmh === null ? MISSING : value };
  }
  return {
    label: 'Wind',
    value,
    detail: bearingToCompass(from),
    arrowDegrees: windArrowDegrees(from),
  };
}

function aqiTile(air: AirQualityReading | null): WeatherTile {
  if (!air || air.usAqi === null) return { label: 'AQI', value: MISSING };
  const category = aqiCategory(air.usAqi);
  return {
    label: air.source === 'airgradient' ? 'AQI · sensor' : 'AQI',
    value: String(air.usAqi),
    detail: category.shortLabel,
    tone: category.tone,
  };
}

function extraTile(
  reading: ExtraReading,
  conditions: CurrentConditions,
  settings: WeatherSettings,
): WeatherTile {
  switch (reading) {
    case 'uv': {
      if (conditions.uvIndex === null) return { label: 'UV index', value: MISSING };
      const index = Math.round(conditions.uvIndex);
      const category = uvCategory(index);
      return {
        label: 'UV index',
        value: String(index),
        detail: category.label,
        tone: category.tone,
      };
    }
    case 'pressure':
      return { label: 'Pressure', value: formatPressure(conditions.pressureHpa, settings.units) };
    case 'gusts':
      return {
        label: 'Gusts',
        value: formatWindSpeed(conditions.windGustKmh, settings.windSpeedUnit),
      };
    case 'dew-point':
      return { label: 'Dew point', value: formatTemperature(conditions.dewPointC, settings.units) };
    case 'precipitation':
      return {
        label: 'Precipitation',
        value: formatPrecipitation(conditions.precipitationMm, settings.units),
      };
    case 'cloud-cover':
      return { label: 'Cloud cover', value: formatPercent(conditions.cloudCoverPercent) };
  }
}

export function buildAirFrame(input: FrameInput): ModuleFrameDraft | null {
  const { snapshot, settings, ctx, configurationError } = input;
  if (settings.airQualitySource === 'off' || configurationError) return null;

  const frame = base('weather-air', WEATHER_VIEW_AIR, settings, 'leaf');
  const air = displayableAir(snapshot, settings, ctx.now);
  const error = snapshot?.airError ?? null;

  if (!air) {
    const retained = snapshot?.air ?? null;
    if (retained) {
      // We have a reading; it is just too old. That is the monitor, not this app.
      return {
        ...frame,
        title: airTitle(retained, settings),
        badge: { text: 'offline', tone: 'amber' },
        layout: {
          kind: 'error',
          severity: 'warn',
          headline: 'Monitor not reporting',
          detail: 'The monitor has sent no reading recently. Check its power and Wi-Fi.',
          footer: `Last reading ${formatAge(ageSeconds(retained.observedAt, ctx.now))} ago`,
        },
      };
    }
    if (error) {
      return {
        ...frame,
        badge: { text: 'error', tone: 'red' },
        layout: {
          kind: 'error',
          severity: 'error',
          headline: 'Air quality unavailable',
          detail: error.message,
          code: error.code,
        },
      };
    }
    return {
      ...frame,
      layout: {
        kind: 'empty',
        icon: 'leaf',
        headline: 'Starting up',
        detail: 'Waiting for the first air quality reading',
      },
    };
  }

  const fetchedAge = snapshot?.lastAirSuccessAt
    ? ageSeconds(snapshot.lastAirSuccessAt, ctx.now)
    : null;
  const stale = error !== null && fetchedAge !== null && fetchedAge > staleAfterSeconds(settings);
  const category = air.usAqi === null ? null : aqiCategory(air.usAqi);
  const source = air.source === 'airgradient' ? AIRGRADIENT_ATTRIBUTION : OPEN_METEO_ATTRIBUTION;

  return {
    ...frame,
    title: airTitle(air, settings),
    ...(stale ? { badge: { text: 'stale', tone: 'amber' as const } } : {}),
    layout: {
      kind: 'hero',
      value: air.usAqi === null ? MISSING : String(air.usAqi),
      unit: 'US AQI',
      caption: category?.label ?? 'PM2.5 not reported',
      ...(category ? { tone: category.tone } : {}),
      supporting: airSupporting(air),
      footer: `${source} · ${formatAge(ageSeconds(air.observedAt, ctx.now))} ago`,
    },
  };
}

/** Up to three rows, measured gases first: those are what a modelled index cannot give. */
function airSupporting(air: AirQualityReading): SupportingItem[] {
  const rows: SupportingItem[] = [];
  if (air.pm25 !== null) rows.push({ label: 'PM2.5', value: `${air.pm25.toFixed(1)} µg/m³` });
  if (air.co2Ppm !== null) {
    rows.push({ label: 'CO₂', value: `${Math.round(air.co2Ppm)} ppm` });
  }
  if (air.tvocIndex !== null)
    rows.push({ label: 'TVOC index', value: String(Math.round(air.tvocIndex)) });
  if (air.noxIndex !== null)
    rows.push({ label: 'NOx index', value: String(Math.round(air.noxIndex)) });
  if (air.pm10 !== null) rows.push({ label: 'PM10', value: `${Math.round(air.pm10)} µg/m³` });
  return rows.slice(0, 3);
}

/**
 * Your own monitor's name ("Living room") says where the reading is from. A public
 * monitor's name is a stranger's address line, so the header keeps your label.
 */
function airTitle(air: AirQualityReading, settings: WeatherSettings): string {
  return settings.airQualitySource === 'airgradient'
    ? (air.locationName ?? settings.locationLabel)
    : settings.locationLabel;
}

function optional<K extends string>(key: K, value: string | null): { [P in K]?: string } {
  return (value === null ? {} : { [key]: value }) as { [P in K]?: string };
}
