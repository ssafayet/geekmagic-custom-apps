import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import { Agent, request } from 'undici';
import { AppError } from '@gca/shared';
import { DEFAULT_ADDRESS_POLICY, resolveAndValidate, type AddressPolicy } from './address-guard.js';
import { isContentLengthQuirk, lenientRequest } from './lenient-http.js';

/** Device firmware returns small JSON or short HTML; anything larger is a red flag. */
export const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
export const DEFAULT_TIMEOUT_MS = 5_000;

export interface DeviceRequestOptions {
  method?: 'GET' | 'POST';
  /** Path plus query. Callers must encode components themselves. */
  path: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface DeviceResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: Buffer;
  text: string;
  /** True when the connection dropped after headers; PRO firmware does this on upload. */
  truncated: boolean;
  durationMs: number;
}

export interface DeviceTransportOptions {
  host: string;
  port?: number;
  policy?: AddressPolicy;
  defaultTimeoutMs?: number;
  maxResponseBytes?: number;
}

/**
 * HTTP client for GeekMagic firmware.
 *
 * Deliberately narrow: no redirect following (a device must not be able to bounce us
 * anywhere), a hard body cap, a per-request timeout, and connections pinned to an
 * address that passed the private-range policy.
 */
export class DeviceTransport {
  readonly host: string;
  readonly port: number;
  readonly #policy: AddressPolicy;
  readonly #defaultTimeoutMs: number;
  readonly #maxResponseBytes: number;

  constructor(options: DeviceTransportOptions) {
    const { hostname, port } = splitHostPort(options.host, options.port ?? 80);
    this.host = hostname;
    this.port = port;
    this.#policy = options.policy ?? DEFAULT_ADDRESS_POLICY;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  async request(options: DeviceRequestOptions): Promise<DeviceResponse> {
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
    const maxBytes = options.maxBytes ?? this.#maxResponseBytes;
    const target = await resolveAndValidate(this.host, this.port, this.#policy);
    const startedAt = Date.now();

    const authority = isIP(target.address) === 6 ? `[${target.address}]` : target.address;
    const url = `http://${authority}:${target.port}${options.path}`;

    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);

    // One dispatcher per request keeps a wedged device from poisoning a shared pool;
    // these are low-frequency calls so the connection reuse is not worth the risk.
    const dispatcher = new Agent({
      connectTimeout: Math.min(timeoutMs, 4_000),
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      pipelining: 0,
    });

    try {
      const response = await request(url, {
        method: options.method ?? 'GET',
        dispatcher,
        // The device is addressed by IP; Host carries the name the user configured.
        headers: {
          host: this.port === 80 ? this.host : `${this.host}:${this.port}`,
          'user-agent': 'geekmagic-custom-apps/1.0',
          accept: '*/*',
          connection: 'close',
          ...options.headers,
        },
        ...(options.body === undefined ? {} : { body: options.body }),
        // undici does not follow redirects unless the redirect interceptor is added,
        // and it deliberately is not: a redirect from a device is an SSRF pivot. A 3xx
        // therefore arrives here as a plain non-OK response.
        signal: controller.signal,
      });

      const { body, truncated } = await readCapped(response.body, maxBytes);
      return {
        status: response.statusCode,
        ok: response.statusCode >= 200 && response.statusCode < 300,
        headers: normalizeHeaders(response.headers),
        body,
        text: body.toString('utf8'),
        truncated,
        durationMs: Date.now() - startedAt,
      };
    } catch (cause) {
      // Some firmware emits a duplicated Content-Length, which undici refuses. Retry
      // once with a reader that tolerates identical duplicates but still rejects
      // conflicting ones; see lenient-http.ts for why that distinction is the safe one.
      if (isContentLengthQuirk(cause) && !controller.signal.aborted) {
        return await this.lenientFallback(options, target, timeoutMs, maxBytes, startedAt);
      }
      throw toTransportError(cause, this.host, options.path, Date.now() - startedAt);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      void dispatcher.close().catch(() => undefined);
    }
  }

  /** Second attempt for firmware the hardened client will not speak to. */
  private async lenientFallback(
    options: DeviceRequestOptions,
    target: { address: string; port: number },
    timeoutMs: number,
    maxBytes: number,
    startedAt: number,
  ): Promise<DeviceResponse> {
    try {
      const response = await lenientRequest({
        address: target.address,
        port: target.port,
        hostHeader: this.port === 80 ? this.host : `${this.host}:${this.port}`,
        method: options.method ?? 'GET',
        path: options.path,
        headers: {
          'user-agent': 'geekmagic-custom-apps/1.0',
          accept: '*/*',
          ...options.headers,
        },
        ...(options.body === undefined
          ? {}
          : { body: Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body) }),
        timeoutMs,
        maxBytes,
        ...(options.signal ? { signal: options.signal } : {}),
      });

      return {
        status: response.status,
        ok: response.status >= 200 && response.status < 300,
        headers: response.headers,
        body: response.body,
        text: response.body.toString('utf8'),
        truncated: response.truncated,
        durationMs: Date.now() - startedAt,
      };
    } catch (cause) {
      throw toTransportError(cause, this.host, options.path, Date.now() - startedAt);
    }
  }

  async get(
    path: string,
    options: Omit<DeviceRequestOptions, 'path' | 'method'> = {},
  ): Promise<DeviceResponse> {
    return this.request({ ...options, path, method: 'GET' });
  }

  /**
   * Multipart upload with a single file part.
   *
   * Built by hand rather than via FormData because the firmware is strict about part
   * ordering and headers, and because the field name (`file`) is part of the contract.
   */
  async uploadFile(options: {
    path: string;
    fieldName: string;
    filename: string;
    contentType: string;
    data: Buffer;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<DeviceResponse> {
    const boundary = `----gca${randomBytes(12).toString('hex')}`;
    const head = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${options.fieldName}"; filename="${sanitizeFilename(options.filename)}"\r\n` +
        `Content-Type: ${options.contentType}\r\n\r\n`,
      'utf8',
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([head, options.data, tail]);

    return this.request({
      path: options.path,
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(body.length),
      },
      body,
      timeoutMs: options.timeoutMs ?? 20_000,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }
}

async function readCapped(
  body: AsyncIterable<Buffer | Uint8Array> & { destroy?: (err?: Error) => void },
  maxBytes: number,
): Promise<{ body: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        // Stop reading rather than buffering an unbounded response from a device.
        chunks.push(buffer.subarray(0, Math.max(0, buffer.length - (total - maxBytes))));
        truncated = true;
        body.destroy?.();
        break;
      }
      chunks.push(buffer);
    }
  } catch (cause) {
    // A mid-body disconnect still yields whatever arrived; callers decide what it means.
    if (chunks.length === 0) throw cause;
    truncated = true;
  }
  return { body: Buffer.concat(chunks), truncated };
}

function normalizeHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

function toTransportError(
  cause: unknown,
  host: string,
  path: string,
  durationMs: number,
): AppError {
  if (cause instanceof AppError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  const timedOut = /timed out|timeout|UND_ERR_(HEADERS|BODY|CONNECT)_TIMEOUT/i.test(message);
  return new AppError(
    'DEVICE_UNREACHABLE',
    timedOut
      ? `Device at ${host} did not respond in time.`
      : `Device at ${host} is unreachable: ${message}`,
    { cause, details: { host, path, durationMs }, retryable: true },
  );
}

export function splitHostPort(
  value: string,
  defaultPort: number,
): { hostname: string; port: number } {
  let raw = value.trim();
  // Accept a pasted URL as well as a bare host, which is what users actually type.
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      return { hostname: url.hostname, port: url.port ? Number(url.port) : defaultPort };
    } catch {
      raw = raw.replace(/^https?:\/\//i, '');
    }
  }
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end > 0) {
      const hostname = raw.slice(1, end);
      const rest = raw.slice(end + 1);
      const port = rest.startsWith(':') ? Number(rest.slice(1)) : defaultPort;
      return { hostname, port: Number.isFinite(port) ? port : defaultPort };
    }
  }
  const colonCount = (raw.match(/:/g) ?? []).length;
  if (colonCount === 1) {
    const [hostname = raw, portText = ''] = raw.split(':');
    const port = Number(portText);
    return { hostname, port: Number.isFinite(port) && port > 0 ? port : defaultPort };
  }
  return { hostname: raw.replace(/\/+$/, ''), port: defaultPort };
}

function sanitizeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'upload.bin';
}

/**
 * Percent-encodes a value for use in a device query string.
 *
 * Paths coming back from `/filelist` are attacker-influenced data, so every component
 * derived from a device response goes through here before being sent back.
 */
export function encodeQueryComponent(value: string): string {
  return encodeURIComponent(value);
}
