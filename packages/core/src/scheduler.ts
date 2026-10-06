import { nowIso, toAppError } from '@gca/shared';
import type { ModuleFrame, RefreshReason } from '@gca/module-sdk';
import type { PlaylistItemRecord, Store } from '@gca/database';
import { FrameRenderer, type EncodedFrame } from '@gca/renderer';
import type { DeviceManager } from './device-manager.js';
import type { EventBus } from './events.js';
import type { AppLogger } from './logger.js';
import type { ModuleRuntimeManager } from './runtime-manager.js';

const TICK_MS = 1_000;
export const DEFAULT_DWELL_SECONDS = 20;
/** No interruption may pin the display indefinitely, even if a release is lost. */
const MAX_INTERRUPTION_MS = 10 * 60 * 1000;
const DEFAULT_INTERRUPT_COOLDOWN_MS = 15_000;
/** Spread startup refreshes so every module does not hit the network at once. */
const STARTUP_JITTER_MS = 4_000;

interface Interruption {
  instanceId: string;
  viewId: string;
  key: string;
  /** Minimum display time; the frame stays at least this long after being raised. */
  until: number;
  raisedAt: number;
  resumeIndex: number;
  resumeUntil: number;
}

interface DeviceSchedule {
  deviceId: string;
  items: PlaylistItemRecord[];
  index: number;
  currentUntil: number;
  interruption: Interruption | null;
  lastInterruptionEndedAt: number;
  lastRenderedFingerprint: string | null;
  pushInFlight: boolean;
}

interface RefreshJob {
  instanceId: string;
  intervalMs: number;
  nextRunAt: number;
  running: boolean;
}

export interface SchedulerOptions {
  store: Store;
  runtimes: ModuleRuntimeManager;
  devices: DeviceManager;
  events: EventBus;
  logger: AppLogger;
  renderer?: FrameRenderer;
  themeId?: string;
  jpegQuality?: number;
  interruptCooldownMs?: number;
  now?: () => number;
}

/**
 * Drives data refreshes and display rotation.
 *
 * These are deliberately separate concerns on one clock: a refresh fetches data and
 * produces a snapshot, while rotation reuses whatever snapshot exists. Switching
 * screens therefore never triggers a network call, which is what keeps a 20-second
 * rotation from turning into a 20-second poll.
 */
export class Scheduler {
  readonly #store: Store;
  readonly #runtimes: ModuleRuntimeManager;
  readonly #devices: DeviceManager;
  readonly #events: EventBus;
  readonly #logger: AppLogger;
  readonly #renderer: FrameRenderer;
  readonly #interruptCooldownMs: number;
  readonly #now: () => number;

  #themeId: string | undefined;
  #jpegQuality: number | undefined;
  #jobs = new Map<string, RefreshJob>();
  #schedules = new Map<string, DeviceSchedule>();
  #activeAttentionKeys = new Set<string>();
  #timer: NodeJS.Timeout | null = null;
  #unsubscribes: Array<() => void> = [];
  #running = false;

  constructor(options: SchedulerOptions) {
    this.#store = options.store;
    this.#runtimes = options.runtimes;
    this.#devices = options.devices;
    this.#events = options.events;
    this.#logger = options.logger.child({ component: 'scheduler' });
    this.#renderer = options.renderer ?? new FrameRenderer();
    this.#themeId = options.themeId;
    this.#jpegQuality = options.jpegQuality;
    this.#interruptCooldownMs = options.interruptCooldownMs ?? DEFAULT_INTERRUPT_COOLDOWN_MS;
    this.#now = options.now ?? (() => Date.now());

    // Subscribed at construction, not at start: an attention event raised during
    // startup (a module refreshing before the timer begins) must not be dropped.
    this.subscribe();
  }

  setRenderOptions(options: { themeId?: string; jpegQuality?: number }): void {
    if (options.themeId !== undefined) this.#themeId = options.themeId;
    if (options.jpegQuality !== undefined) this.#jpegQuality = options.jpegQuality;
    // Theme affects pixels, so every device must re-render on the next tick.
    for (const schedule of this.#schedules.values()) schedule.lastRenderedFingerprint = null;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;

    this.rebuildJobs();
    this.rebuildSchedules();
    if (this.#unsubscribes.length === 0) this.subscribe();

    this.#timer = setInterval(() => {
      void this.tick().catch((error) =>
        this.#logger.error({ err: error }, 'Scheduler tick failed'),
      );
    }, TICK_MS);
    this.#timer.unref?.();
    this.#logger.info(
      { jobs: this.#jobs.size, devices: this.#schedules.size },
      'Scheduler started',
    );
  }

  stop(): void {
    this.#running = false;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    for (const unsubscribe of this.#unsubscribes) unsubscribe();
    this.#unsubscribes = [];
  }

  /** Rebuilds refresh jobs from current configuration. Safe to call at any time. */
  rebuildJobs(): void {
    const next = new Map<string, RefreshJob>();
    const now = this.#now();

    for (const instance of this.#runtimes.list()) {
      const manifest = instance.entry.manifest;
      const configured = Number(instance.record.settings['pollIntervalSeconds']);
      const seconds = Number.isFinite(configured)
        ? Math.min(
            manifest.refresh.maximumSeconds,
            Math.max(manifest.refresh.minimumSeconds, configured),
          )
        : manifest.refresh.defaultSeconds;

      const existing = this.#jobs.get(instance.record.id);
      next.set(instance.record.id, {
        instanceId: instance.record.id,
        intervalMs: seconds * 1000,
        nextRunAt: existing?.nextRunAt ?? now + Math.random() * STARTUP_JITTER_MS,
        running: existing?.running ?? false,
      });
    }
    this.#jobs = next;
  }

  /**
   * Fetches an instance's data now rather than at its next interval.
   *
   * After a settings change the runtime restarts holding no data, or data fetched for
   * the old settings, and the next scheduled run can be most of a poll interval away —
   * ten minutes for weather. The run counts as this interval's refresh. Null while the
   * scheduler is stopped, since it refreshes nothing then.
   */
  refreshNow(instanceId: string, reason: RefreshReason): Promise<void> | null {
    if (!this.#running || !this.#runtimes.get(instanceId)) return null;
    const job = this.#jobs.get(instanceId);
    if (job) job.nextRunAt = this.#now() + job.intervalMs;
    // A failure is recorded as the instance's health, which is where it is reported.
    return this.#runtimes.refresh(instanceId, reason).then(
      () => undefined,
      () => undefined,
    );
  }

  rebuildSchedules(): void {
    const next = new Map<string, DeviceSchedule>();
    for (const runtime of this.#devices.list()) {
      if (!runtime.record.active) continue;
      const previous = this.#schedules.get(runtime.record.id);
      const items = this.#store.playlist
        .listForDevice(runtime.record.id)
        .filter((item) => item.enabled && this.#runtimes.get(item.moduleInstanceId) !== null);

      next.set(runtime.record.id, {
        deviceId: runtime.record.id,
        items,
        index: previous && previous.index < items.length ? previous.index : 0,
        currentUntil: previous?.currentUntil ?? 0,
        interruption: previous?.interruption ?? null,
        lastInterruptionEndedAt: previous?.lastInterruptionEndedAt ?? 0,
        // Force a re-render whenever the playlist is rebuilt.
        lastRenderedFingerprint: null,
        pushInFlight: false,
      });
    }
    this.#schedules = next;
  }

  /** Forces the next tick to re-render and push, bypassing fingerprint suppression. */
  invalidateDevice(deviceId: string): void {
    const schedule = this.#schedules.get(deviceId);
    if (schedule) schedule.lastRenderedFingerprint = null;
  }

  invalidateAll(): void {
    for (const schedule of this.#schedules.values()) schedule.lastRenderedFingerprint = null;
  }

  /** Renders the frame a device should currently show, without uploading it. */
  async renderCurrent(
    deviceId: string,
  ): Promise<{ frame: ModuleFrame; encoded: EncodedFrame } | null> {
    const schedule = this.#schedules.get(deviceId);
    if (!schedule) return null;
    const frame = await this.resolveFrame(schedule, this.#now());
    if (!frame) return null;
    return { frame, encoded: await this.encode(frame) };
  }

  async pushNow(deviceId: string, options: { force?: boolean } = {}): Promise<boolean> {
    const schedule = this.#schedules.get(deviceId);
    if (!schedule) return false;
    const frame = await this.resolveFrame(schedule, this.#now());
    if (!frame) return false;
    const encoded = await this.encode(frame);
    const outcome = await this.#devices.pushFrame(deviceId, encoded, {
      priority: frame.priority,
      ...(options.force ? { force: true } : {}),
    });
    if (outcome.status === 'uploaded' || outcome.status === 'skipped-unchanged') {
      schedule.lastRenderedFingerprint = frame.fingerprint;
    }
    return outcome.status === 'uploaded';
  }

  /** Current and next playlist entries, for the overview page. */
  describeDevice(deviceId: string): {
    current: { moduleInstanceId: string; viewId: string } | null;
    next: { moduleInstanceId: string; viewId: string } | null;
    interrupted: boolean;
  } {
    const schedule = this.#schedules.get(deviceId);
    if (!schedule || schedule.items.length === 0) {
      return { current: null, next: null, interrupted: false };
    }
    if (schedule.interruption) {
      const upcoming = schedule.items[schedule.index % schedule.items.length];
      return {
        current: {
          moduleInstanceId: schedule.interruption.instanceId,
          viewId: schedule.interruption.viewId,
        },
        next: upcoming
          ? { moduleInstanceId: upcoming.moduleInstanceId, viewId: upcoming.viewId }
          : null,
        interrupted: true,
      };
    }
    const current = schedule.items[schedule.index % schedule.items.length];
    const next = schedule.items[(schedule.index + 1) % schedule.items.length];
    return {
      current: current
        ? { moduleInstanceId: current.moduleInstanceId, viewId: current.viewId }
        : null,
      next: next ? { moduleInstanceId: next.moduleInstanceId, viewId: next.viewId } : null,
      interrupted: false,
    };
  }

  async tick(): Promise<void> {
    const now = this.#now();
    await this.runDueRefreshes(now);
    await Promise.all(
      [...this.#schedules.values()].map((schedule) => this.advanceDevice(schedule, now)),
    );
  }

  private async runDueRefreshes(now: number): Promise<void> {
    for (const job of this.#jobs.values()) {
      if (job.running || now < job.nextRunAt) continue;
      const instance = this.#runtimes.get(job.instanceId);
      if (!instance) continue;

      job.running = true;
      void this.#runtimes
        .refresh(job.instanceId, 'scheduled')
        .catch(() => undefined)
        .finally(() => {
          job.running = false;
          // A failing module backs off so it cannot hammer a broken provider.
          const backoff = this.#runtimes.backoffMs(instance);
          const jitter = job.intervalMs * 0.1 * Math.random();
          job.nextRunAt = this.#now() + job.intervalMs + backoff + jitter;
        });
    }
  }

  private async advanceDevice(schedule: DeviceSchedule, now: number): Promise<void> {
    if (schedule.pushInFlight) return;

    this.expireInterruption(schedule, now);

    if (!schedule.interruption && schedule.items.length > 0 && now >= schedule.currentUntil) {
      // Only advance after the first frame has actually been shown.
      if (schedule.currentUntil !== 0) {
        schedule.index = (schedule.index + 1) % schedule.items.length;
      }
      const item = schedule.items[schedule.index % schedule.items.length];
      schedule.currentUntil = now + (item?.dwellSeconds ?? DEFAULT_DWELL_SECONDS) * 1000;
    }

    const frame = await this.resolveFrame(schedule, now);
    if (!frame) return;
    if (frame.fingerprint === schedule.lastRenderedFingerprint) return;

    schedule.pushInFlight = true;
    try {
      const encoded = await this.encode(frame);
      const outcome = await this.#devices.pushFrame(schedule.deviceId, encoded, {
        priority: frame.priority,
      });
      if (outcome.status === 'uploaded' || outcome.status === 'skipped-unchanged') {
        schedule.lastRenderedFingerprint = frame.fingerprint;
      }
    } catch (error) {
      const appError = toAppError(error, 'Frame push failed');
      // Remember the fingerprint for non-retryable errors so we stop hammering a
      // device that structurally cannot accept this frame.
      if (!appError.retryable) schedule.lastRenderedFingerprint = frame.fingerprint;
      this.#logger.warn({ deviceId: schedule.deviceId, code: appError.code }, 'Frame push failed');
    } finally {
      schedule.pushInFlight = false;
    }
  }

  private expireInterruption(schedule: DeviceSchedule, now: number): void {
    const interruption = schedule.interruption;
    if (!interruption) return;

    const keyActive = this.#activeAttentionKeys.has(interruption.key);
    const hardExpired = now - interruption.raisedAt > MAX_INTERRUPTION_MS;
    const minimumElapsed = now >= interruption.until;

    // Hold while the condition persists; once released, still honour the minimum hold.
    if (hardExpired || (!keyActive && minimumElapsed)) {
      schedule.interruption = null;
      schedule.lastInterruptionEndedAt = now;

      // Resume exactly where rotation left off rather than restarting the playlist,
      // and grant the interrupted item a full dwell. Carrying over the original
      // deadline would leave it already expired, so the same tick would skip past
      // the very item the interruption was supposed to return to.
      schedule.index = interruption.resumeIndex;
      const resumed = schedule.items[schedule.index % Math.max(1, schedule.items.length)];
      schedule.currentUntil = now + (resumed?.dwellSeconds ?? DEFAULT_DWELL_SECONDS) * 1000;
      schedule.lastRenderedFingerprint = null;
    }
  }

  private async resolveFrame(schedule: DeviceSchedule, now: number): Promise<ModuleFrame | null> {
    if (schedule.interruption) {
      // No view fallback here on purpose: if the attention view has nothing to show,
      // the interruption must end rather than pin the module's ordinary view on screen.
      const frames = await this.framesFor(
        schedule.interruption.instanceId,
        schedule.interruption.viewId,
        { allowViewFallback: false },
      );
      const frame = frames[0];
      if (frame) return frame;
      schedule.interruption = null;
      schedule.lastInterruptionEndedAt = now;
      schedule.lastRenderedFingerprint = null;
    }

    if (schedule.items.length === 0) return null;
    const item = schedule.items[schedule.index % schedule.items.length];
    if (!item) return null;

    const frames = await this.framesFor(item.moduleInstanceId, item.viewId);
    return frames[0] ?? null;
  }

  private async framesFor(
    instanceId: string,
    viewId: string,
    options: { allowViewFallback?: boolean } = {},
  ): Promise<ModuleFrame[]> {
    if (!this.#runtimes.get(instanceId)) return [];
    try {
      const frames = await this.#runtimes.getFrames(instanceId, { viewIds: [viewId] });
      if (frames.length > 0) return frames;
      // In rotation, a module that cannot fill the requested view may answer with its
      // default one rather than leaving the slot blank.
      if (options.allowViewFallback === false) return [];
      return this.#runtimes.getFrames(instanceId);
    } catch (error) {
      this.#logger.warn({ instanceId, viewId, err: error }, 'Frame lookup failed');
      return [];
    }
  }

  private async encode(frame: ModuleFrame): Promise<EncodedFrame> {
    return this.#renderer.render(frame, {
      ...(this.#themeId ? { themeId: this.#themeId } : {}),
      ...(this.#jpegQuality ? { quality: this.#jpegQuality } : {}),
    });
  }

  private subscribe(): void {
    this.#unsubscribes.push(
      this.#events.on('module.attention', (payload) => {
        this.#activeAttentionKeys.add(payload.key);
        this.raiseInterruption(payload);
      }),
      this.#events.on('module.attention-released', (payload) => {
        this.#activeAttentionKeys.delete(payload.key);
      }),
      this.#events.on('module.display-refresh', (payload) => {
        for (const schedule of this.#schedules.values()) {
          const showsInstance =
            schedule.items.some((item) => item.moduleInstanceId === payload.instanceId) ||
            schedule.interruption?.instanceId === payload.instanceId;
          if (showsInstance) schedule.lastRenderedFingerprint = null;
        }
      }),
      this.#events.on('module.snapshot', (payload) => {
        for (const schedule of this.#schedules.values()) {
          if (schedule.items.some((item) => item.moduleInstanceId === payload.instanceId)) {
            schedule.lastRenderedFingerprint = null;
          }
        }
      }),
    );
  }

  private raiseInterruption(payload: {
    instanceId: string;
    viewId: string;
    key: string;
    holdSeconds: number;
    reason: string;
  }): void {
    const now = this.#now();

    for (const schedule of this.#schedules.values()) {
      // Only devices that already show this module may be interrupted by it.
      const shows = schedule.items.some((item) => item.moduleInstanceId === payload.instanceId);
      if (!shows) continue;

      // Re-raising the same key extends the hold rather than restarting the frame.
      if (schedule.interruption?.key === payload.key) {
        schedule.interruption.until = now + payload.holdSeconds * 1000;
        continue;
      }
      if (now - schedule.lastInterruptionEndedAt < this.#interruptCooldownMs) {
        this.#logger.debug(
          { deviceId: schedule.deviceId, key: payload.key },
          'Interruption suppressed by per-device cooldown',
        );
        continue;
      }

      schedule.interruption = {
        instanceId: payload.instanceId,
        viewId: payload.viewId,
        key: payload.key,
        until: now + payload.holdSeconds * 1000,
        raisedAt: now,
        resumeIndex: schedule.index,
        resumeUntil: schedule.currentUntil,
      };
      schedule.lastRenderedFingerprint = null;

      this.#store.audit.record({
        eventType: 'display.interrupted',
        entityType: 'device',
        entityId: schedule.deviceId,
        details: { reason: payload.reason, moduleInstanceId: payload.instanceId, at: nowIso() },
      });
    }
  }
}
