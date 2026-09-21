export interface Aircraft {
  hex: string;
  callsign: string | null;
  registration: string | null;
  typeCode: string | null;
  latitude: number;
  longitude: number;
  altitudeFt: number | null;
  onGround: boolean;
  groundSpeedKt: number | null;
  trackDegrees: number | null;
  verticalRateFpm: number | null;
  squawk: string | null;
  emergency: string | null;
  positionAgeSeconds: number | null;
  sourceType: string | null;
}

/**
 * Operator and route for a callsign.
 *
 * None of this is broadcast over ADS-B. It comes from a schedule database keyed on the
 * callsign, so it is absent for general aviation and for any flight the database has
 * not seen. Every field is independently nullable for that reason.
 */
export interface FlightRoute {
  /** Operator name, e.g. `British Airways`. */
  airline: string | null;
  /** Departure airport, IATA where published, else ICAO. */
  origin: string | null;
  /** Arrival airport, same code preference. */
  destination: string | null;
}

/** An aircraft with the observer-relative geometry the display needs. */
export interface RankedAircraft extends Aircraft {
  distanceNm: number;
  bearingDegrees: number;
  overhead: boolean;
  /**
   * Resolved route, attached after selection so only the aircraft actually shown cost
   * a lookup. `null` means the lookup ran and found nothing; absent means it has not
   * run yet.
   */
  route?: FlightRoute | null;
}

export interface NearbyAircraftQuery {
  latitude: number;
  longitude: number;
  radiusNm: number;
}

export interface AircraftProviderResult {
  aircraft: Aircraft[];
  /** Provider-reported timestamp when available, else when we received the response. */
  observedAt: string;
  rawCount: number;
  attribution: string;
  /** Requests left in a daily budget, for providers that publish one. */
  remainingCredits?: number | null;
}

export interface AircraftProvider {
  readonly id: string;
  readonly attribution: string;
  fetchNearby(query: NearbyAircraftQuery, signal: AbortSignal): Promise<AircraftProviderResult>;
}

export interface AdsbSnapshot {
  capturedAt: string;
  observedAt: string;
  /** Ranked, filtered and sorted; the display picks from this list. */
  aircraft: RankedAircraft[];
  totalSeen: number;
  attribution: string;
  /** Null on success; set when the last poll failed but a prior snapshot is retained. */
  error: { code: string; message: string; at: string } | null;
  lastSuccessAt: string | null;
}

/** Per-aircraft overhead state, persisted so a restart does not re-trigger alerts. */
export interface OverheadState {
  hex: string;
  enteredAt: string;
  lastSeenAt: string;
  missedPolls: number;
  announced: boolean;
}
