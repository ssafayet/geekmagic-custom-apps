import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  logLevel: string;
  masterKeyFile: string | undefined;
  /**
   * Pre-shared bridge token, for deployments where the server and the bridge cannot
   * share a data directory — a container being the usual case.
   */
  bridgeToken: string | undefined;
  /**
   * Widens the bridge endpoint from loopback-only to any private address.
   *
   * Needed when the server is containerised and the port is published: Docker's NAT
   * rewrites the source, so a post from the host arrives from the bridge gateway
   * rather than 127.0.0.1. Off by default.
   */
  bridgeAllowPrivateSources: boolean;
  publicBaseUrl: string | undefined;
  /**
   * Which upstream hops may set `X-Forwarded-*`, in the form Fastify's `trustProxy`
   * takes. Never a blanket `true`: trusting every hop lets any client choose its own
   * `request.ip` by sending the header itself.
   */
  trustProxy: false | string[];
  /**
   * Extra Host names the server answers to, beyond loopback, IP literals and
   * private-network names. Needed only for a public DNS name in front of a proxy,
   * so listing one turns the login on by default, as configuring the proxy does.
   */
  allowedHosts: string[];
  /** True when the server listens beyond loopback. */
  isExposed: boolean;
  /**
   * The host address a container's port is published on, as the compose file
   * passes it in. Inside a container the bind address is always 0.0.0.0 and says
   * nothing about reach; this is what does.
   */
  publishedHost: string | undefined;
  /**
   * Set by the Docker image. Claude Code and its settings live on the host there, out
   * of this process's reach, so the server must not detect or edit its own copies.
   */
  inContainer: boolean;
  /**
   * Whether the browser API demands a signed-in session.
   *
   * Defaults to `isExposed`, but a container has to be able to say otherwise: it
   * must bind 0.0.0.0 for a published port to reach it, while `-p 127.0.0.1:3210`
   * means nothing outside the host can connect. The bind address cannot express
   * that difference, so `GCA_AUTH_REQUIRED` overrides it.
   */
  authRequired: boolean;
  version: string;
}

export const APP_VERSION = '1.0.0';

export function defaultDataDir(): string {
  const override = process.env['GCA_DATA_DIR'];
  if (override) return override;

  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'geekmagic-custom-apps');
  }
  const xdg = process.env['XDG_DATA_HOME'];
  if (xdg) return join(xdg, 'geekmagic-custom-apps');
  return join(homedir(), '.local', 'share', 'geekmagic-custom-apps');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const host = env['GCA_HOST'] ?? '127.0.0.1';
  const port = Number(env['GCA_PORT'] ?? 3210);
  const publicBaseUrl = env['GCA_PUBLIC_BASE_URL']?.trim() || undefined;
  const trustProxy = resolveTrustProxy(env['GCA_TRUST_PROXY']);
  const publishedHost = env['GCA_PUBLISHED_HOST']?.trim() || undefined;
  const allowedHosts = parseList(env['GCA_ALLOWED_HOSTS']).map((entry) => entry.toLowerCase());

  return {
    host,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 3210,
    dataDir: env['GCA_DATA_DIR'] ?? defaultDataDir(),
    logLevel: env['GCA_LOG_LEVEL'] ?? 'info',
    masterKeyFile: env['GCA_MASTER_KEY_FILE'],
    bridgeToken: normalizeBridgeToken(env['GCA_BRIDGE_TOKEN']),
    bridgeAllowPrivateSources: env['GCA_BRIDGE_ALLOW_PRIVATE_SOURCES'] === 'true',
    publicBaseUrl,
    trustProxy,
    allowedHosts,
    isExposed: !isLoopbackBind(host),
    publishedHost,
    inContainer: env['GCA_CONTAINER'] === 'true',
    authRequired: resolveAuthRequired(
      env['GCA_AUTH_REQUIRED'],
      publishedHost ?? host,
      // An extra host name is only ever needed for a public name in front of a proxy
      // or tunnel, so listing one is as sure a sign of a proxy as configuring it.
      trustProxy !== false || publicBaseUrl !== undefined || allowedHosts.length > 0,
    ),
    version: APP_VERSION,
  };
}

export function isLoopbackBind(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

export interface CoreSettings {
  displayTimezone: string;
  defaultDwellSeconds: number;
  minimumUploadIntervalSeconds: number;
  jpegQuality: number;
  theme: string;
  discoveryEnabled: boolean;
  logLevel: string;
}

export const DEFAULT_CORE_SETTINGS: CoreSettings = {
  displayTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  defaultDwellSeconds: 20,
  minimumUploadIntervalSeconds: 15,
  jpegQuality: 88,
  theme: 'midnight',
  discoveryEnabled: true,
  logLevel: 'info',
};

export const CORE_SETTINGS_KEY = 'core.settings';

/** Matches the length the generated token file is held to. */
export const MIN_BRIDGE_TOKEN_LENGTH = 16;

/**
 * Accepts a configured bridge token only when it is long enough to be worth having.
 *
 * A short token is rejected rather than padded: the endpoint it protects accepts
 * arbitrary local posts, so a weak secret there is worse than an obvious failure.
 */
export function normalizeBridgeToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length < MIN_BRIDGE_TOKEN_LENGTH) {
    throw new Error(
      `GCA_BRIDGE_TOKEN must be at least ${MIN_BRIDGE_TOKEN_LENGTH} characters; got ${trimmed.length}.`,
    );
  }
  return trimmed;
}

/**
 * Decides whether the browser API requires a login.
 *
 * Unset follows the address the app is reachable on: the bind address natively,
 * or the published address a container is told about. Either way a configured
 * reverse proxy forces it on, since a proxy on the same machine connects over
 * loopback and a loopback bind then says nothing about who reaches the app.
 */
export function resolveAuthRequired(
  value: string | undefined,
  host: string,
  behindProxy = false,
): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return behindProxy || !isLoopbackBind(host);
}

/**
 * Parses `GCA_TRUST_PROXY` into the hops Fastify may believe.
 *
 * `true` keeps working for the documented same-machine proxy, but means loopback
 * only rather than every hop. Anything else is a list of addresses or CIDRs.
 */
export function resolveTrustProxy(value: string | undefined): false | string[] {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'false') return false;
  if (normalized === 'true') return ['loopback'];
  return parseList(value);
}

function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
