import type { WeatherConditionIcon } from '@gca/module-sdk';

interface Condition {
  label: string;
  /** Glyph by day; night swaps sun for moon where the sky is what is being described. */
  icon: WeatherConditionIcon;
}

/**
 * WMO weather interpretation codes, as Open-Meteo documents them.
 *
 * Labels are short because the panel has one line for this. Freezing variants keep the
 * word "freezing", since that is the part a viewer acts on.
 */
const CONDITIONS: Record<number, Condition> = {
  0: { label: 'Clear', icon: 'clear-day' },
  1: { label: 'Mainly clear', icon: 'clear-day' },
  2: { label: 'Partly cloudy', icon: 'partly-cloudy-day' },
  3: { label: 'Overcast', icon: 'cloudy' },
  45: { label: 'Fog', icon: 'fog' },
  48: { label: 'Freezing fog', icon: 'fog' },
  51: { label: 'Light drizzle', icon: 'drizzle' },
  53: { label: 'Drizzle', icon: 'drizzle' },
  55: { label: 'Heavy drizzle', icon: 'drizzle' },
  56: { label: 'Freezing drizzle', icon: 'drizzle' },
  57: { label: 'Freezing drizzle', icon: 'drizzle' },
  61: { label: 'Light rain', icon: 'rain' },
  63: { label: 'Rain', icon: 'rain' },
  65: { label: 'Heavy rain', icon: 'rain' },
  66: { label: 'Freezing rain', icon: 'rain' },
  67: { label: 'Freezing rain', icon: 'rain' },
  71: { label: 'Light snow', icon: 'snow' },
  73: { label: 'Snow', icon: 'snow' },
  75: { label: 'Heavy snow', icon: 'snow' },
  77: { label: 'Snow grains', icon: 'snow' },
  80: { label: 'Light showers', icon: 'rain' },
  81: { label: 'Showers', icon: 'rain' },
  82: { label: 'Violent showers', icon: 'rain' },
  85: { label: 'Snow showers', icon: 'snow' },
  86: { label: 'Heavy snow showers', icon: 'snow' },
  95: { label: 'Thunderstorm', icon: 'thunderstorm' },
  96: { label: 'Thunderstorm, hail', icon: 'thunderstorm' },
  // Newer than the table most libraries copy; Open-Meteo documents it today.
  97: { label: 'Heavy thunderstorm', icon: 'thunderstorm' },
  99: { label: 'Thunderstorm, hail', icon: 'thunderstorm' },
};

const NIGHT_ICON: Partial<Record<WeatherConditionIcon, WeatherConditionIcon>> = {
  'clear-day': 'clear-night',
  'partly-cloudy-day': 'partly-cloudy-night',
};

/**
 * Label and glyph for a code. An unknown or missing code says so rather than guessing:
 * a cloud with "Unknown" is honest, a sun would be a claim.
 */
export function describeCondition(
  code: number | null,
  isDay: boolean | null,
): { label: string; icon: WeatherConditionIcon } {
  const condition = code === null ? undefined : CONDITIONS[code];
  if (!condition) return { label: 'Conditions unknown', icon: 'cloudy' };
  // `isDay` unknown is treated as day: the day glyph is the more familiar default.
  const icon = isDay === false ? (NIGHT_ICON[condition.icon] ?? condition.icon) : condition.icon;
  return { label: condition.label, icon };
}
