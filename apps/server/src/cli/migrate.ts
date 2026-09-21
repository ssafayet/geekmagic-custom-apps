/** Applies pending database migrations without starting the server. */
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createStore } from '@gca/database';
import { loadOrCreateMasterKey, SecretVault } from '@gca/secrets';
import { loadConfig } from '@gca/core';

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });

const masterKey = loadOrCreateMasterKey({
  dataDir: config.dataDir,
  keyFileOverride: config.masterKeyFile,
});
const store = createStore({ file: join(config.dataDir, 'app.db') }, new SecretVault(masterKey.key));

if (store.migration && store.migration.applied.length > 0) {
  process.stdout.write(
    `Applied ${store.migration.applied.length} migration(s): ${store.migration.from} -> ${store.migration.to}\n`,
  );
  if (store.migrationBackupPath) {
    process.stdout.write(`Pre-migration backup: ${store.migrationBackupPath}\n`);
  }
} else {
  process.stdout.write(
    `Database is already at schema version ${store.migration?.to ?? 'unknown'}.\n`,
  );
}

store.close();
