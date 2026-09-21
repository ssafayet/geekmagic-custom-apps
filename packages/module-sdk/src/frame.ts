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
