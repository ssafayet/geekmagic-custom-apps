import type { ModuleFrameDraft } from '@gca/module-sdk';

/**
 * The visual regression corpus.
 *
 * Every state the spec calls out has an entry here, including the awkward ones —
 * missing windows, a 100%+ spend limit, an unnamed aircraft, a stale snapshot — because
 * those are exactly the frames that silently regress.
 */
export interface FrameFixture {
  name: string;
  draft: ModuleFrameDraft;
}

const claude = (
  name: string,
  layout: Extract<ModuleFrameDraft['layout'], { kind: 'dual-progress' }>,
  badge?: ModuleFrameDraft['badge'],
): FrameFixture => ({
  name,
  draft: {
    id: name,
    viewId: 'rate-limits',
    title: 'Claude Usage',
    icon: 'sparkle',
    accent: 'purple',
    priority: 'normal',
    ...(badge ? { badge } : {}),
    layout,
  },
});

const adsb = (
  name: string,
  layout: ModuleFrameDraft['layout'],
  overrides: Partial<ModuleFrameDraft> = {},
): FrameFixture => ({
  name,
  draft: {
    id: name,
    viewId: 'aircraft',
    title: 'Nearby',
    icon: 'aircraft',
    accent: 'cyan',
    priority: 'normal',
    layout,
    ...overrides,
  },
});

const weather = (
  name: string,
  layout: ModuleFrameDraft['layout'],
  overrides: Partial<ModuleFrameDraft> = {},
): FrameFixture => ({
  name,
  draft: {
    id: name,
    viewId: 'current',
    title: 'Dhaka',
    icon: 'thermometer',
    accent: 'cyan',
    priority: 'normal',
    layout,
    ...overrides,
  },
});

export const FRAME_FIXTURES: FrameFixture[] = [
  claude('claude-usage-low', {
    kind: 'dual-progress',
    hero: { value: '18%', caption: '5-hour window resets in 2h 40m', tone: 'green' },
    gauges: [
      { label: '5H', percent: 18, valueText: '18%', caption: 'in 2h 40m', tone: 'green' },
      { label: '7D', percent: 11, valueText: '11%', caption: 'in 4d 6h', tone: 'green' },
    ],
    footer: 'Claude Sonnet 5 · 1m ago',
  }),
  claude('claude-usage-medium', {
    kind: 'dual-progress',
    hero: { value: '68%', caption: '7-day window resets in 3d 1h', tone: 'amber' },
    gauges: [
      { label: '5H', percent: 34, valueText: '34%', caption: 'in 1h 05m', tone: 'purple' },
      { label: '7D', percent: 68, valueText: '68%', caption: 'in 3d 1h', tone: 'amber' },
    ],
    footer: 'Claude Opus 5 · 4m ago',
  }),
  claude('claude-usage-high', {
    kind: 'dual-progress',
    hero: { value: '92%', caption: '5-hour window resets in 38m', tone: 'orange' },
    gauges: [
      { label: '5H', percent: 92, valueText: '92%', caption: 'in 38m', tone: 'orange' },
      { label: '7D', percent: 74, valueText: '74%', caption: 'in 1d 12h', tone: 'amber' },
    ],
    footer: 'Claude Opus 5 · now',
  }),
  claude('claude-usage-exhausted', {
    kind: 'dual-progress',
    hero: { value: '100%', caption: 'Limit reached · resets in 12m', tone: 'red' },
    gauges: [
      { label: '5H', percent: 100, valueText: '100%', caption: 'in 12m', tone: 'red' },
      { label: '7D', percent: 96, valueText: '96%', caption: 'in 20h', tone: 'orange' },
    ],
    footer: 'Claude Opus 5 · now',
  }),
  claude('claude-usage-missing-five-hour', {
    kind: 'dual-progress',
    hero: { value: '54%', caption: '7-day window resets in 2d', tone: 'purple' },
    gauges: [
      { label: '5H', percent: null, valueText: '—', caption: 'not reported', tone: 'slate' },
      { label: '7D', percent: 54, valueText: '54%', caption: 'in 2d', tone: 'purple' },
    ],
    footer: 'Claude Sonnet 5 · 3m ago',
  }),
  claude('claude-usage-missing-weekly', {
    kind: 'dual-progress',
    hero: { value: '61%', caption: '5-hour window resets in 55m', tone: 'amber' },
    gauges: [
      { label: '5H', percent: 61, valueText: '61%', caption: 'in 55m', tone: 'amber' },
      { label: '7D', percent: null, valueText: '—', caption: 'not reported', tone: 'slate' },
    ],
    footer: 'Claude Sonnet 5 · 3m ago',
  }),
  claude(
    'claude-usage-stale',
    {
      kind: 'dual-progress',
      hero: { value: '47%', caption: '5-hour window', tone: 'purple' },
      gauges: [
        { label: '5H', percent: 47, valueText: '47%', caption: 'in 1h 10m', tone: 'purple' },
        { label: '7D', percent: 39, valueText: '39%', caption: 'in 5d', tone: 'purple' },
      ],
      footer: 'Last update 46m ago',
    },
    { text: 'stale', tone: 'amber' },
  ),
  claude('claude-usage-spend-over-limit', {
    kind: 'dual-progress',
    hero: { value: '118%', caption: 'Spend limit exceeded', tone: 'red' },
    gauges: [
      { label: '7D', percent: 83, valueText: '83%', caption: 'in 2d', tone: 'amber' },
      { label: 'SPEND', percent: 118, valueText: '118%', caption: 'over limit', tone: 'red' },
    ],
    footer: 'Claude Opus 5 · 2m ago',
  }),
  {
    name: 'claude-api-cost',
    draft: {
      id: 'claude-api-cost',
      viewId: 'api-cost',
      title: 'Claude API',
      icon: 'cost',
      accent: 'blue',
      priority: 'normal',
      layout: {
        kind: 'hero',
        value: '$41.27',
        caption: 'Cost today',
        supporting: [
          { label: 'Input', value: '4.2M' },
          { label: 'Output', value: '318K' },
          { label: '7-day cost', value: '$212.40' },
        ],
        footer: 'Organization usage · 1m ago',
      },
    },
  },
  {
    name: 'claude-waiting',
    draft: {
      id: 'claude-waiting',
      viewId: 'rate-limits',
      title: 'Claude Usage',
      icon: 'sparkle',
      accent: 'purple',
      priority: 'normal',
      layout: {
        kind: 'empty',
        icon: 'clock',
        headline: 'Waiting for Claude',
        detail: 'Usage appears after Claude Code makes a request',
        footer: 'Bridge connected',
      },
    },
  },
  {
    name: 'claude-setup-required',
    draft: {
      id: 'claude-setup-required',
      viewId: 'rate-limits',
      title: 'Claude Usage',
      icon: 'sparkle',
      accent: 'purple',
      priority: 'normal',
      layout: {
        kind: 'error',
        severity: 'info',
        headline: 'Setup required',
        detail: 'Install the status-line bridge or add an organization usage credential',
        code: 'CLAUDE_BRIDGE_NOT_CONNECTED',
      },
    },
  },
  adsb(
    'adsb-overhead',
    {
      kind: 'aircraft',
      state: 'overhead',
      identifier: 'BAW117',
      identifierSource: 'callsign',
      distanceText: '1.4 NM',
      altitudeText: '12,350 ft',
      bearingDegrees: 214,
      compass: 'SW',
      verticalTrend: 'climbing',
      supporting: [
        { label: 'Reg / Type', value: 'G-STBA · B77W' },
        { label: 'Speed', value: '287 kt' },
      ],
      footer: '3s ago',
      attribution: 'Data: adsb.fi',
    },
    { title: 'Overhead', priority: 'attention' },
  ),
  adsb(
    'adsb-overhead-with-route',
    {
      kind: 'aircraft',
      state: 'overhead',
      identifier: 'BAW117',
      identifierSource: 'callsign',
      airline: 'British Airways',
      route: { origin: 'LHR', destination: 'JFK' },
      distanceText: '1.4 NM',
      altitudeText: '12,350 ft',
      bearingDegrees: 214,
      compass: 'SW',
      verticalTrend: 'climbing',
      supporting: [
        { label: 'Reg / Type', value: 'G-STBA · B77W' },
        { label: 'Speed', value: '287 kt' },
      ],
      footer: '3s ago',
      attribution: 'Data: adsb.fi · adsbdb',
    },
    { title: 'Overhead', priority: 'attention' },
  ),
  // The widest the row gets: a long operator and two four-letter ICAO codes.
  adsb('adsb-route-icao-codes', {
    kind: 'aircraft',
    state: 'nearby',
    identifier: 'SWEDESTAR991',
    identifierSource: 'callsign',
    airline: 'Singapore Airlines Cargo',
    route: { origin: 'WSSS', destination: 'EGLL' },
    distanceText: '14.2 NM',
    altitudeText: '31,975 ft',
    bearingDegrees: 312,
    compass: 'NW',
    verticalTrend: 'descending',
    supporting: [
      { label: 'Reg / Type', value: 'SE-RJX · A20N' },
      { label: 'Speed', value: '455 kt' },
    ],
    footer: '6s ago',
    attribution: 'Data: adsb.fi · adsbdb',
  }),
  // Half a route is still worth drawing, and the missing end must not read as zero.
  adsb('adsb-route-one-end-known', {
    kind: 'aircraft',
    state: 'nearby',
    identifier: 'FDX1234',
    identifierSource: 'callsign',
    airline: 'FedEx Express',
    route: { origin: 'MEM', destination: null },
    distanceText: '7.1 NM',
    altitudeText: '8,200 ft',
    bearingDegrees: 95,
    compass: 'E',
    verticalTrend: 'descending',
    supporting: [
      { label: 'Reg / Type', value: 'N103FE · MD11' },
      { label: 'Speed', value: '243 kt' },
    ],
    footer: '4s ago',
    attribution: 'Data: adsb.fi · adsbdb',
  }),
  adsb('adsb-nearby', {
    kind: 'aircraft',
    state: 'nearby',
    identifier: 'RYR42XK',
    identifierSource: 'callsign',
    distanceText: '9.8 NM',
    altitudeText: '24,000 ft',
    bearingDegrees: 47,
    compass: 'NE',
    verticalTrend: 'level',
    supporting: [
      { label: 'Reg / Type', value: 'EI-DYK · B738' },
      { label: 'Speed', value: '412 kt' },
    ],
    footer: '11s ago',
    attribution: 'Data: adsb.fi',
  }),
  adsb('adsb-long-callsign', {
    kind: 'aircraft',
    state: 'nearby',
    identifier: 'SWEDESTAR991',
    identifierSource: 'callsign',
    distanceText: '14.2 NM',
    altitudeText: '31,975 ft',
    bearingDegrees: 312,
    compass: 'NW',
    verticalTrend: 'descending',
    supporting: [
      { label: 'Reg / Type', value: 'SE-RJX · A20N' },
      { label: 'Speed', value: '455 kt' },
    ],
    footer: '6s ago',
    attribution: 'Data: adsb.fi',
  }),
  adsb('adsb-missing-metadata', {
    kind: 'aircraft',
    state: 'nearby',
    identifier: 'A0F1C9',
    identifierSource: 'hex',
    distanceText: '18.2 NM',
    altitudeText: '—',
    bearingDegrees: null,
    compass: null,
    verticalTrend: null,
    supporting: [{ label: 'Reg / Type', value: 'Unknown' }],
    footer: '22s ago',
    attribution: 'Data: adsb.fi',
  }),
  adsb('adsb-clear-sky', {
    kind: 'empty',
    icon: 'radar',
    headline: 'No traffic',
    detail: 'Nothing within 25 NM of Home',
    footer: 'Data: adsb.fi · 8s ago',
  }),
  adsb(
    'adsb-stale',
    {
      kind: 'aircraft',
      state: 'nearby',
      identifier: 'DLH8AT',
      identifierSource: 'callsign',
      distanceText: '12.0 NM',
      altitudeText: '18,200 ft',
      bearingDegrees: 132,
      compass: 'SE',
      verticalTrend: 'level',
      supporting: [
        { label: 'Reg / Type', value: 'D-AIBL · A319' },
        { label: 'Speed', value: '331 kt' },
      ],
      footer: '2m ago',
      attribution: 'Data: adsb.fi',
    },
    { badge: { text: 'stale', tone: 'amber' } },
  ),
  adsb(
    'adsb-offline',
    {
      kind: 'error',
      severity: 'error',
      headline: 'ADS-B offline',
      detail: 'Provider unreachable for 4m',
      code: 'ADSB_PROVIDER_UNAVAILABLE',
      footer: 'Last success 4m ago',
    },
    { badge: { text: 'offline', tone: 'red' }, title: 'ADS-B' },
  ),
  adsb(
    'adsb-rate-limited',
    {
      kind: 'error',
      severity: 'warn',
      headline: 'Rate limited',
      detail: 'Provider asked us to wait 30s',
      code: 'ADSB_PROVIDER_RATE_LIMITED',
      footer: 'Data: adsb.fi',
    },
    { badge: { text: 'wait', tone: 'amber' }, title: 'ADS-B' },
  ),
  adsb(
    'adsb-config-invalid',
    {
      kind: 'error',
      severity: 'error',
      headline: 'Location invalid',
      detail: 'Set a latitude and longitude in module settings',
      code: 'ADSB_LOCATION_INVALID',
    },
    { title: 'ADS-B' },
  ),
  weather('weather-clear-day', {
    kind: 'weather',
    temperatureText: '32°',
    condition: 'Clear',
    conditionIcon: 'clear-day',
    summary: 'Feels 37° · H 35° L 26°',
    tiles: [
      { label: 'Humidity', value: '56%' },
      { label: 'Wind', value: '4 km/h', detail: 'E', arrowDegrees: 270 },
      { label: 'AQI', value: '172', detail: 'Unhealthy', tone: 'red' },
      { label: 'UV index', value: '3', detail: 'Moderate', tone: 'amber' },
    ],
    attribution: 'Open-Meteo',
    footer: '2m ago',
  }),
  weather(
    'weather-night-imperial',
    {
      kind: 'weather',
      temperatureText: '53°',
      condition: 'Mainly clear',
      conditionIcon: 'clear-night',
      summary: 'Feels 46° · H 71° L 55°',
      tiles: [
        { label: 'Humidity', value: '49%' },
        { label: 'Wind', value: '7 mph', detail: 'NNW', arrowDegrees: 151 },
        { label: 'Pressure', value: '30.08 inHg' },
        { label: 'UV index', value: '0', detail: 'Low', tone: 'green' },
      ],
      attribution: 'Open-Meteo',
      footer: '1m ago',
    },
    { title: 'Brooklyn', accent: 'blue' },
  ),
  // Every awkward length at once: a negative three-digit-wide temperature, a condition
  // that must ellipsize, a gale, a missing AQI and a monitor-sourced label.
  weather(
    'weather-extremes-and-missing',
    {
      kind: 'weather',
      temperatureText: '-12°',
      condition: 'Heavy snow showers with drifting',
      conditionIcon: 'snow',
      tiles: [
        { label: 'Humidity', value: '—' },
        { label: 'Wind', value: '112 km/h', detail: 'WSW', arrowDegrees: 67 },
        { label: 'AQI · sensor', value: '—' },
        { label: 'Gusts', value: '148 km/h' },
      ],
      attribution: 'Open-Meteo · AirGradient',
      footer: '3h 5m ago',
    },
    { title: 'Reykjavík', badge: { text: 'stale', tone: 'amber' } },
  ),
  weather('weather-thunderstorm', {
    kind: 'weather',
    temperatureText: '24°',
    condition: 'Heavy thunderstorm',
    conditionIcon: 'thunderstorm',
    summary: 'Feels 27° · H 29° L 22°',
    tiles: [
      { label: 'Humidity', value: '94%' },
      { label: 'Wind', value: '9.4 m/s', detail: 'SSE', arrowDegrees: 340 },
      { label: 'AQI', value: '38', detail: 'Good', tone: 'green' },
      { label: 'Precipitation', value: '6.2 mm' },
    ],
    attribution: 'Open-Meteo',
    footer: '4m ago',
  }),
  weather(
    'weather-air-monitor',
    {
      kind: 'hero',
      value: '23',
      unit: 'US AQI',
      caption: 'Good',
      tone: 'green',
      supporting: [
        { label: 'PM2.5', value: '4.1 µg/m³' },
        { label: 'CO₂', value: '640 ppm' },
        { label: 'TVOC index', value: '87' },
      ],
      footer: 'AirGradient · 1m ago',
    },
    { viewId: 'air-quality', title: 'Living room', icon: 'leaf' },
  ),
  weather(
    'weather-air-sensitive',
    {
      kind: 'hero',
      value: '128',
      unit: 'US AQI',
      caption: 'Unhealthy (sensitive)',
      tone: 'orange',
      supporting: [
        { label: 'PM2.5', value: '46.2 µg/m³' },
        { label: 'PM10', value: '71 µg/m³' },
      ],
      footer: 'Open-Meteo · 38m ago',
    },
    { viewId: 'air-quality', icon: 'leaf' },
  ),
];

export function fixtureByName(name: string): FrameFixture {
  const found = FRAME_FIXTURES.find((fixture) => fixture.name === name);
  if (!found) throw new Error(`Unknown frame fixture: ${name}`);
  return found;
}
