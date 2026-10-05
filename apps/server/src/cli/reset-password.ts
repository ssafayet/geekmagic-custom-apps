/**
 * Clears the administrator password so a new one can be chosen.
 *
 * The way back from a forgotten password. Whoever can run this already controls
 * the data directory, so it asks for nothing; it never touches settings, devices or
 * secrets. The next password is chosen in the web UI with the setup code printed
 * here, exactly as on a fresh install.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createStore } from '@gca/database';
import { loadOrCreateMasterKey, SecretVault } from '@gca/secrets';
import { loadConfig } from '@gca/core';
import { PASSWORD_HASH_KEY, readOrCreateSetupToken, setupTokenPath } from '../auth.js';

const config = loadConfig();
const databaseFile = join(config.dataDir, 'app.db');

if (!existsSync(databaseFile)) {
  process.stderr.write(
    `No database at ${databaseFile}. Set GCA_DATA_DIR if the server uses a different data directory.\n`,
  );
  process.exit(1);
}

const masterKey = loadOrCreateMasterKey({
  dataDir: config.dataDir,
  keyFileOverride: config.masterKeyFile,
  allowCreate: false,
});
const store = createStore({ file: databaseFile }, new SecretVault(masterKey.key));

const hadPassword = store.appSettings.get<string>(PASSWORD_HASH_KEY) !== null;
store.appSettings.delete(PASSWORD_HASH_KEY);
store.audit.record({
  eventType: 'auth.password-reset',
  actor: 'operator',
  entityType: 'app',
  severity: 'warn',
});
store.close();

const code = readOrCreateSetupToken(setupTokenPath(config.dataDir));

process.stdout.write(
  [
    hadPassword
      ? 'The administrator password has been cleared.'
      : 'No administrator password was set.',
    '',
    `Setup code: ${code}`,
    '',
    'Restart the server to sign out every existing session, then open the web UI and',
    'enter this code to choose a new password.',
    '',
  ].join('\n'),
);
