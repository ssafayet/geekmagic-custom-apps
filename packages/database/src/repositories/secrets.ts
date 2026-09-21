import type { Database } from 'better-sqlite3';
import { lastFour as computeLastFour, nowIso } from '@gca/shared';
import type { SecretVault } from '@gca/secrets';
import type { SecretRecord } from '../types.js';

interface SecretRow {
  module_instance_id: string;
  key: string;
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  last_four: string;
  created_at: string;
  updated_at: string;
}

export interface SecretState {
  configured: boolean;
  lastFour: string | null;
  updatedAt: string | null;
}

/**
 * Owns the only path between plaintext secrets and storage.
 *
 * Callers can write a secret and read its metadata freely; reading the plaintext is a
 * separate, deliberate call so it is easy to audit where decryption actually happens.
 */
export class SecretRepository {
  constructor(
    private readonly db: Database,
    private readonly vault: SecretVault,
  ) {}

  set(moduleInstanceId: string, key: string, plaintext: string): SecretState {
    const encrypted = this.vault.encrypt({ ownerId: moduleInstanceId, key }, plaintext);
    const timestamp = nowIso();
    const tail = computeLastFour(plaintext);
    this.db
      .prepare(
        `INSERT INTO module_secrets (
           module_instance_id, key, ciphertext, iv, auth_tag, last_four, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (module_instance_id, key) DO UPDATE SET
           ciphertext = excluded.ciphertext,
           iv = excluded.iv,
           auth_tag = excluded.auth_tag,
           last_four = excluded.last_four,
           updated_at = excluded.updated_at`,
      )
      .run(
        moduleInstanceId,
        key,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.authTag,
        tail,
        timestamp,
        timestamp,
      );
    return { configured: true, lastFour: tail, updatedAt: timestamp };
  }

  /** Decrypts on demand. Throws `SECRET_DECRYPTION_FAILED` if the master key changed. */
  reveal(moduleInstanceId: string, key: string): string | null {
    const row = this.row(moduleInstanceId, key);
    if (!row) return null;
    return this.vault.decrypt(
      { ownerId: moduleInstanceId, key },
      { ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag },
    );
  }

  state(moduleInstanceId: string, key: string): SecretState {
    const row = this.row(moduleInstanceId, key);
    if (!row) return { configured: false, lastFour: null, updatedAt: null };
    return { configured: true, lastFour: row.last_four, updatedAt: row.updated_at };
  }

  states(moduleInstanceId: string, keys: string[]): Record<string, SecretState> {
    const out: Record<string, SecretState> = {};
    for (const key of keys) out[key] = this.state(moduleInstanceId, key);
    return out;
  }

  remove(moduleInstanceId: string, key: string): void {
    this.db
      .prepare('DELETE FROM module_secrets WHERE module_instance_id = ? AND key = ?')
      .run(moduleInstanceId, key);
  }

  listRaw(moduleInstanceId: string): SecretRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM module_secrets WHERE module_instance_id = ?')
      .all(moduleInstanceId) as SecretRow[];
    return rows.map((row) => ({
      moduleInstanceId: row.module_instance_id,
      key: row.key,
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.auth_tag,
      lastFour: row.last_four,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  private row(moduleInstanceId: string, key: string): SecretRow | undefined {
    return this.db
      .prepare('SELECT * FROM module_secrets WHERE module_instance_id = ? AND key = ?')
      .get(moduleInstanceId, key) as SecretRow | undefined;
  }
}
