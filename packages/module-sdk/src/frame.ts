/**
 * The normalized display contract.
 *
 * Modules describe *what* to show; the renderer owns typography, spacing, safe areas,
 * colour resolution and encoding. No module supplies pixel coordinates, HTML or
 * JavaScript, which is what keeps the display pipeline safe and consistent.
 */

export const SEMANTIC_COLORS = [
  'purple',
  'blue',
  'cyan',
  'green',
  'amber',
  'orange',
  'red',
  'magenta',
  'slate',
] as const;
export type SemanticColor = (typeof SEMANTIC_COLORS)[number];

export type FramePriority = 'normal' | 'attention' | 'urgent';

export interface SupportingItem {
  label: string;
  value: string;
  tone?: SemanticColor;
}

export interface ProgressGauge {
  /** Short label such as `5H` or `7D`. */
  label: string;
  /** 0..100+, or null when the source did not report the window at all. */
  percent: number | null;
  /** Pre-formatted display value; `—` or `?` when unknown. */
  valueText: string;
  caption?: string;
  tone: SemanticColor;
}

export interface HeroFrameLayout {
  kind: 'hero';
  value: string;
  unit?: string;
  caption?: string;
  supporting?: SupportingItem[];
  footer?: string;
  tone?: SemanticColor;
}

export interface DualProgressFrameLayout {
  kind: 'dual-progress';
  /** The more constrained window is rendered as the hero value. */
  hero: { value: string; caption?: string; tone?: SemanticColor };
  gauges: ProgressGauge[];
  footer?: string;
}

export interface AircraftFrameLayout {
  kind: 'aircraft';
  state: 'overhead' | 'nearby';
  /** Callsign, else registration, else uppercase ICAO hex. */
  identifier: string;
  identifierSource: 'callsign' | 'registration' | 'hex';
  /**
   * Operator name for the callsign, when a route lookup resolved one.
   *
   * Drawn in the line under the identifier, which is the same line that names the
   * identifier's source. The two can never collide: the source hint only appears when
   * the identifier is not a callsign, and an airline can only be resolved from one.
   */
  airline?: string;
  /** Departure and arrival airports, short codes, resolved from the callsign. */
  route?: { origin: string | null; destination: string | null };
  distanceText: string;
  altitudeText: string;
  bearingDegrees: number | null;
  compass: string | null;
  verticalTrend: 'climbing' | 'descending' | 'level' | null;
  supporting: SupportingItem[];
  footer: string;
  attribution: string;
}

/** Condition glyphs the weather layout can draw. Modules pick one; they never draw. */
export const WEATHER_CONDITION_ICONS = [
  'clear-day',
  'clear-night',
  'partly-cloudy-day',
  'partly-cloudy-night',
  'cloudy',
  'fog',
  'drizzle',
  'rain',
  'snow',
  'thunderstorm',
] as const;
export type WeatherConditionIcon = (typeof WEATHER_CONDITION_ICONS)[number];

export interface WeatherTile {
  /** Short uppercase-able label such as `Humidity`. */
  label: string;
  /** Pre-formatted; `—` when the source did not report it. */
  value: string;
  /**
   * A word drawn after the value, such as an AQI category or a compass point. Carries
   * the meaning when `tone` is set, so state never rests on colour alone.
   */
  detail?: string;
  tone?: SemanticColor;
  /**
   * Draws a direction arrow before the value, rotated clockwise from straight up.
   * For wind this is the direction the air is moving *towards*, which is the opposite
   * of the meteorological "from" bearing that `detail` names.
   */
  arrowDegrees?: number;
}

export interface WeatherFrameLayout {
  kind: 'weather';
  /** `27°`. Units are the module's business; the renderer only draws the string. */
  temperatureText: string;
  condition: string;
  conditionIcon: WeatherConditionIcon;
  /** One muted line under the condition, e.g. `Feels 30° · H 31° L 24°`. */
  summary?: string;
  /** Up to four, drawn as a two-by-two grid in order. */
  tiles: WeatherTile[];
  /** Left footer: the data sources. */
  attribution: string;
  /** Right footer: the reading's age. */
  footer?: string;
}

export interface EmptyFrameLayout {
  kind: 'empty';
  icon: string;
  headline: string;
  detail?: string;
  footer?: string;
}

export interface ErrorFrameLayout {
  kind: 'error';
  severity: 'info' | 'warn' | 'error';
  headline: string;
  detail?: string;
  code?: string;
  footer?: string;
}

export type FrameLayout =
  | HeroFrameLayout
  | DualProgressFrameLayout
  | AircraftFrameLayout
  | WeatherFrameLayout
  | EmptyFrameLayout
  | ErrorFrameLayout;

export interface FrameBadge {
  text: string;
  tone: SemanticColor;
}

export interface ModuleFrame {
  id: string;
  viewId: string;
  title: string;
  icon?: string;
  accent: SemanticColor;
  priority: FramePriority;
  /** After this instant the frame is no longer safe to display as current. */
  validUntil: string;
  /** Stable hash of visible content; unchanged fingerprints never re-render. */
  fingerprint: string;
  /** Rendered as a small corner chip, e.g. `STALE`. Never the only signal of state. */
  badge?: FrameBadge;
  layout: FrameLayout;
}

/** Frames as produced by modules; the runtime fills in `fingerprint` and `validUntil`. */
export type ModuleFrameDraft = Omit<ModuleFrame, 'fingerprint' | 'validUntil'> & {
  validUntil?: string;
  fingerprint?: string;
};
