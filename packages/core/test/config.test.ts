import { describe, expect, it } from 'vitest';
import {
  loadConfig,
  normalizeBridgeToken,
  resolveAuthRequired,
  resolveTrustProxy,
} from '../src/config.js';

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

describe('login behind a reverse proxy', () => {
  // A proxy on the same machine connects over loopback, so a loopback bind no longer
  // means only this machine can reach the app.
  it('is required by default once a proxy is configured', () => {
    expect(loadConfig({ GCA_TRUST_PROXY: 'true' }).authRequired).toBe(true);
    expect(loadConfig({ GCA_PUBLIC_BASE_URL: 'https://panel.example.org' }).authRequired).toBe(
      true,
    );
  });

  // A tunnel needs no trusted hop, so naming its public host may be the only sign of it.
  it('is required by default once an extra host name is allowed', () => {
    expect(loadConfig({ GCA_ALLOWED_HOSTS: 'panel.example.org' }).authRequired).toBe(true);
  });

  it('can be switched off explicitly when an extra host name is allowed', () => {
    expect(
      loadConfig({ GCA_ALLOWED_HOSTS: 'panel.example.org', GCA_AUTH_REQUIRED: 'false' })
        .authRequired,
    ).toBe(false);
  });

  it('still needs nothing for a plain loopback install', () => {
    expect(loadConfig({}).authRequired).toBe(false);
  });

  it('can still be switched off explicitly', () => {
    expect(loadConfig({ GCA_TRUST_PROXY: 'true', GCA_AUTH_REQUIRED: 'false' }).authRequired).toBe(
      false,
    );
  });
});

describe('resolveTrustProxy', () => {
  it('is off when unset', () => {
    expect(resolveTrustProxy(undefined)).toBe(false);
    expect(resolveTrustProxy('false')).toBe(false);
  });

  // Trusting every hop would let any client pick its own address with a header.
  it('reads "true" as the same-machine proxy only', () => {
    expect(resolveTrustProxy('true')).toEqual(['loopback']);
  });

  it('accepts a list of proxy addresses', () => {
    expect(resolveTrustProxy('192.168.1.10, 10.0.0.0/8')).toEqual(['192.168.1.10', '10.0.0.0/8']);
  });
});

describe('allowed hosts', () => {
  it('parses a comma-separated list, lowercased', () => {
    expect(
      loadConfig({ GCA_ALLOWED_HOSTS: 'Displays.Example.com, other.example' }).allowedHosts,
    ).toEqual(['displays.example.com', 'other.example']);
  });
});

/**
 * A container always binds 0.0.0.0, so the compose file passes the address the port
 * is published on and the login follows that instead.
 */
describe('login in a container', () => {
  const container = { GCA_HOST: '0.0.0.0' };

  it('is off when the port is published on loopback', () => {
    expect(loadConfig({ ...container, GCA_PUBLISHED_HOST: '127.0.0.1' }).authRequired).toBe(false);
  });

  it('is on when the port is published on every interface', () => {
    expect(loadConfig({ ...container, GCA_PUBLISHED_HOST: '0.0.0.0' }).authRequired).toBe(true);
  });

  it('follows the bind address when no published address is given', () => {
    expect(loadConfig(container).authRequired).toBe(true);
    expect(loadConfig({ ...container, GCA_PUBLISHED_HOST: '' }).authRequired).toBe(true);
  });

  it('is still forced on by a proxy', () => {
    expect(
      loadConfig({ ...container, GCA_PUBLISHED_HOST: '127.0.0.1', GCA_TRUST_PROXY: 'true' })
        .authRequired,
    ).toBe(true);
  });
});
