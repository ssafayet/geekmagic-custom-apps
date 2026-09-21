import { describe, expect, it } from 'vitest';
import { loadConfig, normalizeBridgeToken, resolveAuthRequired } from '../src/config.js';

const LONG_ENOUGH = 'a'.repeat(32);

describe('normalizeBridgeToken', () => {
  it('is undefined when unset or blank, so the token file is used instead', () => {
    expect(normalizeBridgeToken(undefined)).toBeUndefined();
    expect(normalizeBridgeToken('   ')).toBeUndefined();
  });

  it('trims surrounding whitespace, which a shell export easily introduces', () => {
    expect(normalizeBridgeToken(` ${LONG_ENOUGH}\n`)).toBe(LONG_ENOUGH);
  });

  // Failing at boot beats accepting a weak secret: the endpoint it guards would
  // otherwise be reachable by anything that can post to loopback.
  it('refuses a token that is too short rather than accepting it', () => {
    expect(() => normalizeBridgeToken('short')).toThrow(/at least 16 characters/);
  });
});

describe('loadConfig', () => {
  it('carries the bridge token through', () => {
    expect(loadConfig({ GCA_BRIDGE_TOKEN: LONG_ENOUGH }).bridgeToken).toBe(LONG_ENOUGH);
  });

  it('leaves the bridge token unset by default', () => {
    expect(loadConfig({}).bridgeToken).toBeUndefined();
  });
});

describe('resolveAuthRequired', () => {
  it('follows the bind address when unset', () => {
    expect(resolveAuthRequired(undefined, '127.0.0.1')).toBe(false);
    expect(resolveAuthRequired(undefined, '0.0.0.0')).toBe(true);
  });

  // A container must bind 0.0.0.0 for a published port to reach it, so the bind
  // address alone cannot say whether anything outside the host can connect.
  it('can be forced off for a container whose port is published on loopback', () => {
    expect(resolveAuthRequired('false', '0.0.0.0')).toBe(false);
  });

  it('can be forced on for a loopback bind', () => {
    expect(resolveAuthRequired('true', '127.0.0.1')).toBe(true);
  });

  it('ignores casing and surrounding whitespace', () => {
    expect(resolveAuthRequired(' FALSE ', '0.0.0.0')).toBe(false);
  });

  it('falls back to the bind address for an unrecognised value', () => {
    expect(resolveAuthRequired('yes-please', '0.0.0.0')).toBe(true);
  });
});
