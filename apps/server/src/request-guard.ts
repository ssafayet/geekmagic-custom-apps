import { isIP } from 'node:net';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AppConfig } from '@gca/core';
import type { AppServer } from './fastify-types.js';

/**
 * Suffixes that never resolve through public DNS, so no outside party can point one
 * at this machine. `localhost` subdomains are pinned to loopback by browsers.
 */
const PRIVATE_SUFFIXES = [
  'localhost',
  'local',
  'lan',
  'home',
  'home.arpa',
  'internal',
  'localdomain',
];

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Refuses requests addressed to a name this server does not answer to, and writes
 * sent from a page on another origin.
 *
 * Both checks exist for DNS rebinding. A web page can point its own domain at
 * 127.0.0.1 and then talk to this server as if it were same-origin, which on an
 * unauthenticated loopback deployment would mean full control. The page cannot
 * change the Host header its browser sends, though, and that header still names the
 * attacker's domain. Anything that is not loopback, an IP literal, a name that only
 * private DNS can resolve, or a host the operator listed is therefore refused.
 *
 * None of this needs configuring for a local or LAN install: `localhost`, a LAN IP
 * and `nas.local` all pass. Only a public DNS name in front of a reverse proxy has
 * to be declared, via `GCA_PUBLIC_BASE_URL` or `GCA_ALLOWED_HOSTS`.
 */
export function registerRequestGuard(app: AppServer, config: AppConfig): void {
  const allowed = new Set(config.allowedHosts);
  const publicHost = parsePublicHost(config.publicBaseUrl);
  if (publicHost) allowed.add(publicHost);

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const host = hostnameOf(request.headers.host);
    if (!host || !isAcceptableHost(host, allowed)) {
      await reply.status(421).send({
        error: {
          code: 'UNAUTHORIZED',
          message:
            'This server does not answer to that hostname. Add it to GCA_ALLOWED_HOSTS if it is yours.',
        },
      });
      return;
    }

    if (SAFE_METHODS.has(request.method)) return;

    // Browsers attach Origin to every cross-origin write and to same-origin fetches
    // that are not GET. A client that sends none (curl, the bridge) is not a browser
    // being steered by some other page, so it is left to the other controls.
    const origin = request.headers.origin;
    if (origin === undefined) return;
    if (!isSameOrigin(origin, request.headers.host ?? '', publicHost)) {
      await reply.status(403).send({
        error: { code: 'UNAUTHORIZED', message: 'Cross-origin requests are not accepted.' },
      });
    }
  });
}

export function isAcceptableHost(hostname: string, allowed: ReadonlySet<string>): boolean {
  if (allowed.has(hostname)) return true;
  if (isIP(hostname)) return true;
  // A single-label name ("raspberrypi") comes from the local resolver's search list.
  if (!hostname.includes('.')) return true;
  return PRIVATE_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

/**
 * Same-origin means the page's origin names the host this request was sent to.
 *
 * Loopback is treated as one origin across ports so the Vite development server,
 * which proxies to this process from another port, keeps working.
 */
export function isSameOrigin(
  origin: string,
  hostHeader: string,
  publicHost: string | null,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    // Includes the literal "null" a sandboxed frame or opaque redirect sends.
    return false;
  }
  if (parsed.host === hostHeader.toLowerCase()) return true;
  if (publicHost && parsed.hostname === publicHost) return true;
  const requestHost = hostnameOf(hostHeader);
  return requestHost !== null && isLoopbackName(parsed.hostname) && isLoopbackName(requestHost);
}

/** Lowercased hostname from a Host header, without port or IPv6 brackets. */
export function hostnameOf(header: string | undefined): string | null {
  if (!header) return null;
  try {
    const hostname = new URL(`http://${header}`).hostname.toLowerCase();
    const bare = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
    return bare.endsWith('.') ? bare.slice(0, -1) : bare;
  } catch {
    return null;
  }
}

function isLoopbackName(hostname: string): boolean {
  const bare = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  return (
    bare === 'localhost' ||
    bare.endsWith('.localhost') ||
    bare === '::1' ||
    (isIP(bare) === 4 && bare.startsWith('127.'))
  );
}

function parsePublicHost(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}
