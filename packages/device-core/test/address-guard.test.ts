import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ADDRESS_POLICY,
  expandIpv6,
  isAllowed,
  isLoopback,
  isMulticast,
  isPrivate,
  isUnspecified,
  normalizeHostname,
  resolveAndValidate,
} from '../src/address-guard.js';

describe('private range classification', () => {
  it.each([
    ['10.0.0.1', true],
    ['10.255.255.254', true],
    ['172.16.0.1', true],
    ['172.31.255.254', true],
    ['172.15.0.1', false],
    ['172.32.0.1', false],
    ['192.168.1.50', true],
    ['192.169.1.50', false],
    ['169.254.10.5', true],
    ['100.64.0.1', true],
    ['100.128.0.1', false],
    ['8.8.8.8', false],
    ['1.1.1.1', false],
  ])('classifies %s as private=%s', (address, expected) => {
    expect(isPrivate(address)).toBe(expected);
  });

  it('classifies IPv6 unique-local and link-local as private', () => {
    expect(isPrivate('fd00::1')).toBe(true);
    expect(isPrivate('fc00::1')).toBe(true);
    expect(isPrivate('fe80::1')).toBe(true);
    expect(isPrivate('2001:4860:4860::8888')).toBe(false);
  });

  it('judges IPv4-mapped IPv6 on the embedded address', () => {
    expect(isPrivate('::ffff:192.168.1.5')).toBe(true);
    expect(isPrivate('::ffff:8.8.8.8')).toBe(false);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
  });

  it('identifies loopback, unspecified and multicast', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('127.99.1.2')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isUnspecified('0.0.0.0')).toBe(true);
    expect(isUnspecified('::')).toBe(true);
    expect(isMulticast('224.0.0.1')).toBe(true);
    expect(isMulticast('239.255.255.250')).toBe(true);
    expect(isMulticast('ff02::1')).toBe(true);
    expect(isMulticast('192.168.1.1')).toBe(false);
  });

  it('expands IPv6 shorthand consistently', () => {
    expect(expandIpv6('::1')).toBe('0000:0000:0000:0000:0000:0000:0000:0001');
    expect(expandIpv6('fe80::1%en0')).toBe('fe80:0000:0000:0000:0000:0000:0000:0001');
    expect(expandIpv6('::ffff:192.168.1.5')).toBe('0000:0000:0000:0000:0000:ffff:c0a8:0105');
  });
});

describe('policy enforcement', () => {
  it('blocks loopback and public addresses by default', () => {
    expect(isAllowed('192.168.1.10', DEFAULT_ADDRESS_POLICY)).toBe(true);
    expect(isAllowed('127.0.0.1', DEFAULT_ADDRESS_POLICY)).toBe(false);
    expect(isAllowed('8.8.8.8', DEFAULT_ADDRESS_POLICY)).toBe(false);
    expect(isAllowed('0.0.0.0', DEFAULT_ADDRESS_POLICY)).toBe(false);
    expect(isAllowed('224.0.0.1', DEFAULT_ADDRESS_POLICY)).toBe(false);
  });

  it('permits loopback only when explicitly enabled', () => {
    const policy = { ...DEFAULT_ADDRESS_POLICY, allowLoopback: true };
    expect(isAllowed('127.0.0.1', policy)).toBe(true);
  });

  it('never permits unspecified or multicast even with allowPublic', () => {
    const policy = { ...DEFAULT_ADDRESS_POLICY, allowPublic: true };
    expect(isAllowed('8.8.8.8', policy)).toBe(true);
    expect(isAllowed('0.0.0.0', policy)).toBe(false);
    expect(isAllowed('239.1.1.1', policy)).toBe(false);
  });

  it('honours an explicit allowlist entry', () => {
    const policy = { ...DEFAULT_ADDRESS_POLICY, allowlist: ['203.0.113.7'] };
    expect(isAllowed('203.0.113.7', policy)).toBe(true);
    expect(isAllowed('203.0.113.8', policy)).toBe(false);
  });
});

describe('hostname normalization', () => {
  it('lowercases, strips brackets and trailing dots', () => {
    expect(normalizeHostname('  Display.Local.  ')).toBe('display.local');
    expect(normalizeHostname('[fe80::1]')).toBe('fe80::1');
  });
});

describe('resolveAndValidate', () => {
  it('rejects a public literal with DEVICE_ADDRESS_BLOCKED', async () => {
    await expect(resolveAndValidate('8.8.8.8', 80)).rejects.toMatchObject({
      code: 'DEVICE_ADDRESS_BLOCKED',
    });
  });

  it('rejects loopback under the default policy', async () => {
    await expect(resolveAndValidate('127.0.0.1', 80)).rejects.toMatchObject({
      code: 'DEVICE_ADDRESS_BLOCKED',
    });
  });

  it('accepts a private literal and pins the resolved address', async () => {
    const target = await resolveAndValidate('192.168.1.21', 80);
    expect(target).toMatchObject({ address: '192.168.1.21', port: 80, family: 4 });
  });

  it('reports an unresolvable name as unreachable rather than blocked', async () => {
    await expect(resolveAndValidate('this-host-does-not-exist.invalid', 80)).rejects.toMatchObject({
      code: 'DEVICE_UNREACHABLE',
    });
  });
});
