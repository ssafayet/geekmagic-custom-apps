import type { JsonSchema, ModuleUiSchema } from '@gca/module-sdk';

/** Vault key for the AirGradient API token. */
export const AIRGRADIENT_TOKEN_SECRET = 'airGradientToken';

export type AirQualitySetting = 'open-meteo' | 'airgradient' | 'airgradient-public' | 'off';
export type ExtraReading =
  'uv' | 'pressure' | 'gusts' | 'dew-point' | 'precipitation' | 'cloud-cover';

export interface WeatherSettings {
  locationLabel: string;
  latitude: number;
  longitude: number;
  /** Temperature, pressure and precipitation. Wind has its own setting. */
  units: 'metric' | 'imperial';
  windSpeedUnit: 'kmh' | 'ms' | 'mph' | 'kn';
  airQualitySource: AirQualitySetting;
  /**
   * Which AirGradient location to read. With a token, null takes the account's first
   * monitor. A public monitor has no default, so it must be set.
   */
  airGradientLocationId: number | null;
  /** The fourth tile; the other three are humidity, wind and AQI. */
  extraReading: ExtraReading;
  pollIntervalSeconds: number;
  accent: 'cyan' | 'blue' | 'green' | 'amber' | 'purple' | 'magenta';
}

export const WEATHER_DEFAULT_SETTINGS: WeatherSettings = {
  locationLabel: 'Home',
  latitude: 0,
  longitude: 0,
  units: 'metric',
  windSpeedUnit: 'kmh',
  airQualitySource: 'open-meteo',
  airGradientLocationId: null,
  extraReading: 'uv',
  pollIntervalSeconds: 600,
  accent: 'cyan',
};

/** Open-Meteo recomputes current conditions every 15 minutes; polling faster buys nothing. */
export const WEATHER_MIN_POLL_SECONDS = 120;
export const WEATHER_MAX_POLL_SECONDS = 3600;

export const WEATHER_SETTINGS_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['locationLabel', 'latitude', 'longitude'],
  properties: {
    locationLabel: { type: 'string', minLength: 1, maxLength: 32, default: 'Home' },
    latitude: { type: 'number', minimum: -90, maximum: 90 },
    longitude: { type: 'number', minimum: -180, maximum: 180 },
    units: { type: 'string', enum: ['metric', 'imperial'], default: 'metric' },
    windSpeedUnit: { type: 'string', enum: ['kmh', 'ms', 'mph', 'kn'], default: 'kmh' },
    airQualitySource: {
      type: 'string',
      enum: ['open-meteo', 'airgradient', 'airgradient-public', 'off'],
      default: 'open-meteo',
    },
    airGradientLocationId: { type: ['integer', 'null'], minimum: 1, default: null },
    extraReading: {
      type: 'string',
      enum: ['uv', 'pressure', 'gusts', 'dew-point', 'precipitation', 'cloud-cover'],
      default: 'uv',
    },
    pollIntervalSeconds: {
      type: 'integer',
      minimum: WEATHER_MIN_POLL_SECONDS,
      maximum: WEATHER_MAX_POLL_SECONDS,
      default: 600,
    },
    accent: {
      type: 'string',
      enum: ['cyan', 'blue', 'green', 'amber', 'purple', 'magenta'],
      default: 'cyan',
    },
  },
};

export const WEATHER_UI_SCHEMA: ModuleUiSchema = {
  sections: [
    {
      id: 'location',
      title: 'Location',
      description:
        'These coordinates are sent to Open-Meteo with every poll. They are stored locally and rounded before they reach any log.',
    },
    {
      id: 'air',
      title: 'Air quality',
      description:
        'Open-Meteo gives a modelled outdoor index for your coordinates with no account. An AirGradient monitor gives a measured one for wherever it sits, indoors or out.',
    },
    { id: 'display', title: 'Display' },
  ],
  fields: {
    locationLabel: {
      section: 'location',
      order: 1,
      label: 'Label',
      widget: 'text',
      placeholder: 'Home',
      help: 'Shown in the panel header.',
    },
    latitude: {
      section: 'location',
      order: 2,
      label: 'Coordinates',
      widget: 'location',
      help: 'Use the button to read this browser’s location, or type the values.',
      actionId: 'weather.test',
    },
    longitude: { section: 'location', order: 3, label: 'Longitude', widget: 'number' },
    airQualitySource: {
      section: 'air',
      order: 1,
      label: 'Source',
      widget: 'select',
      options: [
        {
          value: 'open-meteo',
          label: 'Open-Meteo (modelled)',
          description: 'Free, no account. A forecast model of outdoor air at your coordinates.',
        },
        {
          value: 'airgradient',
          label: 'My AirGradient monitor',
          description:
            'Measured readings from your own monitor through the AirGradient cloud, including CO₂ and TVOC where it measures them. Needs an API token.',
        },
        {
          value: 'airgradient-public',
          label: 'Public AirGradient monitor',
          description:
            'Someone else’s outdoor monitor from the public AirGradient map, by location ID. No account. Test the source to find the nearest.',
        },
        { value: 'off', label: 'Off', description: 'No air quality tile or panel.' },
      ],
    },
    airGradientToken: {
      section: 'air',
      order: 2,
      label: 'AirGradient API token',
      widget: 'password',
      secret: true,
      help: 'In the AirGradient dashboard (app.airgradient.com), open the place settings, turn on API access under Connectivity and copy the token. Stored encrypted; only this module can read it.',
      visibleWhen: { field: 'airQualitySource', equals: ['airgradient'] },
    },
    airGradientLocationId: {
      section: 'air',
      order: 3,
      label: 'Location ID',
      widget: 'number',
      placeholder: 'e.g. 4217',
      help: 'For your own monitor, leave empty to use the first one on the account. For a public monitor it is required. Test the source to list candidates.',
      visibleWhen: { field: 'airQualitySource', equals: ['airgradient', 'airgradient-public'] },
    },
    units: {
      section: 'display',
      order: 1,
      label: 'Units',
      widget: 'select',
      options: [
        { value: 'metric', label: 'Metric (°C, hPa, mm)' },
        { value: 'imperial', label: 'Imperial (°F, inHg, in)' },
      ],
    },
    windSpeedUnit: {
      section: 'display',
      order: 2,
      label: 'Wind speed',
      widget: 'select',
      options: [
        { value: 'kmh', label: 'km/h' },
        { value: 'ms', label: 'm/s' },
        { value: 'mph', label: 'mph' },
        { value: 'kn', label: 'knots' },
      ],
    },
    extraReading: {
      section: 'display',
      order: 3,
      label: 'Fourth reading',
      widget: 'select',
      help: 'Humidity, wind and air quality are always shown; this picks the fourth tile.',
      options: [
        { value: 'uv', label: 'UV index' },
        { value: 'pressure', label: 'Pressure' },
        { value: 'gusts', label: 'Wind gusts' },
        { value: 'dew-point', label: 'Dew point' },
        { value: 'precipitation', label: 'Precipitation' },
        { value: 'cloud-cover', label: 'Cloud cover' },
      ],
    },
    pollIntervalSeconds: {
      section: 'display',
      order: 4,
      label: 'Poll interval',
      widget: 'duration',
      unit: 's',
      min: WEATHER_MIN_POLL_SECONDS,
      max: WEATHER_MAX_POLL_SECONDS,
      help: 'Open-Meteo updates current conditions every 15 minutes, so ten minutes loses nothing.',
    },
    accent: {
      section: 'display',
      order: 5,
      label: 'Accent colour',
      widget: 'select',
      options: [
        { value: 'cyan', label: 'Cyan' },
        { value: 'blue', label: 'Blue' },
        { value: 'green', label: 'Green' },
        { value: 'amber', label: 'Amber' },
        { value: 'purple', label: 'Purple' },
        { value: 'magenta', label: 'Magenta' },
      ],
    },
  },
  sectionActions: { air: ['weather.test'], display: ['core.refreshNow'] },
};
