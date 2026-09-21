import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  logLevel: string;
  masterKeyFile: string | undefined;
  publicBaseUrl: string | undefined;
  trustProxy: boolean;
  /** True when the server listens beyond loopback, which forces authentication on. */
  isExposed: boolean;
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
    publicBaseUrl: env['GCA_PUBLIC_BASE_URL'],
    trustProxy: env['GCA_TRUST_PROXY'] === 'true',
    isExposed: !isLoopbackBind(host),
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
