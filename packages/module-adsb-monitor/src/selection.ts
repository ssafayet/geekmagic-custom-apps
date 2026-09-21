import { haversineDistanceNm, initialBearingDegrees, type GeoPoint } from '@gca/shared';
import type { AdsbSettings } from './settings.js';
import type { Aircraft, OverheadState, RankedAircraft } from './types.js';

export interface SelectionInput {
  aircraft: Aircraft[];
  observer: GeoPoint;
  settings: AdsbSettings;
  overheadState: Map<string, OverheadState>;
  now: Date;
}

export interface SelectionOutput {
  ranked: RankedAircraft[];
  overhead: RankedAircraft[];
  nearby: RankedAircraft[];
  /** Hex codes that crossed the enter threshold on this poll and were not already in. */
  newlyOverhead: string[];
  /** Hex codes that left the overhead state on this poll. */
  exitedOverhead: string[];
}

/** An aircraft must be missing this many consecutive polls before its state expires. */
const MISSED_POLL_LIMIT = 2;

/**
 * Filters, ranks and applies overhead hysteresis.
 *
 * Hysteresis is the whole point of this function: an aircraft becomes overhead at the
 * enter radius and stays overhead until it passes the (larger) exit radius, so a
 * target drifting along the boundary cannot flap the display back and forth.
 */
export function selectAircraft(input: SelectionInput): SelectionOutput {
  const { aircraft, observer, settings, overheadState, now } = input;
  const nowIso = now.toISOString();

  const ranked: RankedAircraft[] = [];
  for (const item of aircraft) {
    if (!passesFilters(item, settings)) continue;

    const distanceNm = haversineDistanceNm(observer, item);
    if (distanceNm > settings.searchRadiusNm) continue;

    const bearingDegrees = initialBearingDegrees(observer, item);
    const previous = overheadState.get(item.hex);
    const wasOverhead = previous !== undefined;
    const overhead = wasOverhead
      ? distanceNm < settings.overheadExitRadiusNm
      : distanceNm <= settings.overheadEnterRadiusNm;

    ranked.push({ ...item, distanceNm, bearingDegrees, overhead });
  }

  const newlyOverhead: string[] = [];
  const exitedOverhead: string[] = [];
  const seen = new Set<string>();

  for (const item of ranked) {
    seen.add(item.hex);
    const previous = overheadState.get(item.hex);
    if (item.overhead) {
      if (!previous) {
        overheadState.set(item.hex, {
          hex: item.hex,
          enteredAt: nowIso,
          lastSeenAt: nowIso,
          missedPolls: 0,
          announced: false,
        });
        newlyOverhead.push(item.hex);
      } else {
        previous.lastSeenAt = nowIso;
        previous.missedPolls = 0;
      }
    } else if (previous) {
      overheadState.delete(item.hex);
      exitedOverhead.push(item.hex);
    }
  }

  // Aircraft that vanished from the feed expire after two consecutive misses rather
  // than immediately, because a single dropped position report is common.
  for (const [hex, state] of overheadState) {
    if (seen.has(hex)) continue;
    state.missedPolls += 1;
    if (state.missedPolls >= MISSED_POLL_LIMIT) {
      overheadState.delete(hex);
      exitedOverhead.push(hex);
    }
  }

  ranked.sort(compareAircraft);
  const overhead = ranked.filter((item) => item.overhead);
  const nearby = ranked.filter((item) => !item.overhead);

  return { ranked, overhead, nearby, newlyOverhead, exitedOverhead };
}

/** Distance, then freshest position, then hex so the order never oscillates. */
export function compareAircraft(a: RankedAircraft, b: RankedAircraft): number {
  if (a.distanceNm !== b.distanceNm) return a.distanceNm - b.distanceNm;
  const ageA = a.positionAgeSeconds ?? Number.POSITIVE_INFINITY;
  const ageB = b.positionAgeSeconds ?? Number.POSITIVE_INFINITY;
  if (ageA !== ageB) return ageA - ageB;
  return a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0;
}

export function passesFilters(aircraft: Aircraft, settings: AdsbSettings): boolean {
  if (
    aircraft.positionAgeSeconds !== null &&
    aircraft.positionAgeSeconds > settings.maximumPositionAgeSeconds
  ) {
    return false;
  }
  if (settings.airborneOnly && aircraft.onGround) return false;

  if (settings.minimumAltitudeFt !== null || settings.maximumAltitudeFt !== null) {
    // An altitude filter can only be applied to an aircraft that reported one.
    if (aircraft.altitudeFt === null) return false;
    if (settings.minimumAltitudeFt !== null && aircraft.altitudeFt < settings.minimumAltitudeFt) {
      return false;
    }
    if (settings.maximumAltitudeFt !== null && aircraft.altitudeFt > settings.maximumAltitudeFt) {
      return false;
    }
  }
  return true;
}

/** Applies the user's selection mode to the ranked groups. */
export function applySelectionMode(
  output: SelectionOutput,
  settings: AdsbSettings,
): RankedAircraft[] {
  switch (settings.selectionMode) {
    case 'overhead-only':
      return output.overhead.slice(0, 1);
    case 'nearest':
      return output.ranked.slice(0, 1);
    case 'rotate':
      return output.ranked.slice(0, settings.maximumAircraftShown);
    case 'overhead-then-nearest':
    default:
      return output.overhead.length > 0 ? output.overhead.slice(0, 1) : output.ranked.slice(0, 1);
  }
}
