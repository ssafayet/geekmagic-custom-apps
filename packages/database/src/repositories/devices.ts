import type { Database } from 'better-sqlite3';
import { nowIso, type DeviceCapabilities, type DeviceProfileId } from '@gca/shared';
import type { DeviceRecord } from '../types.js';

interface DeviceRow {
  id: string;
  name: string;
  host: string;
  profile_id: string;
  model_name: string | null;
  firmware_version: string | null;
  capabilities_json: string;
  album_management_consent: number;
  active: number;
  minimum_upload_interval_seconds: number;
  last_seen_at: string | null;
  last_upload_hash: string | null;
  last_upload_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(row: DeviceRow): DeviceRecord {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    profileId: row.profile_id as DeviceProfileId,
    modelName: row.model_name,
    firmwareVersion: row.firmware_version,
    capabilities: JSON.parse(row.capabilities_json) as DeviceCapabilities,
    albumManagementConsent: row.album_management_consent === 1,
    active: row.active === 1,
    minimumUploadIntervalSeconds: row.minimum_upload_interval_seconds,
    lastSeenAt: row.last_seen_at,
    lastUploadHash: row.last_upload_hash,
    lastUploadAt: row.last_upload_at,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class DeviceRepository {
  constructor(private readonly db: Database) {}

  list(): DeviceRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM devices ORDER BY created_at ASC')
      .all() as DeviceRow[];
    return rows.map(toRecord);
  }

  listActive(): DeviceRecord[] {
    return this.list().filter((device) => device.active);
  }

  get(id: string): DeviceRecord | null {
    const row = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as
      DeviceRow | undefined;
    return row ? toRecord(row) : null;
  }

  findByHost(host: string): DeviceRecord | null {
    const row = this.db.prepare('SELECT * FROM devices WHERE host = ?').get(host) as
      DeviceRow | undefined;
    return row ? toRecord(row) : null;
  }

  insert(record: Omit<DeviceRecord, 'createdAt' | 'updatedAt'>): DeviceRecord {
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO devices (
          id, name, host, profile_id, model_name, firmware_version, capabilities_json,
          album_management_consent, active, minimum_upload_interval_seconds,
          last_seen_at, last_upload_hash, last_upload_at, last_error_code, last_error_message,
          created_at, updated_at
        ) VALUES (
          @id, @name, @host, @profile_id, @model_name, @firmware_version, @capabilities_json,
          @album_management_consent, @active, @minimum_upload_interval_seconds,
          @last_seen_at, @last_upload_hash, @last_upload_at, @last_error_code, @last_error_message,
          @created_at, @updated_at
        )`,
      )
      .run({
        id: record.id,
        name: record.name,
        host: record.host,
        profile_id: record.profileId,
        model_name: record.modelName,
        firmware_version: record.firmwareVersion,
        capabilities_json: JSON.stringify(record.capabilities),
        album_management_consent: record.albumManagementConsent ? 1 : 0,
        active: record.active ? 1 : 0,
        minimum_upload_interval_seconds: record.minimumUploadIntervalSeconds,
        last_seen_at: record.lastSeenAt,
        last_upload_hash: record.lastUploadHash,
        last_upload_at: record.lastUploadAt,
        last_error_code: record.lastErrorCode,
        last_error_message: record.lastErrorMessage,
        created_at: timestamp,
        updated_at: timestamp,
      });
    return { ...record, createdAt: timestamp, updatedAt: timestamp };
  }

  update(id: string, patch: Partial<Omit<DeviceRecord, 'id' | 'createdAt'>>): DeviceRecord | null {
    const columns: Record<keyof typeof patch, string> = {
      name: 'name',
      host: 'host',
      profileId: 'profile_id',
      modelName: 'model_name',
      firmwareVersion: 'firmware_version',
      capabilities: 'capabilities_json',
      albumManagementConsent: 'album_management_consent',
      active: 'active',
      minimumUploadIntervalSeconds: 'minimum_upload_interval_seconds',
      lastSeenAt: 'last_seen_at',
      lastUploadHash: 'last_upload_hash',
      lastUploadAt: 'last_upload_at',
      lastErrorCode: 'last_error_code',
      lastErrorMessage: 'last_error_message',
      updatedAt: 'updated_at',
    };

    const assignments: string[] = [];
    const params: Record<string, unknown> = { id };

    for (const [key, value] of Object.entries(patch)) {
      const column = columns[key as keyof typeof columns];
      if (!column || key === 'updatedAt') continue;
      assignments.push(`${column} = @${column}`);
      params[column] =
        key === 'capabilities'
          ? JSON.stringify(value)
          : typeof value === 'boolean'
            ? value
              ? 1
              : 0
            : (value ?? null);
    }

    assignments.push('updated_at = @updated_at');
    params['updated_at'] = nowIso();

    this.db.prepare(`UPDATE devices SET ${assignments.join(', ')} WHERE id = @id`).run(params);
    return this.get(id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM devices WHERE id = ?').run(id);
  }
}
