import type { Database } from 'better-sqlite3';
import { nowIso } from '@gca/shared';

export class AppSettingsRepository {
  constructor(private readonly db: Database) {}

  get<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(key) as
      { value_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return null;
    }
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value ?? null), nowIso());
  }

  all(): Record<string, unknown> {
    const rows = this.db.prepare('SELECT key, value_json FROM app_settings').all() as Array<{
      key: string;
      value_json: string;
    }>;
    const out: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        out[row.key] = JSON.parse(row.value_json);
      } catch {
        out[row.key] = null;
      }
    }
    return out;
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
  }
}
