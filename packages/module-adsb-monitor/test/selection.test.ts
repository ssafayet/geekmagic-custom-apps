import { describe, expect, it } from 'vitest';
import {
  applySelectionMode,
  compareAircraft,
  passesFilters,
  selectAircraft,
} from '../src/selection.js';
import { ADSB_DEFAULT_SETTINGS, type AdsbSettings } from '../src/settings.js';
import type { Aircraft, OverheadState, RankedAircraft } from '../src/types.js';

const OBSERVER = { latitude: 51.4775, longitude: -0.4614 };
const NOW = new Date('2026-09-21T12:00:00Z');

function settings(overrides: Partial<AdsbSettings> = {}): AdsbSettings {
  return {
    ...ADSB_DEFAULT_SETTINGS,
    latitude: OBSERVER.latitude,
    longitude: OBSERVER.longitude,
    overheadEnterRadiusNm: 3,
    overheadExitRadiusNm: 4,
    searchRadiusNm: 25,
    ...overrides,
  };
}

/** Places an aircraft a given distance due north of the observer. */
function aircraftAt(hex: string, distanceNm: number, overrides: Partial<Aircraft> = {}): Aircraft {
  const degreesPerNm = 1 / 60;
  return {
    hex,
    callsign: hex.toUpperCase(),
    registration: null,
    typeCode: null,
    latitude: OBSERVER.latitude + distanceNm * degreesPerNm,
    longitude: OBSERVER.longitude,
    altitudeFt: 10_000,
    onGround: false,
    groundSpeedKt: 300,
    trackDegrees: 180,
    verticalRateFpm: 0,
    squawk: null,
    emergency: null,
    positionAgeSeconds: 2,
    sourceType: 'adsb_icao',
    ...overrides,
  };
}

describe('overhead hysteresis', () => {
  it('enters overhead at the enter radius', () => {
    const state = new Map<string, OverheadState>();
    const result = selectAircraft({
      aircraft: [aircraftAt('aaa', 2.5)],
      observer: OBSERVER,
      settings: settings(),
      overheadState: state,
      now: NOW,
    });

    expect(result.overhead.map((a) => a.hex)).toEqual(['aaa']);
    expect(result.newlyOverhead).toEqual(['aaa']);
    expect(state.has('aaa')).toBe(true);
  });

  it('does not enter overhead between the enter and exit radii', () => {
    const state = new Map<string, OverheadState>();
    const result = selectAircraft({
      aircraft: [aircraftAt('aaa', 3.5)],
      observer: OBSERVER,
      settings: settings(),
      overheadState: state,
      now: NOW,
    });

    expect(result.overhead).toHaveLength(0);
    expect(result.newlyOverhead).toEqual([]);
  });

  it('stays overhead inside the exit radius once entered', () => {
    const state = new Map<string, OverheadState>();
    const config = settings();

    selectAircraft({
      aircraft: [aircraftAt('aaa', 2.0)],
      observer: OBSERVER,
      settings: config,
      overheadState: state,
      now: NOW,
    });
    // Drifting out past the enter radius but not past the exit radius.
    const second = selectAircraft({
      aircraft: [aircraftAt('aaa', 3.6)],
      observer: OBSERVER,
      settings: config,
      overheadState: state,
      now: NOW,
    });

    expect(second.overhead.map((a) => a.hex)).toEqual(['aaa']);
    expect(second.exitedOverhead).toEqual([]);
  });

  it('exits overhead only beyond the exit radius', () => {
    const state = new Map<string, OverheadState>();
    const config = settings();

    selectAircraft({
      aircraft: [aircraftAt('aaa', 2.0)],
      observer: OBSERVER,
      settings: config,
      overheadState: state,
      now: NOW,
    });
    const second = selectAircraft({
      aircraft: [aircraftAt('aaa', 4.5)],
      observer: OBSERVER,
      settings: config,
      overheadState: state,
      now: NOW,
    });

    expect(second.overhead).toHaveLength(0);
    expect(second.exitedOverhead).toEqual(['aaa']);
    expect(state.has('aaa')).toBe(false);
  });

  it('does not flap when an aircraft oscillates around the enter threshold', () => {
    const state = new Map<string, OverheadState>();
    const config = settings();
    const distances = [2.9, 3.1, 2.95, 3.2, 3.05, 3.4, 2.8];
    const enters: string[][] = [];
    const exits: string[][] = [];

    for (const distance of distances) {
      const result = selectAircraft({
        aircraft: [aircraftAt('aaa', distance)],
        observer: OBSERVER,
        settings: config,
        overheadState: state,
        now: NOW,
      });
      enters.push(result.newlyOverhead);
      exits.push(result.exitedOverhead);
    }

    // One entry at the start, and no exit at all: the 4 NM exit radius is never crossed.
    expect(enters.flat()).toEqual(['aaa']);
    expect(exits.flat()).toEqual([]);
  });

  it('expires state only after two consecutive missed polls', () => {
    const state = new Map<string, OverheadState>();
    const config = settings();

    selectAircraft({
      aircraft: [aircraftAt('aaa', 1.0)],
      observer: OBSERVER,
      settings: config,
      overheadState: state,
      now: NOW,
    });

    const first = selectAircraft({
      aircraft: [],
      observer: OBSERVER,
      settings: config,
      overheadState: state,
      now: NOW,
    });
    expect(first.exitedOverhead).toEqual([]);
    expect(state.has('aaa')).toBe(true);

    const second = selectAircraft({
      aircraft: [],
      observer: OBSERVER,
      settings: config,
      overheadState: state,
      now: NOW,
    });
    expect(second.exitedOverhead).toEqual(['aaa']);
    expect(state.has('aaa')).toBe(false);
  });

  it('resets the missed-poll counter when the aircraft reappears', () => {
    const state = new Map<string, OverheadState>();
    const config = settings();

    selectAircraft({
      aircraft: [aircraftAt('aaa', 1.0)],
      observer: OBSERVER,
      settings: config,
      overheadState: state,
      now: NOW,
    });
    selectAircraft({
      aircraft: [],
      observer: OBSERVER,
      settings: config,
      overheadState: state,
      now: NOW,
    });
    selectAircraft({
      aircraft: [aircraftAt('aaa', 1.0)],
      observer: OBSERVER,
      settings: config,
      overheadState: state,
      now: NOW,
    });
    const afterOneMiss = selectAircraft({
      aircraft: [],
      observer: OBSERVER,
      settings: config,
      overheadState: state,
      now: NOW,
    });

    expect(afterOneMiss.exitedOverhead).toEqual([]);
    expect(state.get('aaa')?.missedPolls).toBe(1);
  });

  it('announces each aircraft only once per overhead pass', () => {
    const state = new Map<string, OverheadState>();
    const config = settings();
    const announcements: string[] = [];

    for (const distance of [2.0, 1.5, 1.0, 0.8]) {
      const result = selectAircraft({
        aircraft: [aircraftAt('aaa', distance)],
        observer: OBSERVER,
        settings: config,
        overheadState: state,
        now: NOW,
      });
      announcements.push(...result.newlyOverhead);
    }

    expect(announcements).toEqual(['aaa']);
  });
});

describe('filters', () => {
  it('drops aircraft outside the search radius', () => {
    const result = selectAircraft({
      aircraft: [aircraftAt('near', 10), aircraftAt('far', 40)],
      observer: OBSERVER,
      settings: settings({ searchRadiusNm: 25 }),
      overheadState: new Map(),
      now: NOW,
    });
    expect(result.ranked.map((a) => a.hex)).toEqual(['near']);
  });

  it('drops stale positions', () => {
    const config = settings({ maximumPositionAgeSeconds: 45 });
    expect(passesFilters(aircraftAt('a', 1, { positionAgeSeconds: 50 }), config)).toBe(false);
    expect(passesFilters(aircraftAt('a', 1, { positionAgeSeconds: 40 }), config)).toBe(true);
    // An unreported age cannot be judged stale.
    expect(passesFilters(aircraftAt('a', 1, { positionAgeSeconds: null }), config)).toBe(true);
  });

  it('drops ground traffic when airborneOnly is set', () => {
    const grounded = aircraftAt('a', 1, { onGround: true, altitudeFt: null });
    expect(passesFilters(grounded, settings({ airborneOnly: true }))).toBe(false);
    expect(passesFilters(grounded, settings({ airborneOnly: false }))).toBe(true);
  });

  it('applies altitude bounds and excludes aircraft with no altitude', () => {
    const config = settings({ minimumAltitudeFt: 5_000, maximumAltitudeFt: 20_000 });
    expect(passesFilters(aircraftAt('a', 1, { altitudeFt: 10_000 }), config)).toBe(true);
    expect(passesFilters(aircraftAt('a', 1, { altitudeFt: 2_000 }), config)).toBe(false);
    expect(passesFilters(aircraftAt('a', 1, { altitudeFt: 30_000 }), config)).toBe(false);
    // A filter cannot be applied to an unknown altitude, so the aircraft is excluded.
    expect(passesFilters(aircraftAt('a', 1, { altitudeFt: null }), config)).toBe(false);
  });
});

describe('ordering', () => {
  it('sorts by distance, then position age, then hex', () => {
    const make = (hex: string, distanceNm: number, age: number): RankedAircraft => ({
      ...aircraftAt(hex, distanceNm, { positionAgeSeconds: age }),
      distanceNm,
      bearingDegrees: 0,
      overhead: false,
    });

    const sorted = [
      make('ccc', 5, 1),
      make('aaa', 2, 9),
      make('bbb', 2, 1),
      make('ddd', 2, 1),
    ].sort(compareAircraft);

    expect(sorted.map((a) => a.hex)).toEqual(['bbb', 'ddd', 'aaa', 'ccc']);
  });

  it('is stable across repeated polls of identical data', () => {
    const config = settings();
    const aircraft = [aircraftAt('bbb', 5), aircraftAt('aaa', 5), aircraftAt('ccc', 2)];

    const first = selectAircraft({
      aircraft,
      observer: OBSERVER,
      settings: config,
      overheadState: new Map(),
      now: NOW,
    });
    const second = selectAircraft({
      aircraft,
      observer: OBSERVER,
      settings: config,
      overheadState: new Map(),
      now: NOW,
    });

    expect(first.ranked.map((a) => a.hex)).toEqual(second.ranked.map((a) => a.hex));
    expect(first.ranked[0]?.hex).toBe('ccc');
  });
});

describe('selection modes', () => {
  const config = settings();
  const output = () =>
    selectAircraft({
      aircraft: [
        aircraftAt('overhead1', 1.5),
        aircraftAt('near1', 6),
        aircraftAt('near2', 9),
        aircraftAt('near3', 12),
      ],
      observer: OBSERVER,
      settings: config,
      overheadState: new Map(),
      now: NOW,
    });

  it('overhead-then-nearest prefers the overhead aircraft', () => {
    const selected = applySelectionMode(
      output(),
      settings({ selectionMode: 'overhead-then-nearest' }),
    );
    expect(selected.map((a) => a.hex)).toEqual(['overhead1']);
  });

  it('overhead-then-nearest falls back to the nearest when nothing is overhead', () => {
    const noOverhead = selectAircraft({
      aircraft: [aircraftAt('near1', 6), aircraftAt('near2', 9)],
      observer: OBSERVER,
      settings: config,
      overheadState: new Map(),
      now: NOW,
    });
    const selected = applySelectionMode(
      noOverhead,
      settings({ selectionMode: 'overhead-then-nearest' }),
    );
    expect(selected.map((a) => a.hex)).toEqual(['near1']);
  });

  it('overhead-only shows nothing when nothing is overhead', () => {
    const noOverhead = selectAircraft({
      aircraft: [aircraftAt('near1', 6)],
      observer: OBSERVER,
      settings: config,
      overheadState: new Map(),
      now: NOW,
    });
    expect(applySelectionMode(noOverhead, settings({ selectionMode: 'overhead-only' }))).toEqual(
      [],
    );
  });

  it('nearest ignores the overhead grouping', () => {
    const selected = applySelectionMode(output(), settings({ selectionMode: 'nearest' }));
    expect(selected.map((a) => a.hex)).toEqual(['overhead1']);
  });

  it('rotate returns up to maximumAircraftShown entries in distance order', () => {
    const selected = applySelectionMode(
      output(),
      settings({ selectionMode: 'rotate', maximumAircraftShown: 3 }),
    );
    expect(selected.map((a) => a.hex)).toEqual(['overhead1', 'near1', 'near2']);
  });
});
