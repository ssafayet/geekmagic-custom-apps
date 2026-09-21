import { networkInterfaces } from 'node:os';
import { AppError } from '@gca/shared';
import { isPrivate } from './address-guard.js';
import { detectProfile } from './detection.js';
import { DeviceTransport } from './http.js';

export interface SubnetCandidate {
  interfaceName: string;
  address: string;
  cidr: string;
  /** Number of scannable hosts, excluding network and broadcast addresses. */
  hostCount: number;
}

export interface DiscoveredDevice {
  host: string;
  profileId: string;
  modelName: string | null;
  firmwareVersion: string | null;
  supported: boolean;
}

export interface DiscoveryOptions {
  cidr: string;
  signal?: AbortSignal;
  concurrency?: number;
  perHostTimeoutMs?: number;
  onProgress?: (progress: { scanned: number; total: number; found: number }) => void;
}

const MAX_CONCURRENCY = 16;
const PER_HOST_TIMEOUT_MS = 1_000;
/** A /24 is 254 hosts; anything broader is rejected in version 1. */
const MIN_PREFIX = 24;

/**
 * Lists private IPv4 subnets the host is actually attached to.
 *
 * Discovery is always user-confirmed against one of these; the application never
 * decides on its own which network to sweep.
 */
export function listPrivateSubnets(): SubnetCandidate[] {
  const out: SubnetCandidate[] = [];
  for (const [interfaceName, addresses] of Object.entries(networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (!isPrivate(entry.address)) continue;
      const prefix = netmaskToPrefix(entry.netmask);
      if (prefix === null) continue;
      const cidr = `${networkAddress(entry.address, prefix)}/${prefix}`;
      out.push({
        interfaceName,
        address: entry.address,
        cidr,
        hostCount: Math.max(0, 2 ** (32 - prefix) - 2),
      });
    }
  }
  return out;
}

/**
 * Sweeps one user-selected /24 for GeekMagic firmware.
 *
 * Read-only, bounded concurrency, short per-host timeout, and cancellable. This never
 * runs on a timer — a background network scan is not something a display app should do.
 */
export async function discoverDevices(options: DiscoveryOptions): Promise<DiscoveredDevice[]> {
  const hosts = expandCidr(options.cidr);
  const concurrency = Math.min(options.concurrency ?? MAX_CONCURRENCY, MAX_CONCURRENCY);
  const timeoutMs = options.perHostTimeoutMs ?? PER_HOST_TIMEOUT_MS;
  const found: DiscoveredDevice[] = [];
  let scanned = 0;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < hosts.length) {
      if (options.signal?.aborted) return;
      const host = hosts[cursor++];
      if (!host) return;

      try {
        const transport = new DeviceTransport({ host, defaultTimeoutMs: timeoutMs });
        const result = await detectProfile(
          transport,
          options.signal ? { signal: options.signal } : {},
        );
        if (result.profileId !== 'unknown' && result.reachable) {
          found.push({
            host,
            profileId: result.profileId,
            modelName: result.modelName,
            firmwareVersion: result.firmwareVersion,
            supported: result.supported,
          });
        }
      } catch {
        // An unreachable address during a sweep is the expected case, not an error.
      } finally {
        scanned += 1;
        options.onProgress?.({ scanned, total: hosts.length, found: found.length });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  return found.sort((a, b) => compareIpv4(a.host, b.host));
}

export function expandCidr(cidr: string): string[] {
  const [base, prefixText] = cidr.split('/');
  const prefix = Number(prefixText);
  if (!base || !Number.isInteger(prefix)) {
    throw new AppError('VALIDATION_FAILED', `"${cidr}" is not a valid CIDR range.`);
  }
  if (prefix < MIN_PREFIX) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Scans wider than /${MIN_PREFIX} are not permitted. Choose a smaller range than ${cidr}.`,
    );
  }
  if (prefix > 32) {
    throw new AppError('VALIDATION_FAILED', `"${cidr}" is not a valid CIDR range.`);
  }
  const baseInt = ipv4ToInt(base);
  if (baseInt === null)
    throw new AppError('VALIDATION_FAILED', `"${base}" is not a valid IPv4 address.`);
  if (!isPrivate(base)) {
    throw new AppError('DEVICE_ADDRESS_BLOCKED', `${cidr} is not a private network range.`);
  }

  const size = 2 ** (32 - prefix);
  const network = baseInt & (size === 2 ** 32 ? 0 : ~(size - 1) >>> 0);
  const hosts: string[] = [];
  // Skip the network and broadcast addresses for prefixes that have them.
  const start = size > 2 ? network + 1 : network;
  const end = size > 2 ? network + size - 2 : network + size - 1;
  for (let value = start; value <= end; value += 1) hosts.push(intToIpv4(value));
  return hosts;
}

function netmaskToPrefix(netmask: string): number | null {
  const value = ipv4ToInt(netmask);
  if (value === null) return null;
  const binary = value.toString(2).padStart(32, '0');
  if (!/^1*0*$/.test(binary)) return null;
  return binary.indexOf('0') === -1 ? 32 : binary.indexOf('0');
}

function networkAddress(address: string, prefix: number): string {
  const value = ipv4ToInt(address);
  if (value === null) return address;
  const mask = prefix === 0 ? 0 : ~(2 ** (32 - prefix) - 1) >>> 0;
  return intToIpv4((value & mask) >>> 0);
}

export function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

export function intToIpv4(value: number): string {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

function compareIpv4(a: string, b: string): number {
  return (ipv4ToInt(a) ?? 0) - (ipv4ToInt(b) ?? 0);
}
