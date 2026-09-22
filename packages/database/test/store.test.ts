import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SecretVault } from '@gca/secrets';
import {
  createStore,
  currentSchemaVersion,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  openDatabase,
  type Store,
} from '../src/index.js';
import { capabilitiesStub } from './helpers.js';

function memoryStore(): Store {
  return createStore({ file: ':memory:' }, new SecretVault(randomBytes(32)));
}

describe('migrations', () => {
  it('brings a fresh database to the latest schema version', () => {
    const { db, migration } = openDatabase({ file: ':memory:' });
    expect(migration?.from).toBe(0);
    expect(migration?.to).toBe(LATEST_SCHEMA_VERSION);
    expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  it('is idempotent on an already-migrated database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gca-db-'));
    const file = join(dir, 'app.db');

    const first = openDatabase({ file });
    expect(first.migration?.applied.length).toBeGreaterThan(0);
    first.db.close();

    const second = openDatabase({ file });
    expect(second.migration?.applied).toEqual([]);
    second.db.close();
  });

  it('creates every table the application relies on', () => {
    const { db } = openDatabase({ file: ':memory:' });
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    )
      .map((row) => row.name)
      .filter((name) => !name.startsWith('sqlite_'));

    for (const table of [
      'devices',
      'module_instances',
      'module_secrets',
      'module_snapshots',
      'module_state',
      'device_playlist_items',
      'device_backups',
      'audit_events',
      'app_settings',
    ]) {
      expect(names).toContain(table);
    }
    db.close();
  });

  it('declares a reversible down migration for the initial schema', () => {
    expect(MIGRATIONS[0]?.down).toBeTruthy();
  });

  it('enforces the unique playlist ordering constraint', () => {
    const { db } = openDatabase({ file: ':memory:' });
    db.prepare(
      `INSERT INTO devices (id,name,host,profile_id,capabilities_json,album_management_consent,active,minimum_upload_interval_seconds,created_at,updated_at)
       VALUES ('d1','D','h','stock-ultra','{}',0,1,15,'t','t')`,
    ).run();
    db.prepare(
      `INSERT INTO module_instances (id,module_id,name,enabled,settings_version,settings_json,health_status,created_at,updated_at)
       VALUES ('m1','x','X',1,1,'{}','unknown','t','t')`,
    ).run();

    const insert = db.prepare(
      `INSERT INTO device_playlist_items (id,device_id,module_instance_id,view_id,sort_order,dwell_seconds,enabled)
       VALUES (?,?,?,?,?,?,?)`,
    );
    insert.run('p1', 'd1', 'm1', 'v', 0, 20, 1);
    expect(() => insert.run('p2', 'd1', 'm1', 'v2', 0, 20, 1)).toThrow(/UNIQUE/i);
    db.close();
  });
});

describe('device repository', () => {
  let store: Store;
  beforeEach(() => {
    store = memoryStore();
  });

  it('round-trips a device including its capabilities object', () => {
    const record = store.devices.insert({
      id: 'd1',
      name: 'Desk',
      host: '192.168.1.5',
      profileId: 'stock-pro',
      modelName: 'SmallTV PRO',
      firmwareVersion: '2.0.7',
      capabilities: capabilitiesStub(),
      albumManagementConsent: false,
      active: true,
      minimumUploadIntervalSeconds: 15,
      lastSeenAt: null,
      lastUploadHash: null,
      lastUploadAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    });

    const loaded = store.devices.get('d1');
    expect(loaded).toMatchObject({ name: 'Desk', profileId: 'stock-pro' });
    expect(loaded?.capabilities.requiresAlbumManagement).toBe(true);
    expect(loaded?.createdAt).toBe(record.createdAt);
  });

  it('coerces booleans across the SQLite integer boundary', () => {
    store.devices.insert({
      id: 'd1',
      name: 'D',
      host: 'h',
      profileId: 'stock-ultra',
      modelName: null,
      firmwareVersion: null,
      capabilities: capabilitiesStub(),
      albumManagementConsent: false,
      active: true,
      minimumUploadIntervalSeconds: 15,
      lastSeenAt: null,
      lastUploadHash: null,
      lastUploadAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    });

    store.devices.update('d1', { albumManagementConsent: true, active: false });
    const loaded = store.devices.get('d1');

    expect(loaded?.albumManagementConsent).toBe(true);
    expect(loaded?.active).toBe(false);
  });

  it('rejects two devices on the same host', () => {
    const base = {
      name: 'D',
      host: '192.168.1.5',
      profileId: 'stock-ultra' as const,
      modelName: null,
      firmwareVersion: null,
      capabilities: capabilitiesStub(),
      albumManagementConsent: false,
      active: true,
      minimumUploadIntervalSeconds: 15,
      lastSeenAt: null,
      lastUploadHash: null,
      lastUploadAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    };
    store.devices.insert({ ...base, id: 'd1' });
    expect(() => store.devices.insert({ ...base, id: 'd2' })).toThrow(/UNIQUE/i);
  });

  it('clears a nullable column when set to null', () => {
    store.devices.insert({
      id: 'd1',
      name: 'D',
      host: 'h',
      profileId: 'stock-ultra',
      modelName: null,
      firmwareVersion: null,
      capabilities: capabilitiesStub(),
      albumManagementConsent: false,
      active: true,
      minimumUploadIntervalSeconds: 15,
      lastSeenAt: null,
      lastUploadHash: 'abc',
      lastUploadAt: null,
      lastErrorCode: 'X',
      lastErrorMessage: 'Y',
    });

    store.devices.update('d1', { lastErrorCode: null, lastErrorMessage: null });
    expect(store.devices.get('d1')?.lastErrorCode).toBeNull();
  });
});

describe('secret repository', () => {
  it('stores ciphertext and never the plaintext', () => {
    const store = memoryStore();
    store.secrets.set('mod_1', 'adminApiKey', 'sk-ant-admin-7K2P');

    const raw = store.secrets.listRaw('mod_1');
    expect(raw).toHaveLength(1);
    expect(raw[0]?.ciphertext.toString('utf8')).not.toContain('sk-ant');
    expect(raw[0]?.lastFour).toBe('7K2P');
    expect(store.secrets.reveal('mod_1', 'adminApiKey')).toBe('sk-ant-admin-7K2P');
  });

  it('reports state without revealing the value', () => {
    const store = memoryStore();
    store.secrets.set('mod_1', 'adminApiKey', 'sk-ant-admin-7K2P');

    const state = store.secrets.state('mod_1', 'adminApiKey');
    expect(state).toMatchObject({ configured: true, lastFour: '7K2P' });
    expect(JSON.stringify(state)).not.toContain('sk-ant');
  });

  it('overwrites on repeated set and removes on delete', () => {
    const store = memoryStore();
    store.secrets.set('mod_1', 'k', 'first-value');
    store.secrets.set('mod_1', 'k', 'second-value');
    expect(store.secrets.reveal('mod_1', 'k')).toBe('second-value');
    expect(store.secrets.listRaw('mod_1')).toHaveLength(1);

    store.secrets.remove('mod_1', 'k');
    expect(store.secrets.state('mod_1', 'k').configured).toBe(false);
    expect(store.secrets.reveal('mod_1', 'k')).toBeNull();
  });

  it('keeps secrets isolated between instances', () => {
    const store = memoryStore();
    store.secrets.set('mod_1', 'k', 'one');
    store.secrets.set('mod_2', 'k', 'two');
    expect(store.secrets.reveal('mod_1', 'k')).toBe('one');
    expect(store.secrets.reveal('mod_2', 'k')).toBe('two');
  });
});

describe('snapshot repository', () => {
  it('round-trips and expires snapshots', () => {
    const store = memoryStore();
    const past = new Date(Date.now() - 1000).toISOString();

    store.snapshots.put({
      moduleInstanceId: 'm1',
      schemaVersion: 1,
      snapshot: { a: 1 },
      expiresAt: past,
    });
    expect(store.snapshots.get('m1')?.snapshot).toEqual({ a: 1 });

    expect(store.snapshots.purgeExpired()).toBe(1);
    expect(store.snapshots.get('m1')).toBeNull();
  });

  it('refuses to persist an oversized snapshot', () => {
    const store = memoryStore();
    const huge = { blob: 'x'.repeat(200_000) };
    const future = new Date(Date.now() + 60_000).toISOString();

    expect(
      store.snapshots.put({
        moduleInstanceId: 'm1',
        schemaVersion: 1,
        snapshot: huge,
        expiresAt: future,
      }),
    ).toBe(false);
    expect(store.snapshots.get('m1')).toBeNull();
  });
});

describe('module instance deletion', () => {
  it('cascades to secrets, snapshots, state and playlist entries', () => {
    const store = memoryStore();
    store.devices.insert({
      id: 'd1',
      name: 'D',
      host: 'h',
      profileId: 'stock-ultra',
      modelName: null,
      firmwareVersion: null,
      capabilities: capabilitiesStub(),
      albumManagementConsent: false,
      active: true,
      minimumUploadIntervalSeconds: 15,
      lastSeenAt: null,
      lastUploadHash: null,
      lastUploadAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    });
    store.moduleInstances.insert({
      id: 'm1',
      moduleId: 'adsb-monitor',
      name: 'Sky',
      enabled: true,
      settingsVersion: 1,
      settings: { latitude: 51 },
      healthStatus: 'unknown',
      healthMessage: null,
      lastSuccessAt: null,
      lastErrorCode: null,
      lastRefreshAt: null,
    });
    store.secrets.set('m1', 'k', 'v');
    store.snapshots.put({
      moduleInstanceId: 'm1',
      schemaVersion: 1,
      snapshot: {},
      expiresAt: new Date(Date.now() + 1000).toISOString(),
    });
    store.moduleState.set('m1', 'overhead', [{ hex: 'abc' }]);
    store.playlist.replaceForDevice('d1', [
      {
        id: 'p1',
        deviceId: 'd1',
        moduleInstanceId: 'm1',
        viewId: 'aircraft',
        order: 0,
        dwellSeconds: 20,
        enabled: true,
      },
    ]);

    store.moduleInstances.delete('m1');

    expect(store.moduleInstances.get('m1')).toBeNull();
    expect(store.secrets.listRaw('m1')).toEqual([]);
    expect(store.snapshots.get('m1')).toBeNull();
    expect(store.moduleState.get('m1', 'overhead')).toBeNull();
    expect(store.playlist.listForDevice('d1')).toEqual([]);
  });
});

describe('playlist repository', () => {
  it('replaces a device playlist atomically and renumbers order', () => {
    const store = memoryStore();
    store.devices.insert({
      id: 'd1',
      name: 'D',
      host: 'h',
      profileId: 'stock-ultra',
      modelName: null,
      firmwareVersion: null,
      capabilities: capabilitiesStub(),
      albumManagementConsent: false,
      active: true,
      minimumUploadIntervalSeconds: 15,
      lastSeenAt: null,
      lastUploadHash: null,
      lastUploadAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    });
    for (const id of ['m1', 'm2']) {
      store.moduleInstances.insert({
        id,
        moduleId: 'x',
        name: id,
        enabled: true,
        settingsVersion: 1,
        settings: {},
        healthStatus: 'unknown',
        healthMessage: null,
        lastSuccessAt: null,
        lastErrorCode: null,
        lastRefreshAt: null,
      });
    }

    store.playlist.replaceForDevice('d1', [
      {
        id: 'p1',
        deviceId: 'd1',
        moduleInstanceId: 'm1',
        viewId: 'a',
        order: 5,
        dwellSeconds: 20,
        enabled: true,
      },
      {
        id: 'p2',
        deviceId: 'd1',
        moduleInstanceId: 'm2',
        viewId: 'b',
        order: 9,
        dwellSeconds: 30,
        enabled: false,
      },
    ]);

    const items = store.playlist.listForDevice('d1');
    expect(items.map((item) => item.order)).toEqual([0, 1]);
    expect(items[1]).toMatchObject({ dwellSeconds: 30, enabled: false });

    // Reversing the order must not collide with the unique index.
    store.playlist.replaceForDevice('d1', [
      {
        id: 'p2',
        deviceId: 'd1',
        moduleInstanceId: 'm2',
        viewId: 'b',
        order: 0,
        dwellSeconds: 30,
        enabled: true,
      },
      {
        id: 'p1',
        deviceId: 'd1',
        moduleInstanceId: 'm1',
        viewId: 'a',
        order: 1,
        dwellSeconds: 20,
        enabled: true,
      },
    ]);
    expect(store.playlist.listForDevice('d1').map((item) => item.moduleInstanceId)).toEqual([
      'm2',
      'm1',
    ]);
  });
});

describe('audit repository', () => {
  it('redacts sensitive details before they are written', () => {
    const store = memoryStore();
    store.audit.record({
      eventType: 'module.updated',
      entityType: 'module-instance',
      entityId: 'm1',
      details: { apiKey: 'sk-ant-secret', changed: ['source'], nested: { token: 'abc' } },
    });

    const [event] = store.audit.recent(1);
    expect(event?.details['apiKey']).toBe('[redacted]');
    expect((event?.details['nested'] as Record<string, unknown>)['token']).toBe('[redacted]');
    expect(event?.details['changed']).toEqual(['source']);
  });

  it('returns only warnings and errors from recentProblems', () => {
    const store = memoryStore();
    store.audit.record({ eventType: 'a', entityType: 'app' });
    store.audit.record({ eventType: 'b', entityType: 'app', severity: 'warn' });
    store.audit.record({ eventType: 'c', entityType: 'app', severity: 'error' });

    expect(
      store.audit
        .recentProblems()
        .map((event) => event.eventType)
        .sort(),
    ).toEqual(['b', 'c']);
  });

  it('hides acknowledged problems without deleting the events', () => {
    const store = memoryStore();
    store.audit.record({ eventType: 'a', entityType: 'app', severity: 'warn' });
    store.audit.record({ eventType: 'b', entityType: 'app', severity: 'error' });

    expect(store.audit.acknowledgeProblems()).toBe(2);
    expect(store.audit.recentProblems()).toEqual([]);
    expect(store.audit.recent(10)).toHaveLength(2);
    expect(store.audit.recent(10).every((event) => event.acknowledgedAt !== null)).toBe(true);
  });

  it('acknowledges only the named problems and never re-acknowledges', () => {
    const store = memoryStore();
    const first = store.audit.record({ eventType: 'a', entityType: 'app', severity: 'error' });
    store.audit.record({ eventType: 'b', entityType: 'app', severity: 'error' });
    const info = store.audit.record({ eventType: 'c', entityType: 'app' });

    expect(store.audit.acknowledgeProblems({ ids: [first.id, info.id] })).toBe(1);
    expect(store.audit.recentProblems().map((event) => event.eventType)).toEqual(['b']);
    expect(store.audit.acknowledgeProblems({ ids: [first.id] })).toBe(0);
    expect(store.audit.acknowledgeProblems({ ids: [] })).toBe(0);
  });

  it('leaves problems raised after the acknowledgement cutoff visible', () => {
    const store = memoryStore();
    store.audit.record({ eventType: 'old', entityType: 'app', severity: 'error' });
    const cutoff = new Date(Date.now() - 60_000).toISOString();

    expect(store.audit.acknowledgeProblems({ before: cutoff })).toBe(0);
    expect(store.audit.recentProblems().map((event) => event.eventType)).toEqual(['old']);
  });

  it('prunes to the most recent entries', () => {
    const store = memoryStore();
    for (let i = 0; i < 20; i += 1) store.audit.record({ eventType: `e${i}`, entityType: 'app' });
    store.audit.prune(5);
    expect(store.audit.recent(100)).toHaveLength(5);
  });
});

describe('app settings repository', () => {
  it('round-trips JSON values', () => {
    const store = memoryStore();
    store.appSettings.set('core.settings', { theme: 'midnight', jpegQuality: 88 });
    expect(store.appSettings.get<{ theme: string }>('core.settings')?.theme).toBe('midnight');
    expect(store.appSettings.get('missing')).toBeNull();
  });
});
