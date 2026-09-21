import type { Database } from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  up: string;
  /** Present when the change can be reversed without losing user data. */
  down?: string;
}

/**
 * Forward-only numbered migrations applied inside a transaction.
 *
 * Each migration is additive where possible so a downgrade keeps user data; anything
 * destructive must take a database backup first (see `runMigrations`).
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up: /* sql */ `
      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        host TEXT NOT NULL UNIQUE,
        profile_id TEXT NOT NULL,
        model_name TEXT,
        firmware_version TEXT,
        capabilities_json TEXT NOT NULL DEFAULT '{}',
        album_management_consent INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        minimum_upload_interval_seconds INTEGER NOT NULL DEFAULT 15,
        last_seen_at TEXT,
        last_upload_hash TEXT,
        last_upload_at TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE module_instances (
        id TEXT PRIMARY KEY,
        module_id TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        settings_version INTEGER NOT NULL,
        settings_json TEXT NOT NULL DEFAULT '{}',
        health_status TEXT NOT NULL DEFAULT 'unknown',
        health_message TEXT,
        last_success_at TEXT,
        last_error_code TEXT,
        last_refresh_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_module_instances_module_id ON module_instances (module_id);

      CREATE TABLE module_secrets (
        module_instance_id TEXT NOT NULL,
        key TEXT NOT NULL,
        ciphertext BLOB NOT NULL,
        iv BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        last_four TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (module_instance_id, key)
      );

      CREATE TABLE module_snapshots (
        module_instance_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE module_state (
        module_instance_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (module_instance_id, key)
      );

      CREATE TABLE device_playlist_items (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
        module_instance_id TEXT NOT NULL REFERENCES module_instances (id) ON DELETE CASCADE,
        view_id TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        dwell_seconds INTEGER NOT NULL DEFAULT 20,
        enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX idx_playlist_device_order
        ON device_playlist_items (device_id, sort_order);

      CREATE TABLE device_backups (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
        profile_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        directory TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE INDEX idx_device_backups_device ON device_backups (device_id);

      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        severity TEXT NOT NULL DEFAULT 'info',
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_audit_created_at ON audit_events (created_at DESC);
      CREATE INDEX idx_audit_severity ON audit_events (severity, created_at DESC);

      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
    down: /* sql */ `
      DROP TABLE IF EXISTS app_settings;
      DROP TABLE IF EXISTS audit_events;
      DROP TABLE IF EXISTS device_backups;
      DROP TABLE IF EXISTS device_playlist_items;
      DROP TABLE IF EXISTS module_state;
      DROP TABLE IF EXISTS module_snapshots;
      DROP TABLE IF EXISTS module_secrets;
      DROP TABLE IF EXISTS module_instances;
      DROP TABLE IF EXISTS devices;
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);

export function currentSchemaVersion(db: Database): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

export interface MigrationOutcome {
  from: number;
  to: number;
  applied: Array<{ version: number; name: string }>;
}

export function runMigrations(db: Database): MigrationOutcome {
  const from = currentSchemaVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > from).sort((a, b) => a.version - b.version);
  const applied: Array<{ version: number; name: string }> = [];

  for (const migration of pending) {
    // Each migration is its own transaction so a failure leaves the previous
    // version fully intact rather than a half-migrated schema.
    const apply = db.transaction(() => {
      db.exec(migration.up);
      db.pragma(`user_version = ${migration.version}`);
    });
    apply();
    applied.push({ version: migration.version, name: migration.name });
  }

  return { from, to: currentSchemaVersion(db), applied };
}
