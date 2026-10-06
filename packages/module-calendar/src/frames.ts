import { ageSeconds, formatAge } from '@gca/shared';
import type { FrameContext, ModuleFrameDraft, SemanticColor } from '@gca/module-sdk';
import { dueReminder } from './reminders.js';
import type { CalendarSettings } from './settings.js';
import { countdownText, dayLabel, formatClock, formatRange, minutesUntil } from './time.js';
import type { CalendarEvent, CalendarSnapshot } from './types.js';

export const CALENDAR_VIEW_NEXT = 'next';
export const CALENDAR_VIEW_REMINDER = 'reminder';

const MIN_STALE_SECONDS = 30 * 60;
const STALE_POLL_MULTIPLIER = 3;
/**
 * Meetings are known in advance, so a feed that stopped answering still describes the
 * day well for a long while. Past a day it no longer does: meetings will have moved.
 */
export const CALENDAR_OFFLINE_SECONDS = 24 * 60 * 60;

export interface FrameInput {
  snapshot: CalendarSnapshot | null;
  settings: CalendarSettings;
  ctx: FrameContext;
  configured: boolean;
}

export function staleAfterSeconds(settings: CalendarSettings): number {
  return Math.max(MIN_STALE_SECONDS, settings.pollIntervalSeconds * STALE_POLL_MULTIPLIER);
}

/** Events still worth showing: the cached list, unless it is too old to trust. */
export function usableEvents(snapshot: CalendarSnapshot | null, now: Date): CalendarEvent[] {
  if (!snapshot?.lastSuccessAt) return [];
  if (ageSeconds(snapshot.lastSuccessAt, now) > CALENDAR_OFFLINE_SECONDS) return [];
  return snapshot.events;
}

export function buildCalendarFrames(input: FrameInput): ModuleFrameDraft[] {
  const frames = [buildNextFrame(input)];
  const reminder = buildReminderFrame(input);
  // No reminder frame is what ends the interruption: the scheduler drops an attention
  // view with nothing to show rather than pinning the ordinary view on screen.
  if (reminder) frames.push(reminder);
  return frames;
}

function base(settings: CalendarSettings) {
  return { accent: settings.accent as SemanticColor, icon: 'calendar' } as const;
}

export function buildNextFrame(input: FrameInput): ModuleFrameDraft {
  const { snapshot, settings, ctx, configured } = input;
  const frame = {
    ...base(settings),
    id: 'calendar-next',
    viewId: CALENDAR_VIEW_NEXT,
    title: 'Next meeting',
    priority: 'normal' as const,
  };

  if (!configured) {
    return {
      ...frame,
      title: settings.calendarLabel,
      layout: {
        kind: 'error',
        severity: 'info',
        headline: 'Add your calendar',
        detail: 'Paste the secret iCal link in module settings.',
        code: 'CALENDAR_NOT_CONFIGURED',
      },
    };
  }

  if (!snapshot) {
    return {
      ...frame,
      title: settings.calendarLabel,
      layout: {
        kind: 'empty',
        icon: 'calendar',
        headline: 'Starting up',
        detail: 'Reading your calendar',
      },
    };
  }

  const age = snapshot.lastSuccessAt ? ageSeconds(snapshot.lastSuccessAt, ctx.now) : null;
  if (age === null || age > CALENDAR_OFFLINE_SECONDS) {
    const error = snapshot.error;
    return {
      ...frame,
      title: settings.calendarLabel,
      badge: { text: 'offline', tone: 'red' },
      layout: {
        kind: 'error',
        severity: 'error',
        headline: 'Calendar offline',
        detail: error?.message ?? 'The calendar link has not answered.',
        ...(error ? { code: error.code } : {}),
        footer: age === null ? 'No successful read yet' : `Last read ${formatAge(age)} ago`,
      },
    };
  }

  const stale = age > staleAfterSeconds(settings);
  const badge = stale ? { badge: { text: 'stale', tone: 'amber' as const } } : {};
  const nowMs = ctx.now.getTime();
  const ongoing = snapshot.events.filter(
    (event) => Date.parse(event.start) <= nowMs && Date.parse(event.end) > nowMs,
  );
  const upcoming = snapshot.events.filter((event) => Date.parse(event.start) > nowMs);
  // The latest-started of overlapping meetings is the one most likely being attended.
  const current = ongoing[ongoing.length - 1] ?? null;
  const primary = current ?? upcoming[0] ?? null;
  const footer = `${formatAge(age)} ago`;

  if (!primary) {
    return {
      ...frame,
      title: settings.calendarLabel,
      ...badge,
      layout: {
        kind: 'empty',
        icon: 'calendar',
        headline: 'No meetings',
        detail: 'Nothing in the next seven days',
        footer: `${settings.calendarLabel} · ${footer}`,
      },
    };
  }

  const following = upcoming.find((event) => event.key !== primary.key) ?? null;
  return {
    ...frame,
    title: current ? 'In progress' : 'Next meeting',
    ...badge,
    layout: {
      kind: 'event',
      countdownText: current
        ? endsText(current, ctx.now)
        : countdownText(new Date(primary.start), ctx.now, ctx.timezone, settings.timeFormat),
      title: primary.title,
      timeText: formatRange(
        new Date(primary.start),
        new Date(primary.end),
        ctx.timezone,
        settings.timeFormat,
      ),
      ...detailOf(primary),
      ...(following ? { next: nextLine(following, ctx, settings) } : {}),
      attribution: settings.calendarLabel,
      footer,
    },
  };
}

export function buildReminderFrame(input: FrameInput): ModuleFrameDraft | null {
  const { snapshot, settings, ctx, configured } = input;
  if (!configured) return null;
  const events = usableEvents(snapshot, ctx.now);
  const due = dueReminder(events, ctx.now, settings);
  if (!due) return null;

  const following = events.find(
    (event) => event.key !== due.key && Date.parse(event.start) > Date.parse(due.start),
  );
  return {
    ...base(settings),
    id: 'calendar-reminder',
    viewId: CALENDAR_VIEW_REMINDER,
    title: 'Starting soon',
    icon: 'bell',
    // Attention is what lets the reminder interrupt rotation. Never `urgent`.
    priority: 'attention',
    layout: {
      kind: 'event',
      countdownText: `in ${Math.max(1, minutesUntil(new Date(due.start), ctx.now))} min`,
      countdownTone: 'amber',
      title: due.title,
      timeText: formatRange(
        new Date(due.start),
        new Date(due.end),
        ctx.timezone,
        settings.timeFormat,
      ),
      ...detailOf(due),
      ...(following ? { next: nextLine(following, ctx, settings) } : {}),
      attribution: settings.calendarLabel,
    },
  };
}

function endsText(event: CalendarEvent, now: Date): string {
  const minutes = Math.max(1, minutesUntil(new Date(event.end), now));
  if (minutes < 60) return `ends in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `ends in ${hours}h` : `ends in ${hours}h ${remainder}m`;
}

/** A room says where to walk to; failing that, the service says which app to open. */
function detailOf(event: CalendarEvent): { detail?: string } {
  const detail = event.location ?? event.conference;
  return detail ? { detail } : {};
}

function nextLine(
  event: CalendarEvent,
  ctx: FrameContext,
  settings: CalendarSettings,
): { timeText: string; title: string } {
  const start = new Date(event.start);
  const day = dayLabel(start, ctx.now, ctx.timezone);
  const clock = formatClock(start, ctx.timezone, settings.timeFormat);
  return { timeText: day ? `${day} ${clock}` : clock, title: event.title };
}
