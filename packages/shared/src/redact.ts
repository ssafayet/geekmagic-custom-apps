const SENSITIVE_KEY_PATTERN =
  /^(api[_-]?key|admin[_-]?api[_-]?key|authorization|auth|token|bridge[_-]?token|cookie|secret|password|passwd|x-api-key|session[_-]?id|set-cookie)$/i;

const REDACTED = '[redacted]';
const MAX_DEPTH = 8;

/**
 * Recursively replaces sensitive values with a marker. Used by the logger and by
 * anything that serializes errors or diagnostics, so a credential never reaches a log
 * file, an audit row or an API response by accident.
 */
export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH) return REDACTED as unknown as T;
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, depth + 1)) as unknown as T;
  }
  if (value instanceof Date || value instanceof Error) return value;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactDeep(item, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}

/** Last four characters of a secret, for "configured / ends in 7K2P" UI affordances. */
export function lastFour(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length <= 4) return trimmed.replace(/./g, '*');
  return trimmed.slice(-4);
}

/**
 * Coordinates are sensitive settings. Logs get a coarse value only; the precise value
 * stays in the encrypted-at-rest database and in outbound provider requests.
 */
export function roundCoordinateForLog(value: number): number {
  return Math.round(value * 10) / 10;
}
