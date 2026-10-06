import ICAL from 'ical.js';
import { AppError } from '@gca/shared';
import type { CalendarEvent } from './types.js';

export interface ExpandOptions {
  /** Occurrences ending at or before this are dropped. */
  from: Date;
  /** Occurrences starting after this are dropped. */
  to: Date;
  /** Lowercased; meetings this attendee declined are skipped. Empty skips nothing. */
  attendeeEmail: string;
  /** Bounds the snapshot; the display never needs more than the next few. */
  limit: number;
}

/**
 * A moved occurrence keeps its original slot as its recurrence ID. One moved *into* the
 * window from a later slot would be missed by stopping at the window's end, so the
 * expansion looks this much further for slots before giving up.
 */
const MOVED_OCCURRENCE_LOOKAHEAD_MS = 31 * 24 * 60 * 60 * 1000;
/** A runaway rule (FREQ=SECONDLY, a corrupt UNTIL) must not stall the poll. */
const MAX_ITERATIONS_PER_SERIES = 50_000;
const MAX_TITLE_LENGTH = 120;
const MAX_LOCATION_LENGTH = 60;

/**
 * Parses an iCalendar feed and expands it into the timed meetings within the window,
 * soonest first.
 *
 * Recurrence rules, EXDATEs and moved or cancelled single occurrences are resolved by
 * ical.js; time zones come from the feed's own VTIMEZONE blocks, which Google, Outlook
 * and iCloud all include. All-day entries, cancelled meetings and ones the attendee
 * declined are left out, because none of them is a meeting to be reminded of.
 */
export function expandFeed(icsText: string, options: ExpandOptions): CalendarEvent[] {
  const root = parseFeed(icsText);

  for (const zone of root.getAllSubcomponents('vtimezone')) {
    // The service is process-wide; a feed re-registering a zone it already sent is
    // harmless, and is what makes its TZIDs resolve instead of reading as floating.
    ICAL.TimezoneService.register(zone);
  }

  const masters = new Map<string, ICAL.Event>();
  const exceptions: ICAL.Event[] = [];
  for (const component of root.getAllSubcomponents('vevent')) {
    const event = new ICAL.Event(component);
    if (!event.uid) continue;
    if (event.isRecurrenceException()) exceptions.push(event);
    else masters.set(event.uid, event);
  }

  const orphans: ICAL.Event[] = [];
  for (const exception of exceptions) {
    const master = masters.get(exception.uid);
    // A feed can carry the moved occurrence without its series; it is still a meeting.
    if (master?.isRecurring()) master.relateException(exception);
    else orphans.push(exception);
  }

  const fromMs = options.from.getTime();
  const toMs = options.to.getTime();
  const found: CalendarEvent[] = [];

  const consider = (item: ICAL.Event, start: ICAL.Time, end: ICAL.Time, occurrence: string) => {
    if (start.isDate) return;
    const startMs = start.toJSDate().getTime();
    const endMs = Math.max(startMs, end.toJSDate().getTime());
    if (endMs <= fromMs || startMs > toMs) return;
    if (isCancelled(item) || declinedBy(item, options.attendeeEmail)) return;
    found.push(toCalendarEvent(item, startMs, endMs, `${item.uid}|${occurrence}`));
  };

  for (const master of masters.values()) {
    if (!master.isRecurring()) {
      consider(master, master.startDate, master.endDate, master.startDate.toString());
      continue;
    }
    if (master.startDate.isDate) continue;

    const iterator = master.iterator();
    const stopAt = toMs + MOVED_OCCURRENCE_LOOKAHEAD_MS;
    for (let count = 0; count < MAX_ITERATIONS_PER_SERIES; count += 1) {
      const slot = iterator.next();
      if (!slot) break;
      if (slot.toJSDate().getTime() > stopAt) break;
      const details = master.getOccurrenceDetails(slot);
      consider(details.item, details.startDate, details.endDate, details.recurrenceId.toString());
    }
  }

  for (const orphan of orphans) {
    consider(orphan, orphan.startDate, orphan.endDate, orphan.recurrenceId.toString());
  }

  return dedupe(found)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.title.localeCompare(b.title))
    .slice(0, Math.max(1, options.limit));
}

function parseFeed(icsText: string): ICAL.Component {
  const body = icsText.replace(/^﻿/, '').trimStart();
  if (!/^BEGIN:VCALENDAR/i.test(body)) {
    // The commonest failure: a revoked or mistyped link answers with a sign-in page.
    throw new AppError(
      'CALENDAR_FEED_INVALID',
      body.startsWith('<')
        ? 'The link returned a web page, not a calendar. Copy the iCal (ICS) address again; it may have been reset.'
        : 'The link did not return an iCalendar feed.',
    );
  }
  try {
    return new ICAL.Component(ICAL.parse(body));
  } catch (cause) {
    throw new AppError('CALENDAR_FEED_INVALID', 'The calendar feed could not be parsed.', {
      cause,
    });
  }
}

function isCancelled(event: ICAL.Event): boolean {
  const status = event.component.getFirstPropertyValue('status');
  return typeof status === 'string' && status.toUpperCase() === 'CANCELLED';
}

function declinedBy(event: ICAL.Event, email: string): boolean {
  if (!email) return false;
  return event.attendees.some((attendee) => {
    const value = attendee.getFirstValue();
    if (typeof value !== 'string') return false;
    const address = value
      .replace(/^mailto:/i, '')
      .trim()
      .toLowerCase();
    const status = attendee.getParameter('partstat');
    return address === email && typeof status === 'string' && status.toUpperCase() === 'DECLINED';
  });
}

function toCalendarEvent(
  event: ICAL.Event,
  startMs: number,
  endMs: number,
  key: string,
): CalendarEvent {
  const location = cleanText(event.location, MAX_LOCATION_LENGTH);
  const description = typeof event.description === 'string' ? event.description : '';
  const extras = ['x-google-conference', 'url']
    .map((name) => event.component.getFirstPropertyValue(name))
    .filter((value): value is string => typeof value === 'string');
  const conference = detectConference([location ?? '', description, ...extras].join(' '));

  return {
    key,
    title: cleanText(event.summary, MAX_TITLE_LENGTH) ?? '(No title)',
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    location: location && !isOnlyALink(location) ? location : null,
    conference,
  };
}

/**
 * Conferencing services by the hosts their join links use. Checked in order, so a Teams
 * invite that also mentions a Zoom fallback in its description reads as Teams.
 */
const CONFERENCE_HOSTS: ReadonlyArray<[label: string, pattern: RegExp]> = [
  ['Google Meet', /\bmeet\.google\.com\b/i],
  ['Teams', /\bteams\.(microsoft|live)\.com\b/i],
  ['Zoom', /\bzoom\.us\b/i],
  ['Webex', /\b[\w-]+\.webex\.com\b/i],
  ['Slack huddle', /\bapp\.slack\.com\/huddle\b/i],
  ['Whereby', /\bwhereby\.com\b/i],
  ['Jitsi', /\bmeet\.jit\.si\b/i],
];

export function detectConference(text: string): string | null {
  for (const [label, pattern] of CONFERENCE_HOSTS) if (pattern.test(text)) return label;
  return null;
}

/**
 * A location that is just a join link, or the placeholder text calendar clients write
 * there, says nothing the conference label does not.
 */
function isOnlyALink(location: string): boolean {
  if (/^https?:\/\/\S+$/i.test(location)) return true;
  return /^(microsoft teams meeting|zoom meeting|google meet)$/i.test(location);
}

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  // The panel has one line for this; collapse folded lines and runs of whitespace.
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : null;
}

/** The same occurrence can arrive twice when a feed repeats a moved instance. */
function dedupe(events: CalendarEvent[]): CalendarEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    if (seen.has(event.key)) return false;
    seen.add(event.key);
    return true;
  });
}
