/**
 * Current conditions, always in metric.
 *
 * Providers are asked for metric and the frames convert, so a units change in the
 * settings is a re-render rather than a refetch, and the snapshot means one thing.
 * Every field is independently nullable: a model that omits a variable shows `—`.
 */
export interface CurrentConditions {
  /** When the provider says the values are valid for, as UTC ISO. */
  observedAt: string;
  temperatureC: number | null;
  apparentTemperatureC: number | null;
  relativeHumidityPercent: number | null;
  dewPointC: number | null;
  windSpeedKmh: number | null;
  windGustKmh: number | null;
  /** Meteorological convention: the bearing the wind blows *from*. */
  windDirectionDegrees: number | null;
  /** WMO weather interpretation code. */
  weatherCode: number | null;
  isDay: boolean | null;
  uvIndex: number | null;
  pressureHpa: number | null;
  precipitationMm: number | null;
  cloudCoverPercent: number | null;
  todayMaxC: number | null;
  todayMinC: number | null;
}

export type AirQualitySourceId = 'open-meteo' | 'airgradient';

export interface AirQualityReading {
  source: AirQualitySourceId;
  observedAt: string;
  /** US EPA index, 0..500. Reported by Open-Meteo; computed from PM2.5 for AirGradient. */
  usAqi: number | null;
  pm25: number | null;
  pm10: number | null;
  /** Monitor-only readings. A model reports none of these, so they stay null there. */
  co2Ppm: number | null;
  tvocIndex: number | null;
  noxIndex: number | null;
  /** The monitor's own name for itself, e.g. `Living room`. */
  locationName: string | null;
}

export interface SourceError {
  code: string;
  message: string;
  at: string;
}

export interface WeatherSnapshot {
  capturedAt: string;
  conditions: CurrentConditions | null;
  air: AirQualityReading | null;
  /** Null on success; set when the last fetch failed and an older reading is retained. */
  weatherError: SourceError | null;
  airError: SourceError | null;
  lastWeatherSuccessAt: string | null;
  lastAirSuccessAt: string | null;
  /**
   * What each half was fetched for — coordinates, source, monitor. A restart or a
   * settings change rehydrates the persisted snapshot, and without these the old
   * city's temperature would show under the new label until the next poll succeeds.
   */
  weatherKey: string | null;
  airKey: string | null;
}

export interface WeatherQuery {
  latitude: number;
  longitude: number;
}
