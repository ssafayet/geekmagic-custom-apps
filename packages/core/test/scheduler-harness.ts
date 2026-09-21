import { randomBytes } from 'node:crypto';
import { createStore, type Store } from '@gca/database';
import { SecretVault } from '@gca/secrets';
import { computeFrameFingerprint, type ModuleFrame, type ModuleFrameDraft } from '@gca/module-sdk';
import type { EncodedFrame, FrameRenderer } from '@gca/renderer';
import type { UploadOutcome } from '@gca/device-core';
import { createLogger } from '../src/logger.js';
import { EventBus } from '../src/events.js';
import { Scheduler } from '../src/scheduler.js';
import type { DeviceManager } from '../src/device-manager.js';
import type { ManagedInstance, ModuleRuntimeManager } from '../src/runtime-manager.js';

/**
 * Minimal stand-ins for the runtime and device managers.
 *
 * The scheduler is the unit under test here, so its collaborators are reduced to the
 * few methods it actually calls. Rendering is stubbed too: pixel output is covered by
 * the visual suite, and a real rasterize per tick would dominate the runtime.
 */

export interface FakeModule {
  id: string;
  frames: Map<string, ModuleFrameDraft>;
  refreshCount: number;
  refreshDelayMs: number;
  failures: number;
  consecutiveFailures: number;
}

export function draft(id: string, headline: string, viewId = 'main'): ModuleFrameDraft {
  return {
    id,
    viewId,
    title: id,
    accent: 'blue',
    priority: 'normal',
    layout: { kind: 'empty', icon: 'radar', headline },
  };
}

export class SchedulerHarness {
  readonly store: Store;
  readonly events = new EventBus();
  readonly scheduler: Scheduler;
  readonly modules = new Map<string, FakeModule>();
  readonly uploads: Array<{ deviceId: string; frameId: string; fingerprint: string }> = [];

  /** Pushed frames rejected by the fake device, keyed by device id. */
  readonly failUploadsFor = new Set<string>();
  #clock = 1_000_000;

  constructor() {
    this.store = createStore({ file: ':memory:' }, new SecretVault(randomBytes(32)));
    this.scheduler = new Scheduler({
      store: this.store,
      runtimes: this.fakeRuntimes(),
      devices: this.fakeDevices(),
      events: this.events,
      logger: createLogger({ level: 'silent', pretty: false }),
      renderer: this.fakeRenderer(),
      interruptCooldownMs: 15_000,
      now: () => this.#clock,
    });
  }

  get now(): number {
    return this.#clock;
  }

  advance(ms: number): void {
    this.#clock += ms;
  }

  addModule(
    id: string,
    frames: ModuleFrameDraft[],
    options: { refreshDelayMs?: number } = {},
  ): FakeModule {
    const module: FakeModule = {
      id,
      frames: new Map(frames.map((frame) => [frame.viewId, frame])),
      refreshCount: 0,
      refreshDelayMs: options.refreshDelayMs ?? 0,
      failures: 0,
      consecutiveFailures: 0,
    };
    this.modules.set(id, module);
    this.store.moduleInstances.insert({
      id,
      moduleId: id,
      name: id,
      enabled: true,
      settingsVersion: 1,
      settings: { pollIntervalSeconds: 15 },
      healthStatus: 'healthy',
      healthMessage: null,
      lastSuccessAt: null,
      lastErrorCode: null,
      lastRefreshAt: null,
    });
    return module;
  }

  setFrame(moduleId: string, viewId: string, frame: ModuleFrameDraft | null): void {
    const module = this.modules.get(moduleId);
    if (!module) throw new Error(`unknown fake module ${moduleId}`);
    if (frame) module.frames.set(viewId, frame);
    else module.frames.delete(viewId);
  }

  addDevice(deviceId: string): void {
    this.store.devices.insert({
      id: deviceId,
      name: deviceId,
      host: `${deviceId}.local`,
      profileId: 'stock-ultra',
      modelName: null,
      firmwareVersion: null,
      capabilities: {
        canUploadImage: true,
        canSetBrightness: true,
        canListFiles: false,
        canDeleteFiles: false,
        requiresAlbumManagement: false,
        canReadState: true,
        supportsBackup: false,
        notes: [],
      },
      albumManagementConsent: true,
      active: true,
      minimumUploadIntervalSeconds: 0,
      lastSeenAt: null,
      lastUploadHash: null,
      lastUploadAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    });
  }

  setPlaylist(
    deviceId: string,
    items: Array<{ moduleInstanceId: string; viewId: string; dwellSeconds: number }>,
  ): void {
    this.store.playlist.replaceForDevice(
      deviceId,
      items.map((item, index) => ({
        id: `${deviceId}-${index}`,
        deviceId,
        moduleInstanceId: item.moduleInstanceId,
        viewId: item.viewId,
        order: index,
        dwellSeconds: item.dwellSeconds,
        enabled: true,
      })),
    );
  }

  /** Frame ids uploaded to a device, in order. */
  uploadsFor(deviceId: string): string[] {
    return this.uploads
      .filter((upload) => upload.deviceId === deviceId)
      .map((upload) => upload.frameId);
  }

  close(): void {
    this.scheduler.stop();
    this.store.close();
  }

  private fakeRuntimes(): ModuleRuntimeManager {
    const harness = this;
    return {
      list(): ManagedInstance[] {
        return [...harness.modules.keys()].map((id) => harness.managed(id));
      },
      get(instanceId: string): ManagedInstance | null {
        return harness.modules.has(instanceId) ? harness.managed(instanceId) : null;
      },
      backoffMs(instance: ManagedInstance): number {
        const module = harness.modules.get(instance.record.id);
        return module && module.consecutiveFailures > 0 ? 5_000 * module.consecutiveFailures : 0;
      },
      async refresh(instanceId: string): Promise<unknown> {
        const module = harness.modules.get(instanceId);
        if (!module) return null;
        module.refreshCount += 1;
        if (module.refreshDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, module.refreshDelayMs));
        }
        if (module.failures > 0) {
          module.failures -= 1;
          module.consecutiveFailures += 1;
          throw new Error('refresh failed');
        }
        module.consecutiveFailures = 0;
        return {};
      },
      async getFrames(
        instanceId: string,
        options?: { viewIds?: string[] },
      ): Promise<ModuleFrame[]> {
        const module = harness.modules.get(instanceId);
        if (!module) return [];
        const wanted = options?.viewIds;
        const drafts = [...module.frames.entries()]
          .filter(([viewId]) => !wanted || wanted.includes(viewId))
          .map(([, value]) => value);
        return drafts.map((value) => ({
          ...value,
          validUntil: new Date(harness.#clock + 300_000).toISOString(),
          fingerprint: computeFrameFingerprint(value),
        }));
      },
    } as unknown as ModuleRuntimeManager;
  }

  private managed(id: string): ManagedInstance {
    const record = this.store.moduleInstances.get(id);
    return {
      record,
      health: { status: 'healthy' },
      entry: {
        manifest: {
          id,
          refresh: { defaultSeconds: 15, minimumSeconds: 5, maximumSeconds: 600 },
          views: [{ id: 'main', displayName: 'Main' }],
        },
      },
    } as unknown as ManagedInstance;
  }

  /**
   * Inserts a module instance row without registering a running fake for it, so a
   * playlist can reference a module the runtime manager does not have loaded.
   */
  addOrphanInstance(id: string): void {
    this.store.moduleInstances.insert({
      id,
      moduleId: id,
      name: id,
      enabled: false,
      settingsVersion: 1,
      settings: {},
      healthStatus: 'disabled',
      healthMessage: null,
      lastSuccessAt: null,
      lastErrorCode: null,
      lastRefreshAt: null,
    });
  }

  private fakeDevices(): DeviceManager {
    const harness = this;
    return {
      list() {
        return harness.store.devices.list().map((record) => ({ record }));
      },
      async pushFrame(deviceId: string, frame: EncodedFrame): Promise<UploadOutcome> {
        if (harness.failUploadsFor.has(deviceId)) {
          return {
            status: 'failed',
            error: Object.assign(new Error('device down'), {
              code: 'DEVICE_UNREACHABLE',
              retryable: true,
            }) as never,
            attempts: 1,
          };
        }
        harness.uploads.push({ deviceId, frameId: frame.frameId, fingerprint: frame.fingerprint });
        return {
          status: 'uploaded',
          sha256: frame.sha256,
          result: { uploaded: true, verified: true, filename: 'dashboard.jpg', durationMs: 1 },
        };
      },
    } as unknown as DeviceManager;
  }

  private fakeRenderer(): FrameRenderer {
    return {
      async render(frame: ModuleFrame): Promise<EncodedFrame> {
        return {
          frameId: frame.id,
          viewId: frame.viewId,
          bytes: Buffer.from(frame.fingerprint),
          sha256: frame.fingerprint,
          fingerprint: frame.fingerprint,
          width: 240,
          height: 240,
          contentType: 'image/jpeg',
          renderedAt: new Date().toISOString(),
        };
      },
    } as unknown as FrameRenderer;
  }
}
