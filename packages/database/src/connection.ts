import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import BetterSqlite3, { type Database } from 'better-sqlite3';
import {
  currentSchemaVersion,
  LATEST_SCHEMA_VERSION,
  runMigrations,
  type MigrationOutcome,
} from './migrations.js';

export interface OpenDatabaseOptions {
  /** Absolute file path, or `:memory:` for tests. */
  file: string;
  readonly?: boolean;
  /** Take a copy of the file before applying migrations. */
  backupBeforeMigrate?: boolean;
}

export interface OpenDatabaseResult {
  db: Database;
  migration: MigrationOutcome | null;
  backupPath: string | null;
}

export function openDatabase(options: OpenDatabaseOptions): OpenDatabaseResult {
  const { file, readonly = false, backupBeforeMigrate = true } = options;
  const inMemory = file === ':memory:';

  if (!inMemory) mkdirSync(dirname(file), { recursive: true });

  let backupPath: string | null = null;
  const needsMigration = inMemory || !existsSync(file) || pendingMigration(file);
  if (!inMemory && backupBeforeMigrate && needsMigration && existsSync(file)) {
    backupPath = join(dirname(file), `${basename(file)}.pre-v${LATEST_SCHEMA_VERSION}.bak`);
    copyFileSync(file, backupPath);
  }

  const db = new BetterSqlite3(file, { readonly });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  const migration = readonly ? null : runMigrations(db);
  return { db, migration, backupPath };
}

function basename(file: string): string {
  const parts = file.split(/[\\/]/);
  return parts[parts.length - 1] ?? 'app.db';
}

function pendingMigration(file: string): boolean {
  try {
    const probe = new BetterSqlite3(file, { readonly: true });
    try {
      return currentSchemaVersion(probe) < LATEST_SCHEMA_VERSION;
    } finally {
      probe.close();
    }
  } catch {
    return true;
  }
}
