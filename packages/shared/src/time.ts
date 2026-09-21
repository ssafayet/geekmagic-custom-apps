/** Every timestamp that crosses a module, API or storage boundary is a UTC ISO 8601 string. */
export type IsoTimestamp = string;

export function nowIso(): IsoTimestamp {
  return new Date().toISOString();
}

export function toIso(value: Date | number | string): IsoTimestamp {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') {
    // Claude Code reports reset timestamps as Unix epoch seconds; JS wants milliseconds.
    const ms = value > 1e12 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  return new Date(value).toISOString();
}

export function isValidIso(value: unknown): value is IsoTimestamp {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function ageSeconds(from: IsoTimestamp, reference: Date = new Date()): number {
  return Math.max(0, Math.round((reference.getTime() - Date.parse(from)) / 1000));
}

export function secondsUntil(target: IsoTimestamp, reference: Date = new Date()): number {
  return Math.round((Date.parse(target) - reference.getTime()) / 1000);
}

/**
 * Compact relative duration for a 240x240 display: "4h 12m", "38m", "in 2d".
 * Rounds to minutes because the display never needs second precision.
 */
export function formatRelativeDuration(seconds: number): string {
  const abs = Math.abs(seconds);
  if (abs < 60) return 'now';
  const minutes = Math.round(abs / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  if (hours < 24) {
    return remainderMinutes === 0 ? `${hours}h` : `${hours}h ${remainderMinutes}m`;
  }
  const days = Math.floor(hours / 24);
  const remainderHours = hours % 24;
  return remainderHours === 0 ? `${days}d` : `${days}d ${remainderHours}h`;
}

export function formatAge(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  return formatRelativeDuration(seconds);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
