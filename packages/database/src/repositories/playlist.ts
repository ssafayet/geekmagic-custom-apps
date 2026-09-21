import type { Database } from 'better-sqlite3';
import type { PlaylistItemRecord } from '../types.js';

interface PlaylistRow {
  id: string;
  device_id: string;
  module_instance_id: string;
  view_id: string;
  sort_order: number;
  dwell_seconds: number;
  enabled: number;
}

function toRecord(row: PlaylistRow): PlaylistItemRecord {
  return {
    id: row.id,
    deviceId: row.device_id,
    moduleInstanceId: row.module_instance_id,
    viewId: row.view_id,
    order: row.sort_order,
    dwellSeconds: row.dwell_seconds,
    enabled: row.enabled === 1,
  };
}

export class PlaylistRepository {
  constructor(private readonly db: Database) {}

  listForDevice(deviceId: string): PlaylistItemRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM device_playlist_items WHERE device_id = ? ORDER BY sort_order ASC')
      .all(deviceId) as PlaylistRow[];
    return rows.map(toRecord);
  }

  listAll(): PlaylistItemRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM device_playlist_items ORDER BY device_id, sort_order ASC')
      .all() as PlaylistRow[];
    return rows.map(toRecord);
  }

  /**
   * Replaces a device's playlist atomically. Rows are deleted first because
   * `(device_id, sort_order)` is unique and a partial reorder would collide.
   */
  replaceForDevice(deviceId: string, items: PlaylistItemRecord[]): PlaylistItemRecord[] {
    const replace = this.db.transaction((list: PlaylistItemRecord[]) => {
      this.db.prepare('DELETE FROM device_playlist_items WHERE device_id = ?').run(deviceId);
      const insert = this.db.prepare(
        `INSERT INTO device_playlist_items
           (id, device_id, module_instance_id, view_id, sort_order, dwell_seconds, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      list.forEach((item, index) => {
        insert.run(
          item.id,
          deviceId,
          item.moduleInstanceId,
          item.viewId,
          index,
          item.dwellSeconds,
          item.enabled ? 1 : 0,
        );
      });
    });
    replace(items);
    return this.listForDevice(deviceId);
  }

  deleteForModuleInstance(moduleInstanceId: string): void {
    this.db
      .prepare('DELETE FROM device_playlist_items WHERE module_instance_id = ?')
      .run(moduleInstanceId);
  }
}
