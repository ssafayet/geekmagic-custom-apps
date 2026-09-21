import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createStore, type Store } from '@gca/database';
import { SecretVault } from '@gca/secrets';
import type { AnyAppModule } from '@gca/module-sdk';
import { EventBus } from '../src/events.js';
import { createLogger } from '../src/logger.js';
import { ModuleRegistry } from '../src/registry.js';
import { ModuleRuntimeManager } from '../src/runtime-manager.js';

/**
 * A module that reports fresh data once and then has nothing new, which is exactly
 * what the Claude module does between status-line payloads: it returns its previous
 * snapshot so the display can keep showing the last value with a stale badge.
 */
function stubbornModule(snapshot: { capturedAt: string; value: number }): AnyAppModule {
  return {
    manifest: {
      id: 'stubborn',
      version: '1.0.0',
      settingsVersion: 1,
      displayName: 'Stubborn',
      description: 'Returns the same snapshot forever.',
      icon: 'gauge',
      category: 'other',
      singleton: true,
      refresh: { defaultSeconds: 60, minimumSeconds: 30, maximumSeconds: 900 },
      permissions: [],
      views: [{ id: 'main', displayName: 'Main' }],
    },
    settingsSchema: { type: 'object', properties: {} },
    uiSchema: { sections: [{ id: 'g', title: 'General' }], fields: {} },
    defaultSettings: {},
    secretKeys: [],
    async validateSettings(settings) {
      return { ok: true, value: settings };
    },
    async migrateSettings(fromVersion, settings) {
      return { version: fromVersion, settings };
    },
    createRuntime() {
      return {
        async start() {},
        async stop() {},
        // Always the identical object: no new data has arrived.
        async refresh() {
          return snapshot;
        },
        getSnapshot: () => snapshot,
        async getFrames() {
          return [];
        },
        async getHealth() {
          return { status: 'degraded' as const, message: 'no new data' };
        },
      };
    },
  } as AnyAppModule;
}

function harness(now: () => Date) {
  const store: Store = createStore({ file: ':memory:' }, new SecretVault(randomBytes(32)));
  const snapshot = { capturedAt: '2026-09-21T12:00:00.000Z', value: 42 };
  const registry = new ModuleRegistry([stubbornModule(snapshot)]);
  const runtimes = new ModuleRuntimeManager({
    store,
    registry,
    events: new EventBus(),
    logger: createLogger({ level: 'silent', pretty: false }),
    host: {},
    now,
  });

  const record = store.moduleInstances.insert({
    id: 'inst',
    moduleId: 'stubborn',
    name: 'Stubborn',
    enabled: true,
    settingsVersion: 1,
    settings: {},
    healthStatus: 'unknown',
    healthMessage: null,
    lastSuccessAt: null,
    lastErrorCode: null,
    lastRefreshAt: null,
  });

  return { store, runtimes, record };
}

describe('snapshot expiry', () => {
  it('does not push the expiry forward when a module returns unchanged data', async () => {
    let clock = new Date('2026-09-21T12:00:00.000Z');
    const { store, runtimes, record } = harness(() => clock);
    await runtimes.startInstance(record);

    await runtimes.refresh('inst', 'scheduled');
    const first = store.snapshots.get('inst');
    expect(first).not.toBeNull();

    // Ten minutes later the module still has nothing new to report.
    clock = new Date('2026-09-21T12:10:00.000Z');
    await runtimes.refresh('inst', 'scheduled');
    const second = store.snapshots.get('inst');

    // Rewriting the row here would give a stale reading a fresh 15 minutes of life
    // on every cycle, so it could never age out and a restart would resurrect it.
    expect(second?.expiresAt).toBe(first?.expiresAt);
    expect(second?.capturedAt).toBe(first?.capturedAt);

    await runtimes.stopAll();
    store.close();
  });

  it('lets an unchanged snapshot actually expire', async () => {
    let clock = new Date('2026-09-21T12:00:00.000Z');
    const { store, runtimes, record } = harness(() => clock);
    await runtimes.startInstance(record);
    await runtimes.refresh('inst', 'scheduled');

    // Keep refreshing well past the 15-minute TTL.
    for (const minutes of [5, 10, 14, 16, 20]) {
      clock = new Date(`2026-09-21T12:${String(minutes).padStart(2, '0')}:00.000Z`);
      await runtimes.refresh('inst', 'scheduled');
    }

    expect(store.snapshots.purgeExpired(clock.toISOString())).toBe(1);

    await runtimes.stopAll();
    store.close();
  });

  it('still persists a snapshot whose content genuinely changed', async () => {
    const store: Store = createStore({ file: ':memory:' }, new SecretVault(randomBytes(32)));
    let clock = new Date('2026-09-21T12:00:00.000Z');
    let value = 0;

    const moduleDef = stubbornModule({ capturedAt: 'x', value: 0 });
    moduleDef.createRuntime = () => ({
      async start() {},
      async stop() {},
      async refresh() {
        return { capturedAt: clock.toISOString(), value: value++ };
      },
      getSnapshot: () => null,
      async getFrames() {
        return [];
      },
      async getHealth() {
        return { status: 'healthy' as const };
      },
    });

    const runtimes = new ModuleRuntimeManager({
      store,
      registry: new ModuleRegistry([moduleDef]),
      events: new EventBus(),
      logger: createLogger({ level: 'silent', pretty: false }),
      host: {},
      now: () => clock,
    });

    const record = store.moduleInstances.insert({
      id: 'inst',
      moduleId: 'stubborn',
      name: 'S',
      enabled: true,
      settingsVersion: 1,
      settings: {},
      healthStatus: 'unknown',
      healthMessage: null,
      lastSuccessAt: null,
      lastErrorCode: null,
      lastRefreshAt: null,
    });
    await runtimes.startInstance(record);

    await runtimes.refresh('inst', 'scheduled');
    const first = store.snapshots.get('inst');

    clock = new Date('2026-09-21T12:05:00.000Z');
    await runtimes.refresh('inst', 'scheduled');
    const second = store.snapshots.get('inst');

    // New data must refresh both the content and the expiry.
    expect(second?.expiresAt).not.toBe(first?.expiresAt);
    expect((second?.snapshot as { value: number }).value).toBe(1);

    await runtimes.stopAll();
    store.close();
  });
});
