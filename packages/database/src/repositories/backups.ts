import type { Database } from 'better-sqlite3';
import { nowIso, type DeviceProfileId } from '@gca/shared';
import type { BackupRecord } from '../types.js';

interface BackupRow {
  id: string;
  device_id: string;
  profile_id: string;
  created_at: string;
  manifest_json: string;
  directory: string;
  status: string;
}

function toRecord(row: BackupRow): BackupRecord {
  return {
    id: row.id,
    deviceId: row.device_id,
    profileId: row.profile_id as DeviceProfileId,
    createdAt: row.created_at,
    manifest: JSON.parse(row.manifest_json) as BackupRecord['manifest'],
    directory: row.directory,
    status: row.status as BackupRecord['status'],
  };
}

export class BackupRepository {
  constructor(private readonly db: Database) {}

  listForDevice(deviceId: string): BackupRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM device_backups WHERE device_id = ? ORDER BY created_at DESC')
      .all(deviceId) as BackupRow[];
    return rows.map(toRecord);
  }

  get(id: string): BackupRecord | null {
    const row = this.db.prepare('SELECT * FROM device_backups WHERE id = ?').get(id) as
      BackupRow | undefined;
    return row ? toRecord(row) : null;
  }

  insert(record: Omit<BackupRecord, 'createdAt'> & { createdAt?: string }): BackupRecord {
    const createdAt = record.createdAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO device_backups (id, device_id, profile_id, created_at, manifest_json, directory, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.deviceId,
        record.profileId,
        createdAt,
        JSON.stringify(record.manifest),
        record.directory,
        record.status,
      );
    return { ...record, createdAt };
  }

  countForDevice(deviceId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM device_backups WHERE device_id = ?')
      .get(deviceId) as { n: number };
    return row.n;
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM device_backups WHERE id = ?').run(id);
  }
}
