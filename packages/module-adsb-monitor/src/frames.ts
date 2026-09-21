import {
  ageSeconds,
  bearingToCompass,
  feetToMetres,
  formatAge,
  knotsToKmh,
  nmToKm,
} from '@gca/shared';
import type {
  FrameContext,
  ModuleFrameDraft,
  SemanticColor,
  SupportingItem,
} from '@gca/module-sdk';
import { ADSBDB_ATTRIBUTION } from './route-lookup.js';
import type { AdsbSettings } from './settings.js';
import type { AdsbSnapshot, RankedAircraft } from './types.js';

export const ADSB_VIEW_AIRCRAFT = 'aircraft';
export const ADSB_VIEW_OVERHEAD = 'overhead';

export interface FrameInput {
  snapshot: AdsbSnapshot | null;
  selected: RankedAircraft[];
  settings: AdsbSettings;
  ctx: FrameContext;
  /** True when the snapshot is older than tolerance but still being displayed. */
  stale: boolean;
  configurationError: string | null;
}

export function buildAdsbFrames(input: FrameInput): ModuleFrameDraft[] {
  const { snapshot, selected, settings, ctx, stale, configurationError } = input;
  const accent = settings.accent as SemanticColor;

  if (configurationError) {
    return [
      {
        id: 'adsb-config',
        viewId: ADSB_VIEW_AIRCRAFT,
        title: 'ADS-B',
        icon: 'radar',
        accent,
        priority: 'normal',
        layout: {
          kind: 'error',
          severity: 'error',
          headline: 'Location invalid',
          detail: configurationError,
          code: 'ADSB_LOCATION_INVALID',
        },
      },
    ];
  }

  if (!snapshot) {
    return [
      {
        id: 'adsb-starting',
        viewId: ADSB_VIEW_AIRCRAFT,
        title: 'ADS-B',
        icon: 'radar',
        accent,
        priority: 'normal',
        layout: {
          kind: 'empty',
          icon: 'radar',
          headline: 'Starting up',
          detail: `Waiting for the first poll of ${settings.locationLabel}`,
        },
      },
    ];
  }

  // A provider failure only reaches the display once the retained snapshot has aged
  // past tolerance; before that the last good aircraft keeps showing with a badge.
  if (snapshot.error && stale) {
    const lastSuccess = snapshot.lastSuccessAt
      ? `Last success ${formatAge(ageSeconds(snapshot.lastSuccessAt, ctx.now))} ago`
      : 'No successful poll yet';
    const rateLimited = snapshot.error.code === 'ADSB_PROVIDER_RATE_LIMITED';
    return [
      {
        id: 'adsb-offline',
        viewId: ADSB_VIEW_AIRCRAFT,
        title: 'ADS-B',
        icon: 'radar',
        accent,
        priority: 'normal',
        badge: { text: rateLimited ? 'wait' : 'offline', tone: rateLimited ? 'amber' : 'red' },
        layout: {
          kind: 'error',
          severity: rateLimited ? 'warn' : 'error',
          headline: rateLimited ? 'Rate limited' : 'ADS-B offline',
          detail: snapshot.error.message,
          code: snapshot.error.code,
          footer: lastSuccess,
        },
      },
    ];
  }

  if (selected.length === 0) {
    const radius =
      settings.units === 'metric'
        ? `${Math.round(nmToKm(settings.searchRadiusNm))} km`
        : `${settings.searchRadiusNm} NM`;
    return [
      {
        id: 'adsb-clear',
        viewId: ADSB_VIEW_AIRCRAFT,
        title: 'ADS-B',
        icon: 'radar',
        accent,
        priority: 'normal',
        ...(stale ? { badge: { text: 'stale', tone: 'amber' as const } } : {}),
        layout: {
          kind: 'empty',
          icon: 'radar',
          headline: 'No traffic',
          detail: `Nothing within ${radius} of ${settings.locationLabel}`,
          footer: `${snapshot.attribution} · ${formatAge(ageSeconds(snapshot.observedAt, ctx.now))} ago`,
        },
      },
    ];
  }

  return selected.map((aircraft, index) =>
    buildAircraftFrame(aircraft, index, snapshot, settings, ctx, stale),
  );
}

export function buildAircraftFrame(
  aircraft: RankedAircraft,
  index: number,
  snapshot: AdsbSnapshot,
  settings: AdsbSettings,
  ctx: FrameContext,
  stale: boolean,
): ModuleFrameDraft {
  const metric = settings.units === 'metric';
  const identifier = pickIdentifier(aircraft);
  const ageLabel = formatAge(
    aircraft.positionAgeSeconds ?? ageSeconds(snapshot.observedAt, ctx.now),
  );

  const supporting: SupportingItem[] = [];
  const registrationAndType = [aircraft.registration, aircraft.typeCode]
    .filter(Boolean)
    .join(' · ');
  supporting.push({ label: 'Reg / Type', value: registrationAndType || 'Unknown' });

  if (aircraft.groundSpeedKt !== null) {
    supporting.push({
      label: 'Speed',
      value: metric
        ? `${Math.round(knotsToKmh(aircraft.groundSpeedKt))} km/h`
        : `${Math.round(aircraft.groundSpeedKt)} kt`,
    });
  } else if (aircraft.squawk) {
    supporting.push({ label: 'Squawk', value: aircraft.squawk });
  }

  // Airline and route are the same lookup, so either can be present without the other:
  // a cargo callsign may resolve an operator and no schedule.
  const airline = identifier.source === 'callsign' ? (aircraft.route?.airline ?? null) : null;
  const origin = aircraft.route?.origin ?? null;
  const destination = aircraft.route?.destination ?? null;
  const hasRoute = origin !== null || destination !== null;

  return {
    id: `adsb-${aircraft.hex}-${index}`,
    viewId: aircraft.overhead ? ADSB_VIEW_OVERHEAD : ADSB_VIEW_AIRCRAFT,
    title: aircraft.overhead ? 'Overhead' : 'Nearby',
    icon: 'aircraft',
    accent: settings.accent as SemanticColor,
    // Attention priority is what lets an overhead aircraft interrupt rotation.
    // It is informational traffic, so it never escalates to `urgent`.
    priority: aircraft.overhead && settings.overheadInterrupt ? 'attention' : 'normal',
    ...(stale ? { badge: { text: 'stale', tone: 'amber' as const } } : {}),
    layout: {
      kind: 'aircraft',
      state: aircraft.overhead ? 'overhead' : 'nearby',
      identifier: identifier.value,
      identifierSource: identifier.source,
      ...(airline ? { airline } : {}),
      ...(hasRoute ? { route: { origin, destination } } : {}),
      distanceText: formatDistance(aircraft.distanceNm, metric),
      altitudeText: formatAltitude(aircraft, metric),
      bearingDegrees: aircraft.bearingDegrees,
      compass: bearingToCompass(aircraft.bearingDegrees),
      verticalTrend: verticalTrend(aircraft.verticalRateFpm),
      supporting,
      footer: `${ageLabel} ago`,
      // Credit the second source only on the frames that actually used it.
      attribution:
        airline || hasRoute
          ? `${snapshot.attribution} · ${ADSBDB_ATTRIBUTION}`
          : snapshot.attribution,
    },
  };
}

export function pickIdentifier(aircraft: RankedAircraft): {
  value: string;
  source: 'callsign' | 'registration' | 'hex';
} {
  if (aircraft.callsign) return { value: aircraft.callsign, source: 'callsign' };
  if (aircraft.registration) return { value: aircraft.registration, source: 'registration' };
  return { value: aircraft.hex.toUpperCase(), source: 'hex' };
}

function formatDistance(distanceNm: number, metric: boolean): string {
  if (metric) {
    const km = nmToKm(distanceNm);
    return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
  }
  return distanceNm < 10 ? `${distanceNm.toFixed(1)} NM` : `${Math.round(distanceNm)} NM`;
}

function formatAltitude(aircraft: RankedAircraft, metric: boolean): string {
  if (aircraft.onGround) return 'Ground';
  // Absence stays absence. An em dash is unambiguous; "0 ft" would be a lie.
  if (aircraft.altitudeFt === null) return '—';
  if (metric) return `${Math.round(feetToMetres(aircraft.altitudeFt)).toLocaleString('en-US')} m`;
  return `${Math.round(aircraft.altitudeFt).toLocaleString('en-US')} ft`;
}

function verticalTrend(verticalRateFpm: number | null): 'climbing' | 'descending' | 'level' | null {
  if (verticalRateFpm === null) return null;
  // Below 100 fpm is instrument noise rather than a real climb or descent.
  if (verticalRateFpm > 100) return 'climbing';
  if (verticalRateFpm < -100) return 'descending';
  return 'level';
}
