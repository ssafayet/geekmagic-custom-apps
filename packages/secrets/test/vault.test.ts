import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadOrCreateMasterKey, MASTER_KEY_BYTES, SecretVault } from '../src/index.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'gca-secrets-'));
}

describe('SecretVault', () => {
  const key = randomBytes(32);
  const vault = new SecretVault(key);
  const scope = { ownerId: 'mod_1', key: 'adminApiKey' };

  it('round-trips a secret', () => {
    const encrypted = vault.encrypt(scope, 'sk-ant-admin-value');
    expect(vault.decrypt(scope, encrypted)).toBe('sk-ant-admin-value');
  });

  it('produces a distinct IV and ciphertext for identical plaintext', () => {
    const a = vault.encrypt(scope, 'same');
    const b = vault.encrypt(scope, 'same');
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('never stores the plaintext in the ciphertext buffer', () => {
    const encrypted = vault.encrypt(scope, 'sk-ant-admin-value');
    expect(encrypted.ciphertext.toString('utf8')).not.toContain('sk-ant');
  });

  it('refuses a ciphertext replayed into a different module instance', () => {
    const encrypted = vault.encrypt(scope, 'secret');
    // The authenticated context binds owner and field, so this must fail.
    expect(() => vault.decrypt({ ownerId: 'mod_2', key: 'adminApiKey' }, encrypted)).toThrow(
      /could not be decrypted/i,
    );
  });

  it('refuses a ciphertext replayed into a different field', () => {
    const encrypted = vault.encrypt(scope, 'secret');
    expect(() => vault.decrypt({ ownerId: 'mod_1', key: 'otherKey' }, encrypted)).toThrow();
  });

  it('detects tampering with the ciphertext', () => {
    const encrypted = vault.encrypt(scope, 'secret');
    encrypted.ciphertext[0] ^= 0xff;
    expect(() => vault.decrypt(scope, encrypted)).toThrowError(
      expect.objectContaining({ code: 'SECRET_DECRYPTION_FAILED' }),
    );
  });

  it('detects tampering with the auth tag', () => {
    const encrypted = vault.encrypt(scope, 'secret');
    encrypted.authTag[0] ^= 0xff;
    expect(() => vault.decrypt(scope, encrypted)).toThrow();
  });

  it('fails when the master key changes', () => {
    const encrypted = vault.encrypt(scope, 'secret');
    const otherVault = new SecretVault(randomBytes(32));
    expect(() => otherVault.decrypt(scope, encrypted)).toThrowError(
      expect.objectContaining({ code: 'SECRET_DECRYPTION_FAILED' }),
    );
  });

  it('rejects a malformed stored secret', () => {
    expect(() =>
      vault.decrypt(scope, {
        ciphertext: Buffer.alloc(4),
        iv: Buffer.alloc(3),
        authTag: Buffer.alloc(16),
      }),
    ).toThrow(/malformed/i);
  });

  it('rejects a master key of the wrong length', () => {
    expect(() => new SecretVault(randomBytes(16))).toThrow(/32 bytes/);
  });

  it('verifies a canary value', () => {
    const encrypted = vault.encrypt(scope, 'canary');
    expect(vault.canDecrypt(scope, encrypted, 'canary')).toBe(true);
    expect(vault.canDecrypt(scope, encrypted, 'different')).toBe(false);
  });
});

describe('master key file', () => {
  it('generates an owner-only key on first start', () => {
    const dir = tempDir();
    const result = loadOrCreateMasterKey({ dataDir: dir });

    expect(result.origin).toBe('generated');
    expect(result.key.length).toBe(MASTER_KEY_BYTES);
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, 'master.key')).mode & 0o777).toBe(0o600);
    }
  });

  it('reuses the existing key on later starts', () => {
    const dir = tempDir();
    const first = loadOrCreateMasterKey({ dataDir: dir });
    const second = loadOrCreateMasterKey({ dataDir: dir });

    expect(second.origin).toBe('file');
    expect(second.key.equals(first.key)).toBe(true);
  });

  it('tightens permissions that drifted open', () => {
    if (process.platform === 'win32') return;
    const dir = tempDir();
    loadOrCreateMasterKey({ dataDir: dir });
    chmodSync(join(dir, 'master.key'), 0o644);

    loadOrCreateMasterKey({ dataDir: dir });

    expect(statSync(join(dir, 'master.key')).mode & 0o777).toBe(0o600);
  });

  it('honours an explicit key file override', () => {
    const dir = tempDir();
    const keyPath = join(dir, 'mounted.key');
    const key = randomBytes(32);
    writeFileSync(keyPath, key.toString('base64'));

    const result = loadOrCreateMasterKey({ dataDir: dir, keyFileOverride: keyPath });

    expect(result.origin).toBe('env-file');
    expect(result.key.equals(key)).toBe(true);
  });

  it('fails loudly when the override file is missing', () => {
    const dir = tempDir();
    expect(() =>
      loadOrCreateMasterKey({ dataDir: dir, keyFileOverride: join(dir, 'absent.key') }),
    ).toThrow(/not found/i);
  });

  it('rejects a key file of the wrong length', () => {
    const dir = tempDir();
    const keyPath = join(dir, 'short.key');
    writeFileSync(keyPath, randomBytes(8).toString('base64'));
    expect(() => loadOrCreateMasterKey({ dataDir: dir, keyFileOverride: keyPath })).toThrow(
      /base64-encoded bytes/i,
    );
  });

  it('writes the key as base64 rather than raw bytes', () => {
    const dir = tempDir();
    loadOrCreateMasterKey({ dataDir: dir });
    const contents = readFileSync(join(dir, 'master.key'), 'utf8');
    expect(contents).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});
