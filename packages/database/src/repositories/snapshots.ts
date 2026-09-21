import type { Database } from 'better-sqlite3';
import { nowIso } from '@gca/shared';
import type { SnapshotRecord } from '../types.js';

interface SnapshotRow {
  module_instance_id: string;
  schema_version: number;
  snapshot_json: string;
  captured_at: string;
  expires_at: string;
}

/** Hard ceiling on a persisted snapshot; oversized payloads are dropped, not truncated. */
export const MAX_SNAPSHOT_BYTES = 128 * 1024;

export class SnapshotRepository {
  constructor(private readonly db: Database) {}

  get(moduleInstanceId: string): SnapshotRecord | null {
    const row = this.db
      .prepare('SELECT * FROM module_snapshots WHERE module_instance_id = ?')
      .get(moduleInstanceId) as SnapshotRow | undefined;
    if (!row) return null;
    return {
      moduleInstanceId: row.module_instance_id,
      schemaVersion: row.schema_version,
      snapshot: JSON.parse(row.snapshot_json) as unknown,
      capturedAt: row.captured_at,
      expiresAt: row.expires_at,
    };
  }

  /** Returns false when the snapshot exceeded the size cap and was not written. */
  put(record: Omit<SnapshotRecord, 'capturedAt'> & { capturedAt?: string }): boolean {
    const json = JSON.stringify(record.snapshot);
    if (Buffer.byteLength(json, 'utf8') > MAX_SNAPSHOT_BYTES) return false;
    this.db
      .prepare(
        `INSERT INTO module_snapshots (
           module_instance_id, schema_version, snapshot_json, captured_at, expires_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (module_instance_id) DO UPDATE SET
           schema_version = excluded.schema_version,
           snapshot_json = excluded.snapshot_json,
           captured_at = excluded.captured_at,
           expires_at = excluded.expires_at`,
      )
      .run(
        record.moduleInstanceId,
        record.schemaVersion,
        json,
        record.capturedAt ?? nowIso(),
        record.expiresAt,
      );
    return true;
  }

  delete(moduleInstanceId: string): void {
    this.db
      .prepare('DELETE FROM module_snapshots WHERE module_instance_id = ?')
      .run(moduleInstanceId);
  }

  purgeExpired(reference = nowIso()): number {
    const result = this.db
      .prepare('DELETE FROM module_snapshots WHERE expires_at < ?')
      .run(reference);
    return result.changes;
  }
}

export class ModuleStateRepository {
  constructor(private readonly db: Database) {}

  get<T>(moduleInstanceId: string, key: string): T | null {
    const row = this.db
      .prepare('SELECT value_json FROM module_state WHERE module_instance_id = ? AND key = ?')
      .get(moduleInstanceId, key) as { value_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return null;
    }
  }

  set(moduleInstanceId: string, key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO module_state (module_instance_id, key, value_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (module_instance_id, key) DO UPDATE SET
           value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(moduleInstanceId, key, JSON.stringify(value ?? null), nowIso());
  }

  delete(moduleInstanceId: string, key: string): void {
    this.db
      .prepare('DELETE FROM module_state WHERE module_instance_id = ? AND key = ?')
      .run(moduleInstanceId, key);
  }
}
