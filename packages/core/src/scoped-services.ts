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
 */
const PERMISSION_HOSTS: Partial<Record<ModulePermission, string[]>> = {
  'network:anthropic': ['api.anthropic.com'],
  'network:adsb-fi': ['opendata.adsb.fi'],
  // The token endpoint lives on a separate host from the data API.
  'network:opensky': ['opensky-network.org', 'auth.opensky-network.org'],
  // Callsign -> airline and route. A schedule database, not a position source.
  'network:adsbdb': ['api.adsbdb.com'],
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
    if (!this.allowedHosts.includes(parsed.hostname)) {
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
