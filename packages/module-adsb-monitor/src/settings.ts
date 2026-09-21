import type { JsonSchema, ModuleUiSchema } from '@gca/module-sdk';

export type AdsbProviderId = 'adsb-fi' | 'opensky';

/** Vault keys for the OpenSky OAuth2 client credentials. */
export const OPENSKY_CLIENT_ID_SECRET = 'openSkyClientId';
export const OPENSKY_CLIENT_SECRET_SECRET = 'openSkyClientSecret';

export interface AdsbSettings {
  provider: AdsbProviderId;
  locationLabel: string;
  latitude: number;
  longitude: number;
  searchRadiusNm: number;
  overheadEnterRadiusNm: number;
  overheadExitRadiusNm: number;
  pollIntervalSeconds: number;
  maximumPositionAgeSeconds: number;
  airborneOnly: boolean;
  /** Look the callsign up for an operator name and a route. Costs a second source. */
  routeLookup: boolean;
  minimumAltitudeFt: number | null;
  maximumAltitudeFt: number | null;
  selectionMode: 'overhead-only' | 'nearest' | 'overhead-then-nearest' | 'rotate';
  maximumAircraftShown: number;
  overheadInterrupt: boolean;
  interruptHoldSeconds: number;
  units: 'aviation' | 'metric';
  accent: 'cyan' | 'blue' | 'green' | 'amber' | 'purple' | 'magenta';
}

export const ADSB_DEFAULT_SETTINGS: AdsbSettings = {
  provider: 'adsb-fi',
  locationLabel: 'Home',
  latitude: 0,
  longitude: 0,
  searchRadiusNm: 25,
  overheadEnterRadiusNm: 3,
  overheadExitRadiusNm: 4,
  pollIntervalSeconds: 15,
  maximumPositionAgeSeconds: 45,
  airborneOnly: true,
  routeLookup: true,
  minimumAltitudeFt: null,
  maximumAltitudeFt: null,
  selectionMode: 'overhead-then-nearest',
  maximumAircraftShown: 3,
  overheadInterrupt: true,
  interruptHoldSeconds: 30,
  units: 'aviation',
  accent: 'cyan',
};

export const ADSB_SETTINGS_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['locationLabel', 'latitude', 'longitude', 'searchRadiusNm'],
  properties: {
    provider: { type: 'string', enum: ['adsb-fi', 'opensky'], default: 'adsb-fi' },
    locationLabel: { type: 'string', minLength: 1, maxLength: 32, default: 'Home' },
    latitude: { type: 'number', minimum: -90, maximum: 90 },
    longitude: { type: 'number', minimum: -180, maximum: 180 },
    searchRadiusNm: { type: 'number', minimum: 1, maximum: 250, default: 25 },
    overheadEnterRadiusNm: { type: 'number', minimum: 0.2, maximum: 25, default: 3 },
    overheadExitRadiusNm: { type: 'number', minimum: 0.2, maximum: 50, default: 4 },
    pollIntervalSeconds: { type: 'integer', minimum: 2, maximum: 300, default: 15 },
    maximumPositionAgeSeconds: { type: 'integer', minimum: 5, maximum: 300, default: 45 },
    airborneOnly: { type: 'boolean', default: true },
    routeLookup: { type: 'boolean', default: true },
    minimumAltitudeFt: { type: ['integer', 'null'], minimum: -1500, maximum: 60000, default: null },
    maximumAltitudeFt: { type: ['integer', 'null'], minimum: -1500, maximum: 60000, default: null },
    selectionMode: {
      type: 'string',
      enum: ['overhead-only', 'nearest', 'overhead-then-nearest', 'rotate'],
      default: 'overhead-then-nearest',
    },
    maximumAircraftShown: { type: 'integer', minimum: 1, maximum: 10, default: 3 },
    overheadInterrupt: { type: 'boolean', default: true },
    interruptHoldSeconds: { type: 'integer', minimum: 10, maximum: 300, default: 30 },
    units: { type: 'string', enum: ['aviation', 'metric'], default: 'aviation' },
    accent: {
      type: 'string',
      enum: ['cyan', 'blue', 'green', 'amber', 'purple', 'magenta'],
      default: 'cyan',
    },
  },
};

export const ADSB_UI_SCHEMA: ModuleUiSchema = {
  sections: [
    {
      id: 'provider',
      title: 'Data source',
      description:
        'Community aggregators depend on volunteer receivers nearby. If your area has none, they return nothing and OpenSky is the better choice.',
    },
    {
      id: 'location',
      title: 'Location',
      description:
        'These coordinates are sent to the ADS-B provider with every poll. They are stored locally and rounded before they reach any log.',
    },
    { id: 'coverage', title: 'Coverage and filters' },
    { id: 'behaviour', title: 'Display behaviour' },
  ],
  fields: {
    provider: {
      section: 'provider',
      order: 1,
      label: 'Provider',
      widget: 'select',
      options: [
        {
          value: 'adsb-fi',
          label: 'adsb.fi (community)',
          description: 'Free, no account. Coverage depends on volunteer feeders near you.',
        },
        {
          value: 'opensky',
          label: 'OpenSky Network',
          description:
            'Broader coverage in many regions, but a daily request budget and no registration or aircraft type.',
        },
      ],
      actionId: 'adsb.testLocation',
    },
    openSkyClientId: {
      section: 'provider',
      order: 2,
      label: 'OpenSky client ID',
      widget: 'password',
      secret: true,
      help: 'Optional. Without credentials OpenSky allows about 400 requests a day, which forces a slow poll.',
      visibleWhen: { field: 'provider', equals: ['opensky'] },
    },
    openSkyClientSecret: {
      section: 'provider',
      order: 3,
      label: 'OpenSky client secret',
      widget: 'password',
      secret: true,
      visibleWhen: { field: 'provider', equals: ['opensky'] },
    },
    locationLabel: {
      section: 'location',
      order: 1,
      label: 'Label',
      widget: 'text',
      placeholder: 'Home',
      help: 'Shown on the clear-sky frame.',
    },
    latitude: {
      section: 'location',
      order: 2,
      label: 'Coordinates',
      widget: 'location',
      help: 'Use the button to read this browser’s location, or type the values.',
    },
    longitude: { section: 'location', order: 3, label: 'Longitude', widget: 'number' },
    searchRadiusNm: {
      section: 'coverage',
      order: 1,
      label: 'Search radius',
      widget: 'slider',
      unit: 'NM',
      min: 1,
      max: 250,
      step: 1,
      help: 'The provider supports up to 250 NM.',
    },
    overheadEnterRadiusNm: {
      section: 'coverage',
      order: 2,
      label: 'Overhead enters at',
      widget: 'number',
      unit: 'NM',
      min: 0.2,
      max: 25,
      step: 0.1,
    },
    overheadExitRadiusNm: {
      section: 'coverage',
      order: 3,
      label: 'Overhead exits at',
      widget: 'number',
      unit: 'NM',
      min: 0.2,
      max: 50,
      step: 0.1,
      help: 'Must exceed the enter radius. The gap prevents the display flickering at the threshold.',
    },
    airborneOnly: {
      section: 'coverage',
      order: 4,
      label: 'Airborne only',
      widget: 'switch',
      help: 'Excludes aircraft reporting as on the ground.',
    },
    routeLookup: {
      section: 'provider',
      order: 4,
      label: 'Airline and route',
      widget: 'switch',
      help: 'Aircraft broadcast a callsign but not their operator or route. Looking those up sends the callsign — nothing else, and never your location — to api.adsbdb.com. Answers are cached, so a busy sky costs a handful of requests an hour. Off, the panel shows what the aircraft itself transmits.',
    },
    minimumAltitudeFt: {
      section: 'coverage',
      order: 5,
      label: 'Minimum altitude',
      widget: 'number',
      unit: 'ft',
    },
    maximumAltitudeFt: {
      section: 'coverage',
      order: 6,
      label: 'Maximum altitude',
      widget: 'number',
      unit: 'ft',
    },
    maximumPositionAgeSeconds: {
      section: 'coverage',
      order: 7,
      label: 'Discard positions older than',
      widget: 'duration',
      unit: 's',
      min: 5,
      max: 300,
    },
    pollIntervalSeconds: {
      section: 'behaviour',
      order: 1,
      label: 'Poll interval',
      widget: 'duration',
      unit: 's',
      min: 2,
      max: 300,
      help: 'The provider rate-limits public endpoints to one request per second.',
    },
    selectionMode: {
      section: 'behaviour',
      order: 2,
      label: 'Which aircraft to show',
      widget: 'select',
      options: [
        { value: 'overhead-then-nearest', label: 'Overhead, else nearest' },
        { value: 'overhead-only', label: 'Overhead only' },
        { value: 'nearest', label: 'Nearest' },
        { value: 'rotate', label: 'Rotate through several' },
      ],
    },
    maximumAircraftShown: {
      section: 'behaviour',
      order: 3,
      label: 'Aircraft in rotation',
      widget: 'number',
      min: 1,
      max: 10,
      visibleWhen: { field: 'selectionMode', equals: ['rotate'] },
    },
    overheadInterrupt: {
      section: 'behaviour',
      order: 4,
      label: 'Interrupt other modules when overhead',
      widget: 'switch',
    },
    interruptHoldSeconds: {
      section: 'behaviour',
      order: 5,
      label: 'Hold interruption for',
      widget: 'duration',
      unit: 's',
      min: 10,
      max: 300,
      visibleWhen: { field: 'overheadInterrupt', equals: [true] },
    },
    units: {
      section: 'behaviour',
      order: 6,
      label: 'Units',
      widget: 'select',
      options: [
        { value: 'aviation', label: 'Aviation (NM, ft, kt)' },
        { value: 'metric', label: 'Metric (km, m, km/h)' },
      ],
    },
    accent: {
      section: 'behaviour',
      order: 7,
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
  sectionActions: { provider: ['adsb.testLocation'], behaviour: ['core.refreshNow'] },
};
