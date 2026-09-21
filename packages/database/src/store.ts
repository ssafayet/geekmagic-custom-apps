import type { Database } from 'better-sqlite3';
import type { SecretVault } from '@gca/secrets';
import { openDatabase, type OpenDatabaseOptions } from './connection.js';
import { AppSettingsRepository } from './repositories/app-settings.js';
import { AuditRepository } from './repositories/audit.js';
import { BackupRepository } from './repositories/backups.js';
import { DeviceRepository } from './repositories/devices.js';
import { ModuleInstanceRepository } from './repositories/module-instances.js';
import { PlaylistRepository } from './repositories/playlist.js';
import { SecretRepository } from './repositories/secrets.js';
import { ModuleStateRepository, SnapshotRepository } from './repositories/snapshots.js';
import type { MigrationOutcome } from './migrations.js';

/**
 * Single entry point to persistence.
 *
 * Modules never see this object: the runtime hands them narrow, instance-scoped views
 * of the secret, snapshot and state repositories instead.
 */
export class Store {
  readonly devices: DeviceRepository;
  readonly moduleInstances: ModuleInstanceRepository;
  readonly secrets: SecretRepository;
  readonly snapshots: SnapshotRepository;
  readonly moduleState: ModuleStateRepository;
  readonly playlist: PlaylistRepository;
  readonly backups: BackupRepository;
  readonly audit: AuditRepository;
  readonly appSettings: AppSettingsRepository;

  constructor(
    readonly db: Database,
    vault: SecretVault,
    readonly migration: MigrationOutcome | null = null,
    readonly migrationBackupPath: string | null = null,
  ) {
    this.devices = new DeviceRepository(db);
    this.moduleInstances = new ModuleInstanceRepository(db);
    this.secrets = new SecretRepository(db, vault);
    this.snapshots = new SnapshotRepository(db);
    this.moduleState = new ModuleStateRepository(db);
    this.playlist = new PlaylistRepository(db);
    this.backups = new BackupRepository(db);
    this.audit = new AuditRepository(db);
    this.appSettings = new AppSettingsRepository(db);
  }

  /** Runs `fn` inside a SQLite transaction. Nested calls reuse the outer transaction. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}

export function createStore(options: OpenDatabaseOptions, vault: SecretVault): Store {
  const { db, migration, backupPath } = openDatabase(options);
  return new Store(db, vault, migration, backupPath);
}
