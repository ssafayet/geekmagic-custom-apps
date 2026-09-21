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
  trustProxy: boolean;
  /** True when the server listens beyond loopback. Also decides cookie hardening. */
  isExposed: boolean;
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

  return {
    host,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 3210,
    dataDir: env['GCA_DATA_DIR'] ?? defaultDataDir(),
    logLevel: env['GCA_LOG_LEVEL'] ?? 'info',
    masterKeyFile: env['GCA_MASTER_KEY_FILE'],
    bridgeToken: normalizeBridgeToken(env['GCA_BRIDGE_TOKEN']),
    bridgeAllowPrivateSources: env['GCA_BRIDGE_ALLOW_PRIVATE_SOURCES'] === 'true',
    publicBaseUrl: env['GCA_PUBLIC_BASE_URL'],
    trustProxy: env['GCA_TRUST_PROXY'] === 'true',
    isExposed: !isLoopbackBind(host),
    authRequired: resolveAuthRequired(env['GCA_AUTH_REQUIRED'], host),
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
 * Unset follows the bind address, which is right for a native install. `false` is
 * for a container whose port is published on the host's loopback: the app sees
 * 0.0.0.0 and would otherwise lock itself behind a password nobody can set.
 */
export function resolveAuthRequired(value: string | undefined, host: string): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return !isLoopbackBind(host);
}
