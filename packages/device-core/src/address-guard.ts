import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { AppError } from '@gca/shared';

export interface AddressPolicy {
  /** Extra hosts or CIDRs the operator has explicitly allowed beyond private ranges. */
  allowlist: string[];
  /** Permit loopback targets. Off by default: a display is never on 127.0.0.1. */
  allowLoopback: boolean;
  /** Escape hatch for unusual deployments; logged loudly and never the default. */
  allowPublic: boolean;
}

export const DEFAULT_ADDRESS_POLICY: AddressPolicy = {
  allowlist: [],
  allowLoopback: false,
  allowPublic: false,
};

export interface ResolvedTarget {
  hostname: string;
  port: number;
  /** The literal IP the socket must connect to, pinned after validation. */
  address: string;
  family: 4 | 6;
}

/**
 * Device probe and upload URLs are server-side requests, which makes this module the
 * SSRF boundary for the whole application.
 *
 * DNS is resolved here and the resulting literal address is what the transport
 * connects to, so a name that re-resolves to a public address between the check and
 * the connection (DNS rebinding) cannot slip through.
 */
export async function resolveAndValidate(
  hostname: string,
  port: number,
  policy: AddressPolicy = DEFAULT_ADDRESS_POLICY,
): Promise<ResolvedTarget> {
  const normalized = normalizeHostname(hostname);

  if (policy.allowlist.includes(normalized)) {
    const literal = isIP(normalized);
    if (literal) {
      return { hostname: normalized, port, address: normalized, family: literal === 6 ? 6 : 4 };
    }
  }

  const literalFamily = isIP(normalized);
  const candidates: Array<{ address: string; family: number }> = literalFamily
    ? [{ address: normalized, family: literalFamily }]
    : await resolveHost(normalized);

  if (candidates.length === 0) {
    throw new AppError('DEVICE_UNREACHABLE', `Could not resolve "${hostname}".`, {
      details: { host: hostname },
    });
  }

  // Prefer the first address that satisfies policy rather than failing on a
  // dual-stack host whose IPv6 record happens to be disallowed.
  for (const candidate of candidates) {
    if (isAllowed(candidate.address, policy)) {
      return {
        hostname: normalized,
        port,
        address: candidate.address,
        family: candidate.family === 6 ? 6 : 4,
      };
    }
  }

  const first = candidates[0];
  throw new AppError(
    'DEVICE_ADDRESS_BLOCKED',
    `"${hostname}" resolves to ${first?.address ?? 'an address'}, which is outside the allowed private network ranges.`,
    { details: { host: hostname, resolved: candidates.map((c) => c.address) } },
  );
}

async function resolveHost(hostname: string): Promise<Array<{ address: string; family: number }>> {
  try {
    const results = await lookup(hostname, { all: true, verbatim: true });
    return results.map((entry) => ({ address: entry.address, family: entry.family }));
  } catch (cause) {
    throw new AppError('DEVICE_UNREACHABLE', `Could not resolve "${hostname}".`, {
      cause,
      details: { host: hostname },
    });
  }
}

export function normalizeHostname(hostname: string): string {
  let value = hostname.trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  // A trailing dot is a valid FQDN form but breaks naive string comparison.
  if (value.endsWith('.') && isIP(value) === 0) value = value.slice(0, -1);
  return value;
}

export function isAllowed(address: string, policy: AddressPolicy): boolean {
  if (policy.allowlist.includes(address)) return true;
  if (policy.allowPublic) return !isUnspecified(address) && !isMulticast(address);

  if (isLoopback(address)) return policy.allowLoopback;
  if (isUnspecified(address) || isMulticast(address)) return false;
  return isPrivate(address);
}

export function isPrivate(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    const [a, b] = octets as [number, number, number, number];
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    // Link-local (169.254/16) covers mDNS-discovered devices without DHCP.
    if (a === 169 && b === 254) return true;
    // Carrier-grade NAT space is used by some mesh/VPN setups on a LAN.
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (family === 6) {
    const value = expandIpv6(address);
    // Unique local fc00::/7 and link-local fe80::/10.
    if (/^f[cd]/.test(value)) return true;
    if (/^fe[89ab]/.test(value)) return true;
    // IPv4-mapped addresses are judged on the embedded IPv4 address.
    const mapped = value.match(/^0{4}(:0{4}){4}:ffff:([0-9a-f]{4}):([0-9a-f]{4})$/);
    if (mapped?.[2] && mapped[3]) {
      return isPrivate(ipv4FromHextets(mapped[2], mapped[3]));
    }
    return false;
  }
  return false;
}

export function isLoopback(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return address.startsWith('127.');
  if (family === 6) {
    const value = expandIpv6(address);
    if (value === '0000:0000:0000:0000:0000:0000:0000:0001') return true;
    const mapped = value.match(/^0{4}(:0{4}){4}:ffff:([0-9a-f]{4}):([0-9a-f]{4})$/);
    if (mapped?.[2] && mapped[3]) return isLoopback(ipv4FromHextets(mapped[2], mapped[3]));
  }
  return false;
}

export function isUnspecified(address: string): boolean {
  if (address === '0.0.0.0') return true;
  return isIP(address) === 6 && expandIpv6(address) === '0000:0000:0000:0000:0000:0000:0000:0000';
}

export function isMulticast(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const first = Number(address.split('.')[0]);
    return first >= 224 && first <= 239;
  }
  if (family === 6) return expandIpv6(address).startsWith('ff');
  return false;
}

function ipv4FromHextets(high: string, low: string): string {
  const h = Number.parseInt(high, 16);
  const l = Number.parseInt(low, 16);
  return `${h >> 8}.${h & 0xff}.${l >> 8}.${l & 0xff}`;
}

/** Expands an IPv6 literal to eight zero-padded hextets for prefix comparison. */
export function expandIpv6(address: string): string {
  let value = address.toLowerCase().split('%')[0] ?? '';

  // Convert a trailing dotted-quad (::ffff:192.168.1.5) into hextets.
  const dotted = value.match(/^(.*:)((\d{1,3}\.){3}\d{1,3})$/);
  if (dotted?.[1] && dotted[2]) {
    const octets = dotted[2].split('.').map(Number);
    const [a, b, c, d] = octets as [number, number, number, number];
    const high = ((a << 8) | b).toString(16).padStart(4, '0');
    const low = ((c << 8) | d).toString(16).padStart(4, '0');
    value = `${dotted[1]}${high}:${low}`;
  }

  const [head = '', tail = ''] = value.includes('::') ? value.split('::') : [value, ''];
  const headParts = head ? head.split(':').filter(Boolean) : [];
  const tailParts = value.includes('::') ? (tail ? tail.split(':').filter(Boolean) : []) : [];
  const missing = 8 - headParts.length - tailParts.length;
  const middle = value.includes('::') ? Array<string>(Math.max(0, missing)).fill('0') : [];

  return [...headParts, ...middle, ...tailParts].map((part) => part.padStart(4, '0')).join(':');
}
