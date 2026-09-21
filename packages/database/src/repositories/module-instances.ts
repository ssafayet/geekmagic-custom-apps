import type { Database } from 'better-sqlite3';
import { nowIso, type HealthStatus } from '@gca/shared';
import type { ModuleInstanceRecord } from '../types.js';

interface InstanceRow {
  id: string;
  module_id: string;
  name: string;
  enabled: number;
  settings_version: number;
  settings_json: string;
  health_status: string;
  health_message: string | null;
  last_success_at: string | null;
  last_error_code: string | null;
  last_refresh_at: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(row: InstanceRow): ModuleInstanceRecord {
  return {
    id: row.id,
    moduleId: row.module_id,
    name: row.name,
    enabled: row.enabled === 1,
    settingsVersion: row.settings_version,
    settings: JSON.parse(row.settings_json) as Record<string, unknown>,
    healthStatus: row.health_status as HealthStatus,
    healthMessage: row.health_message,
    lastSuccessAt: row.last_success_at,
    lastErrorCode: row.last_error_code,
    lastRefreshAt: row.last_refresh_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ModuleInstanceRepository {
  constructor(private readonly db: Database) {}

  list(): ModuleInstanceRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM module_instances ORDER BY created_at ASC')
      .all() as InstanceRow[];
    return rows.map(toRecord);
  }

  listByModule(moduleId: string): ModuleInstanceRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM module_instances WHERE module_id = ? ORDER BY created_at ASC')
      .all(moduleId) as InstanceRow[];
    return rows.map(toRecord);
  }

  get(id: string): ModuleInstanceRecord | null {
    const row = this.db.prepare('SELECT * FROM module_instances WHERE id = ?').get(id) as
      InstanceRow | undefined;
    return row ? toRecord(row) : null;
  }

  insert(record: Omit<ModuleInstanceRecord, 'createdAt' | 'updatedAt'>): ModuleInstanceRecord {
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO module_instances (
          id, module_id, name, enabled, settings_version, settings_json,
          health_status, health_message, last_success_at, last_error_code, last_refresh_at,
          created_at, updated_at
        ) VALUES (
          @id, @module_id, @name, @enabled, @settings_version, @settings_json,
          @health_status, @health_message, @last_success_at, @last_error_code, @last_refresh_at,
          @created_at, @updated_at
        )`,
      )
      .run({
        id: record.id,
        module_id: record.moduleId,
        name: record.name,
        enabled: record.enabled ? 1 : 0,
        settings_version: record.settingsVersion,
        settings_json: JSON.stringify(record.settings),
        health_status: record.healthStatus,
        health_message: record.healthMessage,
        last_success_at: record.lastSuccessAt,
        last_error_code: record.lastErrorCode,
        last_refresh_at: record.lastRefreshAt,
        created_at: timestamp,
        updated_at: timestamp,
      });
    return { ...record, createdAt: timestamp, updatedAt: timestamp };
  }

  update(
    id: string,
    patch: Partial<Omit<ModuleInstanceRecord, 'id' | 'moduleId' | 'createdAt'>>,
  ): ModuleInstanceRecord | null {
    const assignments: string[] = [];
    const params: Record<string, unknown> = { id };
    const map: Record<string, string> = {
      name: 'name',
      enabled: 'enabled',
      settingsVersion: 'settings_version',
      settings: 'settings_json',
      healthStatus: 'health_status',
      healthMessage: 'health_message',
      lastSuccessAt: 'last_success_at',
      lastErrorCode: 'last_error_code',
      lastRefreshAt: 'last_refresh_at',
    };

    for (const [key, value] of Object.entries(patch)) {
      const column = map[key];
      if (!column) continue;
      assignments.push(`${column} = @${column}`);
      params[column] =
        key === 'settings'
          ? JSON.stringify(value)
          : typeof value === 'boolean'
            ? value
              ? 1
              : 0
            : (value ?? null);
    }
    if (assignments.length === 0) return this.get(id);

    assignments.push('updated_at = @updated_at');
    params['updated_at'] = nowIso();
    this.db
      .prepare(`UPDATE module_instances SET ${assignments.join(', ')} WHERE id = @id`)
      .run(params);
    return this.get(id);
  }

  delete(id: string): void {
    const remove = this.db.transaction((instanceId: string) => {
      this.db.prepare('DELETE FROM module_secrets WHERE module_instance_id = ?').run(instanceId);
      this.db.prepare('DELETE FROM module_snapshots WHERE module_instance_id = ?').run(instanceId);
      this.db.prepare('DELETE FROM module_state WHERE module_instance_id = ?').run(instanceId);
      this.db
        .prepare('DELETE FROM device_playlist_items WHERE module_instance_id = ?')
        .run(instanceId);
      this.db.prepare('DELETE FROM module_instances WHERE id = ?').run(instanceId);
    });
    remove(id);
  }
}
