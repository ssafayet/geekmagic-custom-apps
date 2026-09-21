import {
  AppError,
  ageSeconds,
  isValidLatitude,
  isValidLongitude,
  nowIso,
  roundCoordinateForLog,
  toAppError,
} from '@gca/shared';
import type {
  AppModule,
  FrameContext,
  ModuleActionResult,
  ModuleContext,
  ModuleFrameDraft,
  ModuleHealth,
  ModuleManifest,
  ModuleRuntime,
  RefreshReason,
  ValidationContext,
  ValidationResult,
} from '@gca/module-sdk';
import { buildAdsbFrames, ADSB_VIEW_AIRCRAFT, ADSB_VIEW_OVERHEAD } from './frames.js';
import { AdsbFiProvider, ADSB_FI_MAX_RADIUS_NM } from './provider-adsbfi.js';
import {
  OpenSkyProvider,
  openSkyMinimumPollSeconds,
  OPENSKY_DAILY_CREDITS_ANONYMOUS,
  OPENSKY_DAILY_CREDITS_AUTHENTICATED,
} from './provider-opensky.js';
import { applySelectionMode, selectAircraft } from './selection.js';
import {
  ADSB_DEFAULT_SETTINGS,
  ADSB_SETTINGS_SCHEMA,
  ADSB_UI_SCHEMA,
  OPENSKY_CLIENT_ID_SECRET,
  OPENSKY_CLIENT_SECRET_SECRET,
  type AdsbSettings,
} from './settings.js';
import type { AdsbSnapshot, AircraftProvider, OverheadState, RankedAircraft } from './types.js';

const OVERHEAD_STATE_KEY = 'overhead-state';
/** How long a retained snapshot stays displayable after the provider starts failing. */
const STALE_TOLERANCE_MULTIPLIER = 4;
const MIN_STALE_TOLERANCE_SECONDS = 60;

export const adsbManifest: ModuleManifest = {
  id: 'adsb-monitor',
  version: '1.0.0',
  settingsVersion: 1,
  displayName: 'ADS-B Monitor',
  description:
    'Shows the nearest or currently overhead aircraft around a configured location, with distance, altitude, speed and bearing.',
  icon: 'aircraft',
  category: 'monitoring',
  // One instance: the provider is a setting, not a reason to run the module twice.
  singleton: true,
  refresh: { defaultSeconds: 15, minimumSeconds: 2, maximumSeconds: 300 },
  permissions: ['network:adsb-fi', 'network:opensky', 'location:configured', 'secrets:read-own'],
  views: [
    {
      id: ADSB_VIEW_AIRCRAFT,
      displayName: 'Aircraft',
      description: 'Nearest or clear-sky frame',
      selectable: true,
    },
    {
      id: ADSB_VIEW_OVERHEAD,
      displayName: 'Overhead alert',
      description: 'Interrupting frame raised when an aircraft crosses the overhead threshold',
      selectable: false,
    },
  ],
  actions: [
    {
      id: 'adsb.testLocation',
      displayName: 'Test location',
      description: 'Fetches nearby aircraft for the current coordinates without saving them.',
      confirmation: 'none',
      timeoutMs: 12_000,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          latitude: { type: 'number', minimum: -90, maximum: 90 },
          longitude: { type: 'number', minimum: -180, maximum: 180 },
          searchRadiusNm: { type: 'number', minimum: 1, maximum: ADSB_FI_MAX_RADIUS_NM },
        },
      },
    },
  ],
};

class AdsbRuntime implements ModuleRuntime<AdsbSnapshot> {
  #snapshot: AdsbSnapshot | null = null;
  #overheadState = new Map<string, OverheadState>();
  #selected: RankedAircraft[] = [];
  #provider: AircraftProvider;
  #announcedKeys = new Set<string>();
  #remainingCredits: number | null = null;

  constructor(private readonly ctx: ModuleContext<AdsbSettings>) {
    this.#provider = new AdsbFiProvider(ctx.http);
  }

  /**
   * Builds the configured provider.
   *
   * Rebuilt per refresh rather than cached in the constructor so a credential added
   * in the UI takes effect without restarting the instance.
   */
  private async resolveProvider(): Promise<AircraftProvider> {
    if (this.ctx.settings.provider !== 'opensky') {
      if (this.#provider.id !== 'adsb-fi') this.#provider = new AdsbFiProvider(this.ctx.http);
      return this.#provider;
    }

    const clientId = await this.ctx.secrets.get(OPENSKY_CLIENT_ID_SECRET);
    const clientSecret = await this.ctx.secrets.get(OPENSKY_CLIENT_SECRET_SECRET);
    const credentials = clientId && clientSecret ? { clientId, clientSecret } : null;

    const existing = this.#provider;
    // Reuse the instance when nothing changed, so its cached token survives.
    if (existing instanceof OpenSkyProvider && existing.authenticated === (credentials !== null)) {
      return existing;
    }
    this.#provider = new OpenSkyProvider(this.ctx.http, credentials);
    return this.#provider;
  }

  async start(): Promise<void> {
    const stored = await this.ctx.state.get<OverheadState[]>(OVERHEAD_STATE_KEY);
    if (Array.isArray(stored)) {
      // Restoring hysteresis prevents a restart from re-announcing an aircraft that
      // has been overhead the whole time.
      for (const entry of stored) {
        if (entry && typeof entry.hex === 'string') this.#overheadState.set(entry.hex, entry);
      }
    }
    this.ctx.logger.debug(
      {
        location: this.ctx.settings.locationLabel,
        latitude: roundCoordinateForLog(this.ctx.settings.latitude),
        longitude: roundCoordinateForLog(this.ctx.settings.longitude),
      },
      'ADS-B monitor started',
    );
  }

  async stop(): Promise<void> {
    await this.persistOverheadState();
  }

  getSnapshot(): AdsbSnapshot | null {
    return this.#snapshot;
  }

  hydrate(snapshot: unknown): void {
    if (isAdsbSnapshot(snapshot)) {
      this.#snapshot = snapshot;
      this.#selected = applySelectionMode(
        {
          ranked: snapshot.aircraft,
          overhead: snapshot.aircraft.filter((a) => a.overhead),
          nearby: snapshot.aircraft.filter((a) => !a.overhead),
          newlyOverhead: [],
          exitedOverhead: [],
        },
        this.ctx.settings,
      );
    }
  }

  async refresh(_reason: RefreshReason, signal: AbortSignal): Promise<AdsbSnapshot> {
    const settings = this.ctx.settings;
    const configError = validateLocation(settings);
    if (configError) {
      throw new AppError('ADSB_LOCATION_INVALID', configError);
    }

    const observer = { latitude: settings.latitude, longitude: settings.longitude };

    try {
      const provider = await this.resolveProvider();
      const result = await provider.fetchNearby(
        { ...observer, radiusNm: settings.searchRadiusNm },
        signal,
      );

      this.#remainingCredits = result.remainingCredits ?? null;
      if (typeof this.#remainingCredits === 'number' && this.#remainingCredits < 50) {
        this.ctx.logger.warn(
          { remaining: this.#remainingCredits },
          'Provider daily request budget is nearly exhausted; increase the poll interval',
        );
      }

      const selection = selectAircraft({
        aircraft: result.aircraft,
        observer,
        settings,
        overheadState: this.#overheadState,
        now: this.ctx.now(),
      });

      this.#selected = applySelectionMode(selection, settings);
      this.#snapshot = {
        capturedAt: nowIso(),
        observedAt: result.observedAt,
        aircraft: selection.ranked,
        totalSeen: result.rawCount,
        attribution: result.attribution,
        error: null,
        lastSuccessAt: nowIso(),
      };

      this.handleAttention(selection.newlyOverhead, selection.exitedOverhead);
      await this.persistOverheadState();
      return this.#snapshot;
    } catch (error) {
      const appError = toAppError(error, 'ADS-B provider request failed');
      // Retain the previous snapshot so the display degrades gradually instead of
      // blanking on the first transient failure.
      if (this.#snapshot) {
        this.#snapshot = {
          ...this.#snapshot,
          error: { code: appError.code, message: appError.message, at: nowIso() },
        };
      } else {
        this.#snapshot = {
          capturedAt: nowIso(),
          observedAt: nowIso(),
          aircraft: [],
          totalSeen: 0,
          attribution: this.#provider.attribution,
          error: { code: appError.code, message: appError.message, at: nowIso() },
          lastSuccessAt: null,
        };
      }
      throw appError;
    }
  }

  async getFrames(ctx: FrameContext): Promise<ModuleFrameDraft[]> {
    const settings = this.ctx.settings;
    const configurationError = validateLocation(settings);
    const stale = this.isStale(ctx.now);
    const selected = stale && this.#snapshot?.error ? [] : this.#selected;

    return buildAdsbFrames({
      snapshot: this.#snapshot,
      selected,
      settings,
      ctx,
      stale,
      configurationError,
    });
  }

  async getHealth(): Promise<ModuleHealth> {
    const configError = validateLocation(this.ctx.settings);
    if (configError) {
      return { status: 'error', message: configError, code: 'ADSB_LOCATION_INVALID' };
    }
    if (!this.#snapshot) return { status: 'unknown', message: 'No poll completed yet.' };

    if (this.#snapshot.error) {
      const stale = this.isStale(this.ctx.now());
      return {
        status: stale ? 'error' : 'degraded',
        message: this.#snapshot.error.message,
        code: this.#snapshot.error.code,
      };
    }

    // An empty sky is a healthy answer, not a failure.
    return {
      status: 'healthy',
      message:
        this.#snapshot.aircraft.length === 0
          ? 'No aircraft in range.'
          : `${this.#snapshot.aircraft.length} aircraft in range.`,
      details: { totalSeen: this.#snapshot.totalSeen },
    };
  }

  async getStatusPanel(): Promise<ModuleActionResult['panel'] | null> {
    const snapshot = this.#snapshot;
    return {
      title: 'Provider status',
      rows: [
        {
          label: 'Provider',
          value:
            this.ctx.settings.provider === 'opensky'
              ? `OpenSky${this.#provider instanceof OpenSkyProvider && this.#provider.authenticated ? ' (authenticated)' : ' (anonymous)'}`
              : 'adsb.fi open data',
        },
        ...(this.#remainingCredits === null
          ? []
          : [
              {
                label: 'Requests left today',
                value: String(this.#remainingCredits),
                tone: this.#remainingCredits < 50 ? ('warn' as const) : ('neutral' as const),
              },
            ]),
        {
          label: 'Location',
          value: `${this.ctx.settings.locationLabel} (${this.ctx.settings.latitude.toFixed(3)}, ${this.ctx.settings.longitude.toFixed(3)})`,
        },
        {
          label: 'Last poll',
          value: snapshot ? `${ageSeconds(snapshot.capturedAt, this.ctx.now())}s ago` : 'never',
          tone: snapshot ? 'neutral' : 'warn',
        },
        {
          label: 'In range',
          value: snapshot ? String(snapshot.aircraft.length) : '—',
        },
        {
          label: 'Overhead now',
          value: String(this.#overheadState.size),
          tone: this.#overheadState.size > 0 ? 'good' : 'neutral',
        },
      ],
    };
  }

  async runAction(
    actionId: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<ModuleActionResult> {
    if (actionId !== 'adsb.testLocation') {
      throw new AppError('MODULE_ACTION_UNKNOWN', `Unknown action "${actionId}".`);
    }

    const payload = (input ?? {}) as Partial<AdsbSettings>;
    const latitude = payload.latitude ?? this.ctx.settings.latitude;
    const longitude = payload.longitude ?? this.ctx.settings.longitude;
    const radiusNm = payload.searchRadiusNm ?? this.ctx.settings.searchRadiusNm;

    if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) {
      return {
        ok: false,
        message: 'Enter a valid latitude and longitude first.',
        code: 'ADSB_LOCATION_INVALID',
      };
    }

    try {
      const provider = await this.resolveProvider();
      const result = await provider.fetchNearby({ latitude, longitude, radiusNm }, signal);
      const selection = selectAircraft({
        aircraft: result.aircraft,
        observer: { latitude, longitude },
        settings: { ...this.ctx.settings, latitude, longitude, searchRadiusNm: radiusNm },
        // A dry run must not mutate live hysteresis state.
        overheadState: new Map(),
        now: this.ctx.now(),
      });
      const closest = selection.ranked[0];

      return {
        ok: true,
        message:
          selection.ranked.length === 0
            ? `No aircraft within ${radiusNm} NM right now. The connection to the provider worked.`
            : `${selection.ranked.length} aircraft within ${radiusNm} NM.`,
        data: { count: selection.ranked.length, totalSeen: result.rawCount },
        panel: {
          title: 'Test result',
          rows: [
            { label: 'Aircraft in range', value: String(selection.ranked.length), tone: 'good' },
            { label: 'Reported by provider', value: String(result.rawCount) },
            closest
              ? {
                  label: 'Closest',
                  value: `${closest.callsign ?? closest.registration ?? closest.hex.toUpperCase()} · ${closest.distanceNm.toFixed(1)} NM`,
                }
              : { label: 'Closest', value: 'none', tone: 'neutral' },
          ],
        },
      };
    } catch (error) {
      const appError = toAppError(error, 'Provider request failed');
      return { ok: false, message: appError.message, code: appError.code };
    }
  }

  private handleAttention(newlyOverhead: string[], exitedOverhead: string[]): void {
    if (!this.ctx.settings.overheadInterrupt) return;

    for (const hex of newlyOverhead) {
      const key = `overhead:${hex}`;
      // Suppress duplicate enter events for the same aircraft until it exits.
      if (this.#announcedKeys.has(key)) continue;
      this.#announcedKeys.add(key);
      this.ctx.events.requestAttention({
        viewId: ADSB_VIEW_OVERHEAD,
        key,
        holdSeconds: this.ctx.settings.interruptHoldSeconds,
        reason: `Aircraft ${hex.toUpperCase()} crossed the overhead threshold`,
      });
    }

    for (const hex of exitedOverhead) {
      const key = `overhead:${hex}`;
      if (!this.#announcedKeys.delete(key)) continue;
      this.ctx.events.releaseAttention(key);
    }
  }

  private isStale(now: Date): boolean {
    if (!this.#snapshot) return false;
    const reference = this.#snapshot.lastSuccessAt ?? this.#snapshot.capturedAt;
    const tolerance = Math.max(
      MIN_STALE_TOLERANCE_SECONDS,
      this.ctx.settings.pollIntervalSeconds * STALE_TOLERANCE_MULTIPLIER,
    );
    return ageSeconds(reference, now) > tolerance;
  }

  private async persistOverheadState(): Promise<void> {
    await this.ctx.state.set(OVERHEAD_STATE_KEY, [...this.#overheadState.values()]);
  }
}

export function validateLocation(settings: AdsbSettings): string | null {
  if (!isValidLatitude(settings.latitude) || !isValidLongitude(settings.longitude)) {
    return 'Set a latitude and longitude in module settings.';
  }
  if (settings.latitude === 0 && settings.longitude === 0) {
    return 'Set a latitude and longitude in module settings.';
  }
  if (settings.overheadExitRadiusNm <= settings.overheadEnterRadiusNm) {
    return 'The overhead exit radius must be larger than the enter radius.';
  }
  return null;
}

export const adsbMonitorModule: AppModule<AdsbSettings, AdsbSnapshot> = {
  manifest: adsbManifest,
  settingsSchema: ADSB_SETTINGS_SCHEMA,
  uiSchema: ADSB_UI_SCHEMA,
  defaultSettings: ADSB_DEFAULT_SETTINGS,
  secretKeys: [OPENSKY_CLIENT_ID_SECRET, OPENSKY_CLIENT_SECRET_SECRET],

  async validateSettings(
    settings: unknown,
    ctx: ValidationContext,
  ): Promise<ValidationResult<AdsbSettings>> {
    const value = { ...ADSB_DEFAULT_SETTINGS, ...(settings as Partial<AdsbSettings>) };
    const errors: Array<{ path: string; message: string }> = [];

    if (!isValidLatitude(value.latitude)) {
      errors.push({ path: '/latitude', message: 'Latitude must be between -90 and 90.' });
    }
    if (!isValidLongitude(value.longitude)) {
      errors.push({ path: '/longitude', message: 'Longitude must be between -180 and 180.' });
    }
    if (value.overheadExitRadiusNm <= value.overheadEnterRadiusNm) {
      errors.push({
        path: '/overheadExitRadiusNm',
        message:
          'The exit radius must be larger than the enter radius, or the display will flicker.',
      });
    }
    if (value.overheadEnterRadiusNm > value.searchRadiusNm) {
      errors.push({
        path: '/overheadEnterRadiusNm',
        message: 'The overhead radius cannot be larger than the search radius.',
      });
    }
    if (
      value.minimumAltitudeFt !== null &&
      value.maximumAltitudeFt !== null &&
      value.minimumAltitudeFt > value.maximumAltitudeFt
    ) {
      errors.push({
        path: '/minimumAltitudeFt',
        message: 'The minimum altitude must be below the maximum altitude.',
      });
    }

    if (errors.length > 0) return { ok: false, errors };

    // OpenSky bills per request against a daily budget, so the poll interval — not a
    // per-second rate limit — decides whether a deployment survives the day. Enforce
    // it rather than warn: a 5s poll exhausts the anonymous budget in half an hour.
    if (value.provider === 'opensky') {
      const authenticated =
        ctx.secretConfigured(OPENSKY_CLIENT_ID_SECRET) &&
        ctx.secretConfigured(OPENSKY_CLIENT_SECRET_SECRET);
      const minimum = openSkyMinimumPollSeconds(authenticated);
      if (value.pollIntervalSeconds < minimum) {
        errors.push({
          path: '/pollIntervalSeconds',
          message: authenticated
            ? `OpenSky allows about ${OPENSKY_DAILY_CREDITS_AUTHENTICATED} requests a day, so poll no faster than every ${minimum}s.`
            : `Without credentials OpenSky allows about ${OPENSKY_DAILY_CREDITS_ANONYMOUS} requests a day, so poll no faster than every ${minimum}s. Add a client ID and secret to poll more often.`,
        });
        return { ok: false, errors };
      }
    }

    const warnings: string[] = [];
    if (value.provider === 'adsb-fi' && value.pollIntervalSeconds < 5) {
      warnings.push(
        'Polling faster than every 5 seconds gives little benefit and pushes against the provider rate limit.',
      );
    }
    if (value.provider === 'opensky') {
      warnings.push(
        'OpenSky state vectors carry no registration or aircraft type, so those rows show "Unknown".',
      );
    }
    return { ok: true, value, ...(warnings.length > 0 ? { warnings } : {}) };
  },

  async migrateSettings(fromVersion: number, settings: unknown) {
    // Version 1 is the first schema; later versions append cases here.
    return { version: Math.max(1, fromVersion), settings };
  },

  createRuntime(ctx) {
    return new AdsbRuntime(ctx);
  },

  snapshotIsValid: isAdsbSnapshot,
};

function isAdsbSnapshot(value: unknown): value is AdsbSnapshot {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<AdsbSnapshot>;
  return typeof record.capturedAt === 'string' && Array.isArray(record.aircraft);
}
