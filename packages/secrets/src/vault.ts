import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '@gca/shared';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

export interface SecretScope {
  /** Module instance id (or a core scope such as `core:auth`). */
  ownerId: string;
  /** Field key within that owner. */
  key: string;
}

/**
 * Per-secret AES-256-GCM.
 *
 * Each value gets a fresh random IV and binds `ownerId|key` as additional authenticated
 * data. That AAD is what stops a copied ciphertext from being replayed into a different
 * module instance or a different field.
 */
export class SecretVault {
  readonly #masterKey: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32) {
      throw new AppError('SECRET_DECRYPTION_FAILED', 'Master key must be 32 bytes.');
    }
    this.#masterKey = masterKey;
  }

  encrypt(scope: SecretScope, plaintext: string): EncryptedSecret {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.#masterKey, iv);
    cipher.setAAD(aad(scope));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { ciphertext, iv, authTag: cipher.getAuthTag() };
  }

  decrypt(scope: SecretScope, secret: EncryptedSecret): string {
    if (secret.iv.length !== IV_BYTES || secret.authTag.length !== AUTH_TAG_BYTES) {
      throw new AppError('SECRET_DECRYPTION_FAILED', 'Stored secret is malformed.', {
        details: { owner: scope.ownerId, key: scope.key },
      });
    }
    try {
      const decipher = createDecipheriv(ALGORITHM, this.#masterKey, secret.iv);
      decipher.setAAD(aad(scope));
      decipher.setAuthTag(secret.authTag);
      return Buffer.concat([decipher.update(secret.ciphertext), decipher.final()]).toString('utf8');
    } catch (cause) {
      // A GCM tag failure means the master key changed or the row was tampered with.
      // Either way the value is unrecoverable and the caller must not proceed.
      throw new AppError(
        'SECRET_DECRYPTION_FAILED',
        'Stored secret could not be decrypted. The master key may have changed.',
        { cause, details: { owner: scope.ownerId, key: scope.key } },
      );
    }
  }

  /** Verifies the vault can still read a known canary value written at first start. */
  canDecrypt(scope: SecretScope, secret: EncryptedSecret, expected: string): boolean {
    try {
      const actual = Buffer.from(this.decrypt(scope, secret), 'utf8');
      const expectedBuffer = Buffer.from(expected, 'utf8');
      return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
    } catch {
      return false;
    }
  }
}

function aad(scope: SecretScope): Buffer {
  return Buffer.from(`${scope.ownerId}\u0000${scope.key}`, 'utf8');
}
