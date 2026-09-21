import type { ErrorCode } from '@gca/shared';

const BASE = '/api/v1';
const CSRF_COOKIE = 'gca_csrf';
const CSRF_HEADER = 'x-gca-csrf';

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode | string,
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field-level errors from a failed settings save, keyed by JSON pointer. */
  get fieldErrors(): Array<{ path: string; message: string }> {
    const errors = this.details['errors'];
    return Array.isArray(errors) ? (errors as Array<{ path: string; message: string }>) : [];
  }
}

function readCsrfToken(): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${CSRF_COOKIE}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};

  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    // Double-submit CSRF: the cookie is readable, so the header proves same-origin.
    const csrf = readCsrfToken();
    if (csrf) headers[CSRF_HEADER] = csrf;
  }

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    if (!response.ok) {
      throw new ApiError(
        'INTERNAL_ERROR',
        `Request failed with status ${response.status}.`,
        response.status,
      );
    }
    return (await response.text()) as T;
  }

  const payload = (await response.json()) as
    T | { error: { code: string; message: string; details?: Record<string, unknown> } };

  if (!response.ok) {
    const error = (
      payload as { error?: { code: string; message: string; details?: Record<string, unknown> } }
    ).error;
    throw new ApiError(
      error?.code ?? 'INTERNAL_ERROR',
      error?.message ?? `Request failed with status ${response.status}.`,
      response.status,
      error?.details ?? {},
    );
  }

  return payload as T;
}

/** Cache-busting preview URL; the server sends no-store but browsers still reuse. */
export function previewUrl(path: string, version: string | number): string {
  return `${BASE}${path}${path.includes('?') ? '&' : '?'}v=${encodeURIComponent(String(version))}`;
}
