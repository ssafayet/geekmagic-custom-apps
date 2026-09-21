import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { AppError } from '@gca/shared';

export const MASTER_KEY_BYTES = 32;
const KEY_FILENAME = 'master.key';

export interface MasterKeySource {
  key: Buffer;
  origin: 'generated' | 'file' | 'env-file';
  path: string | null;
}

/**
 * Loads the 256-bit master key, generating it on first native startup.
 *
 * The key never lives in SQLite: an attacker who copies the database file alone must
 * still obtain the key file, which is written owner-only.
 */
export function loadOrCreateMasterKey(options: {
  dataDir: string;
  keyFileOverride?: string | undefined;
  allowCreate?: boolean;
}): MasterKeySource {
  const { dataDir, keyFileOverride, allowCreate = true } = options;

  if (keyFileOverride) {
    if (!existsSync(keyFileOverride)) {
      throw new AppError(
        'SECRET_DECRYPTION_FAILED',
        `Master key file not found at ${keyFileOverride}. Mount the secret or unset GCA_MASTER_KEY_FILE.`,
      );
    }
    return { key: parseKeyFile(keyFileOverride), origin: 'env-file', path: keyFileOverride };
  }

  const keyPath = join(dataDir, KEY_FILENAME);
  if (existsSync(keyPath)) {
    assertOwnerOnly(keyPath);
    return { key: parseKeyFile(keyPath), origin: 'file', path: keyPath };
  }

  if (!allowCreate) {
    throw new AppError('SECRET_DECRYPTION_FAILED', `Master key missing at ${keyPath}.`);
  }

  mkdirSync(dirname(keyPath), { recursive: true });
  const key = randomBytes(MASTER_KEY_BYTES);
  writeFileSync(keyPath, key.toString('base64'), { mode: 0o600, flag: 'wx' });
  chmodSync(keyPath, 0o600);
  return { key, origin: 'generated', path: keyPath };
}

function parseKeyFile(path: string): Buffer {
  const raw = readFileSync(path, 'utf8').trim();
  const key = Buffer.from(raw, 'base64');
  if (key.length !== MASTER_KEY_BYTES) {
    throw new AppError(
      'SECRET_DECRYPTION_FAILED',
      `Master key at ${path} must be ${MASTER_KEY_BYTES} base64-encoded bytes.`,
    );
  }
  return key;
}

function assertOwnerOnly(path: string): void {
  if (process.platform === 'win32') return;
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    // Tightening is safe and better than refusing to start over a permissions drift.
    chmodSync(path, 0o600);
  }
}
