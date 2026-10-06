import { request } from 'undici';
import { AppError } from '@gca/shared';
import type {
  ModulePermission,
  ScopedFetchOptions,
  ScopedHttpClient,
  ScopedResponse,
  ScopedSecrets,
  ScopedStateStore,
} from '@gca/module-sdk';
import type { Store } from '@gca/database';

/**
 * The hosts each network permission unlocks.
 *
 * A module cannot reach anything not listed here for a permission it holds, which is
 * what turns `network:anthropic` from documentation into an actual constraint.
 *
 * An entry starting `*.` matches any subdomain of what follows, and never the domain
 * itself. Use it only where one operator serves from numbered hosts it alone controls.
 */
const PERMISSION_HOSTS: Partial<Record<ModulePermission, string[]>> = {
  'network:anthropic': ['api.anthropic.com'],
  'network:adsb-fi': ['opendata.adsb.fi'],
  // The token endpoint lives on a separate host from the data API.
  'network:opensky': ['opensky-network.org', 'auth.opensky-network.org'],
  // Callsign -> airline and route. A schedule database, not a position source.
  'network:adsbdb': ['api.adsbdb.com'],
  // Forecast and air quality are separate hosts of the same keyless service.
  'network:open-meteo': ['api.open-meteo.com', 'air-quality-api.open-meteo.com'],
  // The cloud API for a user's own AirGradient monitors; needs their token.
  'network:airgradient': ['api.airgradient.com'],
  // The hosts that serve secret iCal links for the major calendar providers. A link
  // anywhere else is refused: an arbitrary URL would turn this into a fetch-anything
  // permission, which is a separate decision. iCloud serves from p01..pNN-caldav.
  'network:calendar-feeds': [
    'calendar.google.com',
    'outlook.office365.com',
    'outlook.office.com',
    'outlook.live.com',
    '*.icloud.com',
    'user.fm',
    'calendar.proton.me',
  ],
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

export function allowedHostsFor(permissions: readonly ModulePermission[]): string[] {
  const hosts = new Set<string>();
  for (const permission of permissions) {
    for (const host of PERMISSION_HOSTS[permission] ?? []) hosts.add(host);
  }
  return [...hosts];
}

/**
 * HTTPS client restricted to a module's declared hosts.
 *
 * Scheme, host and redirect behaviour are all fixed here rather than trusted to the
 * module, so a bug in module code cannot turn into an outbound request somewhere else.
 */
export class PermissionScopedHttpClient implements ScopedHttpClient {
  constructor(
    private readonly allowedHosts: readonly string[],
    private readonly moduleId: string,
  ) {}

  async request(url: string, options: ScopedFetchOptions = {}): Promise<ScopedResponse> {
    const parsed = parseUrl(url, this.moduleId);

    if (parsed.protocol !== 'https:') {
      throw new AppError(
        'VALIDATION_FAILED',
        `Module "${this.moduleId}" attempted a non-HTTPS request to ${parsed.hostname}.`,
      );
    }
    if (!isHostAllowed(this.allowedHosts, parsed.hostname)) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Module "${this.moduleId}" is not permitted to contact ${parsed.hostname}.`,
        { details: { allowed: this.allowedHosts } },
      );
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);

    try {
      const response = await request(parsed.toString(), {
        method: options.method ?? 'GET',
        headers: {
          'user-agent': 'geekmagic-custom-apps/1.0',
          ...options.headers,
        },
        ...(options.body === undefined ? {} : { body: options.body }),
        signal: controller.signal,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });

      const text = await readCapped(response.body, maxBytes);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(response.headers)) {
        if (value === undefined || value === null) continue;
        headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
      }

      return {
        status: response.statusCode,
        ok: response.statusCode >= 200 && response.statusCode < 300,
        headers,
        text,
        json<T = unknown>(): T {
          return JSON.parse(text) as T;
        },
      };
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new AppError('INTERNAL_ERROR', `Request to ${parsed.hostname} failed: ${message}`, {
        cause,
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
}

export function isHostAllowed(allowedHosts: readonly string[], hostname: string): boolean {
  const host = hostname.toLowerCase();
  return allowedHosts.some((entry) => {
    if (!entry.startsWith('*.')) return entry === host;
    // `*.icloud.com` matches `p52-caldav.icloud.com`, not `icloud.com` and not
    // `evil-icloud.com`: the leading dot is part of the required suffix.
    const suffix = entry.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  });
}

function parseUrl(url: string, moduleId: string): URL {
  try {
    return new URL(url);
  } catch (cause) {
    throw new AppError('VALIDATION_FAILED', `Module "${moduleId}" supplied an invalid URL.`, {
      cause,
    });
  }
}

async function readCapped(
  body: AsyncIterable<Buffer | Uint8Array> & { destroy?: (err?: Error) => void },
  maxBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      body.destroy?.();
      throw new AppError('VALIDATION_FAILED', `Response exceeded the ${maxBytes} byte limit.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Instance-scoped secret reader.
 *
 * A module can only name keys it declared, and only within its own instance. The
 * plaintext is produced per call and never handed out as a cached object.
 */
export class InstanceScopedSecrets implements ScopedSecrets {
  constructor(
    private readonly store: Store,
    private readonly instanceId: string,
    private readonly allowedKeys: readonly string[],
    private readonly hasPermission: boolean,
  ) {}

  async get(key: string): Promise<string | null> {
    this.assertAllowed(key);
    return this.store.secrets.reveal(this.instanceId, key);
  }

  async has(key: string): Promise<boolean> {
    this.assertAllowed(key);
    return this.store.secrets.state(this.instanceId, key).configured;
  }

  private assertAllowed(key: string): void {
    if (!this.hasPermission) {
      throw new AppError(
        'UNAUTHORIZED',
        'This module did not declare the secrets:read-own permission.',
      );
    }
    if (!this.allowedKeys.includes(key)) {
      throw new AppError('UNAUTHORIZED', `Secret "${key}" is not declared by this module.`);
    }
  }
}

/** Small durable KV area, namespaced to one module instance. */
export class InstanceScopedState implements ScopedStateStore {
  constructor(
    private readonly store: Store,
    private readonly instanceId: string,
  ) {}

  async get<T = unknown>(key: string): Promise<T | null> {
    return this.store.moduleState.get<T>(this.instanceId, key);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.store.moduleState.set(this.instanceId, key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.moduleState.delete(this.instanceId, key);
  }
}
