import { AppError, nowIso, toAppError, type HealthStatus } from '@gca/shared';
import type {
  AnyModuleRuntime,
  FrameContext,
  ModuleActionResult,
  ModuleContext,
  ModuleFrame,
  ModuleFrameDraft,
  ModuleHealth,
  ModulePermission,
  RefreshReason,
  SemanticColor,
} from '@gca/module-sdk';
import type { Store, ModuleInstanceRecord } from '@gca/database';
import { finalizeFrame } from '@gca/renderer';
import { stableStringify } from '@gca/module-sdk';
import type { EventBus } from './events.js';
import type { AppLogger } from './logger.js';
import type { ModuleRegistry, RegistryEntry } from './registry.js';
import {
  allowedHostsFor,
  InstanceScopedSecrets,
  InstanceScopedState,
  PermissionScopedHttpClient,
} from './scoped-services.js';
import type { BridgeInbox } from './host/bridge-inbox.js';
import type { LocalClaudeCliService } from './host/claude-cli.js';
import type { LocalClaudeSettingsService } from './host/claude-settings.js';

const DEFAULT_REFRESH_TIMEOUT_MS = 30_000;
const SNAPSHOT_TTL_SECONDS = 15 * 60;
/** Restart backoff for a module whose refresh keeps throwing. */
const CRASH_BACKOFF_MS = [5_000, 15_000, 60_000, 300_000];

export interface HostServiceBundle {
  claudeCli?: LocalClaudeCliService;
  claudeSettings?: LocalClaudeSettingsService;
  bridgeInbox?: BridgeInbox;
}

export interface ManagedInstance {
  record: ModuleInstanceRecord;
  entry: RegistryEntry;
  runtime: AnyModuleRuntime;
  health: { status: HealthStatus; message?: string; code?: string };
  lastRefreshAt: string | null;
  nextRefreshAt: string | null;
  consecutiveFailures: number;
  /** Frames cached from the last successful build, keyed by view id. */
  frameCache: Map<string, ModuleFrame>;
  frameCacheKey: string | null;
  refreshInFlight: Promise<unknown> | null;
  /** Set when a refresh was requested while one was already running. */
  refreshQueued: boolean;
  started: boolean;
  /** Serialized form of what is currently in the snapshot table, for change detection. */
  persistedSnapshot: string | null;
}

export interface RuntimeManagerOptions {
  store: Store;
  registry: ModuleRegistry;
  events: EventBus;
  logger: AppLogger;
  host: HostServiceBundle;
  now?: () => Date;
  defaultThemeAccent?: SemanticColor;
  timezone?: string;
}

/**
 * Owns the lifecycle of every enabled module instance.
 *
 * The isolation guarantees the SDK promises are enforced here: a scoped context per
 * instance, an abort signal and timeout on every refresh, single-flight refreshes,
 * and a crash barrier that backs a failing module off instead of letting it take the
 * scheduler with it.
 */
export class ModuleRuntimeManager {
  readonly #instances = new Map<string, ManagedInstance>();
  readonly #store: Store;
  readonly #registry: ModuleRegistry;
  readonly #events: EventBus;
  readonly #logger: AppLogger;
  readonly #host: HostServiceBundle;
  readonly #now: () => Date;
  #timezone: string;

  constructor(options: RuntimeManagerOptions) {
    this.#store = options.store;
    this.#registry = options.registry;
    this.#events = options.events;
    this.#logger = options.logger.child({ component: 'runtime-manager' });
    this.#host = options.host;
    this.#now = options.now ?? (() => new Date());
    this.#timezone = options.timezone ?? 'UTC';
  }

  setTimezone(timezone: string): void {
    this.#timezone = timezone;
  }

  list(): ManagedInstance[] {
    return [...this.#instances.values()];
  }

  get(instanceId: string): ManagedInstance | null {
    return this.#instances.get(instanceId) ?? null;
  }

  require(instanceId: string): ManagedInstance {
    const instance = this.#instances.get(instanceId);
    if (!instance) {
      throw new AppError('MODULE_NOT_FOUND', `Module instance "${instanceId}" is not running.`);
    }
    return instance;
  }

  /** Starts every enabled instance found in the database. */
  async startAll(): Promise<void> {
    for (const record of this.#store.moduleInstances.list()) {
      if (!record.enabled) continue;
      await this.startInstance(record).catch((error) => {
        this.#logger.error(
          { instanceId: record.id, moduleId: record.moduleId, err: error },
          'Module instance failed to start',
        );
      });
    }
  }

  async startInstance(record: ModuleInstanceRecord): Promise<ManagedInstance | null> {
    const entry = this.#registry.tryGet(record.moduleId);
    if (!entry) {
      this.#logger.warn(
        { instanceId: record.id, moduleId: record.moduleId },
        'No definition for instance',
      );
      this.#store.moduleInstances.update(record.id, {
        healthStatus: 'error',
        healthMessage: `Module "${record.moduleId}" is not available in this build.`,
        lastErrorCode: 'MODULE_NOT_FOUND',
      });
      return null;
    }

    await this.stopInstance(record.id);

    const ctx = this.createContext(record, entry);
    const runtime = entry.module.createRuntime(ctx);

    const instance: ManagedInstance = {
      record,
      entry,
      runtime,
      health: { status: 'unknown' },
      lastRefreshAt: record.lastRefreshAt,
      nextRefreshAt: null,
      consecutiveFailures: 0,
      frameCache: new Map(),
      frameCacheKey: null,
      refreshInFlight: null,
      refreshQueued: false,
      started: false,
      persistedSnapshot: null,
    };
    this.#instances.set(record.id, instance);

    try {
      await runtime.start();
      instance.started = true;
    } catch (error) {
      const appError = toAppError(error, 'Module failed to start');
      this.#logger.error({ instanceId: record.id, err: appError }, 'Module start failed');
      this.setHealth(instance, { status: 'error', message: appError.message, code: appError.code });
      return instance;
    }

    this.restoreSnapshot(instance);
    return instance;
  }

  async stopInstance(instanceId: string): Promise<void> {
    const instance = this.#instances.get(instanceId);
    if (!instance) return;
    this.#instances.delete(instanceId);
    if (!instance.started) return;
    try {
      await instance.runtime.stop();
    } catch (error) {
      this.#logger.warn({ instanceId, err: error }, 'Module stop threw; continuing');
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#instances.keys()].map((id) => this.stopInstance(id)));
  }

  /** Re-creates a running instance after its settings changed. */
  async reload(instanceId: string): Promise<ManagedInstance | null> {
    const record = this.#store.moduleInstances.get(instanceId);
    if (!record) {
      await this.stopInstance(instanceId);
      return null;
    }
    if (!record.enabled) {
      await this.stopInstance(instanceId);
      this.#store.moduleInstances.update(instanceId, {
        healthStatus: 'disabled',
        healthMessage: null,
      });
      return null;
    }
    return this.startInstance(record);
  }

  /**
   * Refreshes one instance.
   *
   * Concurrent requests coalesce into the in-flight run rather than stacking, which is
   * what stops a manual refresh during a slow poll from doubling provider traffic.
   */
  async refresh(instanceId: string, reason: RefreshReason): Promise<unknown> {
    const instance = this.require(instanceId);

    if (instance.refreshInFlight) {
      instance.refreshQueued = true;
      return instance.refreshInFlight;
    }

    const run = this.performRefresh(instance, reason).finally(() => {
      instance.refreshInFlight = null;
      if (instance.refreshQueued) {
        instance.refreshQueued = false;
        void this.refresh(instanceId, 'event').catch(() => undefined);
      }
    });
    instance.refreshInFlight = run;
    return run;
  }

  private async performRefresh(instance: ManagedInstance, reason: RefreshReason): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error('Refresh timed out')),
      DEFAULT_REFRESH_TIMEOUT_MS,
    );
    const startedAt = this.#now();

    try {
      const snapshot = await instance.runtime.refresh(reason, controller.signal);
      instance.lastRefreshAt = startedAt.toISOString();
      instance.consecutiveFailures = 0;
      this.invalidateFrames(instance);
      this.persistSnapshot(instance, snapshot);

      const health = await instance.runtime
        .getHealth()
        .catch(() => ({ status: 'unknown' as HealthStatus }));
      this.setHealth(instance, health);

      this.#store.moduleInstances.update(instance.record.id, {
        lastRefreshAt: instance.lastRefreshAt,
        ...(health.status === 'healthy' ? { lastSuccessAt: nowIso(), lastErrorCode: null } : {}),
      });
      this.#events.emit('module.snapshot', {
        instanceId: instance.record.id,
        moduleId: instance.record.moduleId,
        at: nowIso(),
      });
      return snapshot;
    } catch (error) {
      const appError = toAppError(error, 'Module refresh failed');
      instance.consecutiveFailures += 1;
      instance.lastRefreshAt = startedAt.toISOString();
      this.invalidateFrames(instance);

      const health = await instance.runtime.getHealth().catch(() => ({
        status: 'error' as HealthStatus,
        message: appError.message,
        code: appError.code,
      }));
      this.setHealth(instance, health);

      this.#store.moduleInstances.update(instance.record.id, {
        lastRefreshAt: instance.lastRefreshAt,
        lastErrorCode: appError.code,
      });
      this.#logger.warn(
        {
          instanceId: instance.record.id,
          code: appError.code,
          failures: instance.consecutiveFailures,
        },
        'Module refresh failed',
      );
      throw appError;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Extra delay applied by the scheduler while an instance keeps failing. */
  backoffMs(instance: ManagedInstance): number {
    if (instance.consecutiveFailures === 0) return 0;
    const index = Math.min(instance.consecutiveFailures - 1, CRASH_BACKOFF_MS.length - 1);
    return CRASH_BACKOFF_MS[index] ?? 0;
  }

  async getFrames(
    instanceId: string,
    options: { viewIds?: string[]; force?: boolean } = {},
  ): Promise<ModuleFrame[]> {
    const instance = this.require(instanceId);
    const now = this.#now();
    const accent = (instance.record.settings['accent'] as SemanticColor | undefined) ?? 'blue';

    // Minute-resolution cache key: relative text ("in 38m") must stay current without
    // rebuilding frames on every rotation tick.
    const cacheKey = `${Math.floor(now.getTime() / 60_000)}:${options.viewIds?.join(',') ?? '*'}`;
    if (!options.force && instance.frameCacheKey === cacheKey && instance.frameCache.size > 0) {
      const cached = [...instance.frameCache.values()];
      const wanted = options.viewIds;
      return wanted ? cached.filter((frame) => wanted.includes(frame.viewId)) : cached;
    }

    const ctx: FrameContext = {
      ...(options.viewIds ? { viewIds: options.viewIds } : {}),
      now,
      timezone: this.#timezone,
      accent,
    };

    let drafts: ModuleFrameDraft[];
    try {
      drafts = await instance.runtime.getFrames(ctx);
    } catch (error) {
      const appError = toAppError(error, 'Module frame build failed');
      this.#logger.error({ instanceId, err: appError }, 'Frame build failed');
      drafts = [errorFrameDraft(instance, appError)];
    }

    const frames = drafts.map((draft) => finalizeFrame(draft, { now }));
    instance.frameCache = new Map(frames.map((frame) => [frame.id, frame]));
    instance.frameCacheKey = cacheKey;

    const wanted = options.viewIds;
    return wanted ? frames.filter((frame) => wanted.includes(frame.viewId)) : frames;
  }

  async runAction(
    instanceId: string,
    actionId: string,
    input: unknown,
  ): Promise<ModuleActionResult> {
    const instance = this.require(instanceId);
    const definition = instance.entry.manifest.actions?.find((action) => action.id === actionId);

    if (actionId === 'core.refreshNow') {
      await this.refresh(instanceId, 'manual').catch(() => undefined);
      const health = await instance.runtime
        .getHealth()
        .catch((): ModuleHealth => ({ status: 'unknown' }));
      return { ok: health.status !== 'error', message: health.message ?? 'Refreshed.' };
    }

    if (!definition) {
      throw new AppError(
        'MODULE_ACTION_UNKNOWN',
        `Module "${instance.record.moduleId}" has no action "${actionId}".`,
      );
    }
    if (!instance.runtime.runAction) {
      throw new AppError(
        'MODULE_ACTION_UNKNOWN',
        `Module "${instance.record.moduleId}" implements no actions.`,
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error('Action timed out')),
      definition.timeoutMs,
    );
    try {
      return await instance.runtime.runAction(actionId, input, controller.signal);
    } catch (error) {
      const appError = toAppError(error, 'Action failed');
      return { ok: false, message: appError.message, code: appError.code };
    } finally {
      clearTimeout(timeout);
    }
  }

  async getStatusPanel(instanceId: string): Promise<ModuleActionResult['panel'] | null> {
    const instance = this.#instances.get(instanceId);
    if (!instance?.runtime.getStatusPanel) return null;
    try {
      return await instance.runtime.getStatusPanel();
    } catch (error) {
      this.#logger.debug({ instanceId, err: error }, 'Status panel failed');
      return null;
    }
  }

  invalidateFrames(instance: ManagedInstance): void {
    instance.frameCache.clear();
    instance.frameCacheKey = null;
  }

  invalidateFramesFor(instanceId: string): void {
    const instance = this.#instances.get(instanceId);
    if (instance) this.invalidateFrames(instance);
  }

  private setHealth(
    instance: ManagedInstance,
    health: { status: HealthStatus; message?: string; code?: string },
  ): void {
    const changed =
      instance.health.status !== health.status || instance.health.message !== health.message;
    instance.health = health;
    this.#store.moduleInstances.update(instance.record.id, {
      healthStatus: health.status,
      healthMessage: health.message ?? null,
      ...(health.code ? { lastErrorCode: health.code } : {}),
    });
    if (changed) {
      this.#events.emit('module.health', {
        instanceId: instance.record.id,
        moduleId: instance.record.moduleId,
        status: health.status,
        ...(health.message ? { message: health.message } : {}),
        ...(health.code ? { code: health.code } : {}),
      });
    }
  }

  private persistSnapshot(instance: ManagedInstance, snapshot: unknown): void {
    if (snapshot === null || snapshot === undefined) return;

    // A module with no new data returns its previous snapshot unchanged, which is how
    // a stale reading stays on screen with a badge. Rewriting the row on every cycle
    // would hand that reading a fresh TTL each time, so it could never age out and a
    // restart hours later would restore it as though it were current.
    const serialized = stableStringify(snapshot);
    if (serialized === instance.persistedSnapshot) return;

    const expiresAt = new Date(this.#now().getTime() + SNAPSHOT_TTL_SECONDS * 1000).toISOString();
    const stored = this.#store.snapshots.put({
      moduleInstanceId: instance.record.id,
      schemaVersion: instance.entry.manifest.settingsVersion,
      snapshot,
      capturedAt: this.#now().toISOString(),
      expiresAt,
    });
    if (!stored) {
      this.#logger.warn(
        { instanceId: instance.record.id },
        'Snapshot exceeded the size cap and was not persisted',
      );
      return;
    }
    instance.persistedSnapshot = serialized;
  }

  private restoreSnapshot(instance: ManagedInstance): void {
    const stored = this.#store.snapshots.get(instance.record.id);
    if (!stored) return;

    // An expired snapshot is worse than none: it would display as current data.
    if (Date.parse(stored.expiresAt) <= this.#now().getTime()) {
      this.#store.snapshots.delete(instance.record.id);
      return;
    }
    const validator = instance.entry.module.snapshotIsValid;
    if (validator && !validator(stored.snapshot)) {
      this.#store.snapshots.delete(instance.record.id);
      return;
    }
    instance.persistedSnapshot = stableStringify(stored.snapshot);
    instance.runtime.hydrate?.(stored.snapshot, stored.capturedAt);
  }

  private createContext(
    record: ModuleInstanceRecord,
    entry: RegistryEntry,
  ): ModuleContext<unknown> {
    const permissions = entry.manifest.permissions as readonly ModulePermission[];
    const logger = this.#logger.child({ moduleId: record.moduleId, instanceId: record.id });

    return {
      instanceId: record.id,
      moduleId: record.moduleId,
      instanceName: record.name,
      settings: settingsWithDefaults(entry.module.defaultSettings, record.settings),
      logger: {
        debug: (payload, message) => logChild(logger, 'debug', payload, message),
        info: (payload, message) => logChild(logger, 'info', payload, message),
        warn: (payload, message) => logChild(logger, 'warn', payload, message),
        error: (payload, message) => logChild(logger, 'error', payload, message),
      },
      http: new PermissionScopedHttpClient(allowedHostsFor(permissions), record.moduleId),
      secrets: new InstanceScopedSecrets(
        this.#store,
        record.id,
        entry.module.secretKeys,
        permissions.includes('secrets:read-own'),
      ),
      state: new InstanceScopedState(this.#store, record.id),
      events: {
        requestDisplayRefresh: (reason) =>
          this.#events.emit('module.display-refresh', { instanceId: record.id, reason }),
        requestAttention: (requested) =>
          this.#events.emit('module.attention', {
            instanceId: record.id,
            moduleId: record.moduleId,
            viewId: requested.viewId,
            key: requested.key,
            holdSeconds: requested.holdSeconds,
            reason: requested.reason,
          }),
        releaseAttention: (key) =>
          this.#events.emit('module.attention-released', { instanceId: record.id, key }),
        reportHealth: (status, message, code) => {
          const instance = this.#instances.get(record.id);
          if (instance) {
            this.setHealth(instance, {
              status,
              ...(message ? { message } : {}),
              ...(code ? { code } : {}),
            });
          }
        },
      },
      now: this.#now,
      // Host services are granted strictly by declared permission.
      host: {
        ...(permissions.includes('host:claude-cli-status') && this.#host.claudeCli
          ? { claudeCli: this.#host.claudeCli }
          : {}),
        ...(permissions.includes('host:claude-settings-write') && this.#host.claudeSettings
          ? { claudeSettings: this.#host.claudeSettings }
          : {}),
        ...(permissions.includes('host:claude-cli-status') && this.#host.bridgeInbox
          ? { bridgeInbox: this.#host.bridgeInbox }
          : {}),
      },
    };
  }
}

function logChild(
  logger: AppLogger,
  level: 'debug' | 'info' | 'warn' | 'error',
  payload: Record<string, unknown> | string,
  message?: string,
): void {
  if (typeof payload === 'string') logger[level](payload);
  else logger[level](payload, message);
}

function errorFrameDraft(instance: ManagedInstance, error: AppError): ModuleFrameDraft {
  const view = instance.entry.manifest.views[0];
  return {
    id: `${instance.record.id}-error`,
    viewId: view?.id ?? 'error',
    title: instance.entry.manifest.displayName,
    icon: instance.entry.manifest.icon,
    accent: 'red',
    priority: 'normal',
    layout: {
      kind: 'error',
      severity: 'error',
      headline: 'Module error',
      detail: error.message,
      code: error.code,
    },
  };
}

/**
 * Stored settings laid over the module's defaults.
 *
 * A settings row is written once and then read for the life of the instance, so a key
 * the module gains later is simply absent from it. Passing the row through unchanged
 * makes that key `undefined` at runtime, and any feature gated on it silently never
 * runs — the instance stays healthy and merely stops doing the new thing, which is the
 * hardest kind of regression to notice. Shallow, matching `SettingsValidator`, so the
 * settings a runtime sees are the settings validation would have produced.
 */
export function settingsWithDefaults(defaults: unknown, stored: unknown): unknown {
  if (!isPlainObject(defaults)) return stored;
  if (!isPlainObject(stored)) return defaults;
  return { ...defaults, ...stored };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
