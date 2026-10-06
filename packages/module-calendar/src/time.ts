import type { CalendarSettings } from './settings.js';

type TimeFormat = CalendarSettings['timeFormat'];

/** An invalid zone name would throw from Intl on every render; fall back once, quietly. */
function safeZone(timezone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return timezone;
  } catch {
    return 'UTC';
  }
}

export function formatClock(date: Date, timezone: string, format: TimeFormat): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: safeZone(timezone),
    hour: format === '12h' ? 'numeric' : '2-digit',
    minute: '2-digit',
    hourCycle: format === '12h' ? 'h12' : 'h23',
  }).format(date);
}

export function formatRange(start: Date, end: Date, timezone: string, format: TimeFormat): string {
  return `${formatClock(start, timezone, format)} – ${formatClock(end, timezone, format)}`;
}

/** Calendar-day difference between two instants as seen in `timezone`. */
export function dayOffset(date: Date, reference: Date, timezone: string): number {
  const toDayNumber = (value: Date) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: safeZone(timezone),
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    }).formatToParts(value);
    const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value);
    return Date.UTC(part('year'), part('month') - 1, part('day')) / 86_400_000;
  };
  return toDayNumber(date) - toDayNumber(reference);
}

/** `Tomorrow`, `Mon`, `14 Oct`; empty for today. */
export function dayLabel(date: Date, now: Date, timezone: string): string {
  const offset = dayOffset(date, now, timezone);
  if (offset === 0) return '';
  if (offset === 1) return 'Tomorrow';
  const zone = safeZone(timezone);
  if (offset > 1 && offset < 7) {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short' }).format(date);
  }
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    day: 'numeric',
    month: 'short',
  }).format(date);
}

/**
 * Minutes until `start`, rounded up: at 9 min 10 s to go a countdown says "10 min",
 * which is the convention every clock and calendar follows.
 */
export function minutesUntil(start: Date, now: Date): number {
  return Math.ceil((start.getTime() - now.getTime()) / 60_000);
}

/** `in 9 min`, `in 2h 15m`; for another day, the day and the start time instead. */
export function countdownText(
  start: Date,
  now: Date,
  timezone: string,
  format: TimeFormat,
): string {
  const day = dayLabel(start, now, timezone);
  if (day) return `${day} ${formatClock(start, timezone, format)}`;
  const minutes = Math.max(1, minutesUntil(start, now));
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `in ${hours}h` : `in ${hours}h ${remainder}m`;
}
