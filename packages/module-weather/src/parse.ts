/** Tolerant readers for provider JSON, where any field may be missing or mistyped. */

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A number, or null. Never coerces a string or turns absence into zero. */
export function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function stringOrNull(value: unknown, maxLength = 48): string | null {
  if (typeof value !== 'string') return null;
  // Collapse whitespace: the panel has one short line for a name and no room for runs.
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : null;
}

/** `Retry-After` is either delta-seconds or an HTTP date; both are honoured. */
export function parseRetryAfter(value: string | undefined): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return null;
}
