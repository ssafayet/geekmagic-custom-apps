import { describe, expect, it } from 'vitest';
import { detectConference, expandFeed } from '../src/ics.js';
import { feed, SAMPLE_EVENTS } from './fixtures.js';

const window = (from: string, to: string, attendeeEmail = '') => ({
  from: new Date(from),
  to: new Date(to),
  attendeeEmail,
  limit: 40,
});

const WEEK = window('2026-10-06T00:00:00Z', '2026-10-09T23:59:00Z');

describe('expandFeed', () => {
  it('expands a recurring meeting in its own time zone, across daylight saving', () => {
    const events = expandFeed(feed(SAMPLE_EVENTS), WEEK);
    const standups = events.filter((event) => event.title.startsWith('Standup'));

    // 09:30 New York is 13:30 UTC in October (EDT), not 14:30.
    expect(standups[0]).toMatchObject({
      title: 'Standup',
      start: '2026-10-06T13:30:00.000Z',
      end: '2026-10-06T13:45:00.000Z',
    });
  });

  it('honours a skipped date and a moved occurrence', () => {
    const starts = expandFeed(feed(SAMPLE_EVENTS), WEEK)
      .filter((event) => event.title.startsWith('Standup'))
      .map((event) => [event.title, event.start]);

    expect(starts).toEqual([
      ['Standup', '2026-10-06T13:30:00.000Z'],
      // 7 October is an EXDATE.
      ['Standup (moved)', '2026-10-08T15:00:00.000Z'],
      ['Standup', '2026-10-09T13:30:00.000Z'],
    ]);
  });

  it('leaves out cancelled and all-day entries', () => {
    const titles = expandFeed(feed(SAMPLE_EVENTS), WEEK).map((event) => event.title);
    expect(titles).not.toContain('Cancelled sync');
    expect(titles).not.toContain('Holiday');
  });

  it('skips a meeting declined by the configured attendee, and only then', () => {
    const anyone = expandFeed(feed(SAMPLE_EVENTS), WEEK).map((event) => event.title);
    expect(anyone).toContain('Declined sync');

    const mine = expandFeed(
      feed(SAMPLE_EVENTS),
      window('2026-10-06T00:00:00Z', '2026-10-09T23:59:00Z', 'me@example.com'),
    ).map((event) => event.title);
    expect(mine).not.toContain('Declined sync');

    // Someone else's acceptance changes nothing.
    const theirs = expandFeed(
      feed(SAMPLE_EVENTS),
      window('2026-10-06T00:00:00Z', '2026-10-09T23:59:00Z', 'sam@example.com'),
    ).map((event) => event.title);
    expect(theirs).toContain('Declined sync');
  });

  it('keeps an in-progress meeting and drops finished ones', () => {
    const events = expandFeed(
      feed(SAMPLE_EVENTS),
      window('2026-10-06T13:40:00Z', '2026-10-06T23:00:00Z'),
    );
    expect(events[0]).toMatchObject({ title: 'Standup', start: '2026-10-06T13:30:00.000Z' });
  });

  it('finds an occurrence moved into the window from a later slot', () => {
    const moved = `BEGIN:VEVENT
DTSTART:20261001T100000Z
DTEND:20261001T110000Z
RRULE:FREQ=WEEKLY
UID:weekly@test
SUMMARY:Weekly
END:VEVENT
BEGIN:VEVENT
DTSTART:20261009T120000Z
DTEND:20261009T130000Z
RECURRENCE-ID:20261029T100000Z
UID:weekly@test
SUMMARY:Weekly (pulled forward)
END:VEVENT`;
    const events = expandFeed(feed(moved), window('2026-10-06T00:00:00Z', '2026-10-10T00:00:00Z'));
    expect(events.map((event) => [event.title, event.start])).toEqual([
      ['Weekly', '2026-10-08T10:00:00.000Z'],
      ['Weekly (pulled forward)', '2026-10-09T12:00:00.000Z'],
    ]);
  });

  it('keeps a moved occurrence whose series is missing from the feed', () => {
    const orphan = `BEGIN:VEVENT
DTSTART:20261007T120000Z
DTEND:20261007T123000Z
RECURRENCE-ID:20261007T100000Z
UID:lonely@test
SUMMARY:Orphaned instance
END:VEVENT`;
    const events = expandFeed(feed(orphan), WEEK);
    expect(events.map((event) => event.title)).toEqual(['Orphaned instance']);
  });

  it('separates a room from the conferencing service', () => {
    const events = expandFeed(feed(SAMPLE_EVENTS), WEEK);
    expect(events.find((event) => event.title === 'Design review')).toMatchObject({
      location: 'Room 4B',
      conference: 'Zoom',
    });
    // A location that is only the join link is not a place.
    expect(events.find((event) => event.title === 'Standup')).toMatchObject({
      location: null,
      conference: 'Google Meet',
    });
  });

  it('gives each occurrence of a series its own key', () => {
    const keys = expandFeed(feed(SAMPLE_EVENTS), WEEK).map((event) => event.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('caps the result and sorts it soonest first', () => {
    const events = expandFeed(feed(SAMPLE_EVENTS), { ...WEEK, limit: 2 });
    expect(events).toHaveLength(2);
    expect(Date.parse(events[0]!.start)).toBeLessThanOrEqual(Date.parse(events[1]!.start));
  });

  it('names an untitled meeting rather than drawing an empty line', () => {
    const untitled = `BEGIN:VEVENT
DTSTART:20261007T120000Z
DTEND:20261007T123000Z
UID:untitled@test
END:VEVENT`;
    expect(expandFeed(feed(untitled), WEEK)[0]?.title).toBe('(No title)');
  });

  it('recognises the sign-in page a revoked link returns', () => {
    expect(() => expandFeed('<!DOCTYPE html><html>Sign in</html>', WEEK)).toThrowError(
      expect.objectContaining({
        code: 'CALENDAR_FEED_INVALID',
        message: expect.stringMatching(/web page/),
      }),
    );
    expect(() => expandFeed('{"error":true}', WEEK)).toThrowError(
      expect.objectContaining({ code: 'CALENDAR_FEED_INVALID' }),
    );
  });

  it('tolerates a byte-order mark', () => {
    expect(expandFeed(`﻿${feed(SAMPLE_EVENTS)}`, WEEK).length).toBeGreaterThan(0);
  });

  it('expands a decade-long daily series quickly', () => {
    const started = performance.now();
    expandFeed(feed(SAMPLE_EVENTS), WEEK);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('detectConference', () => {
  it.each([
    ['https://meet.google.com/abc-defg-hij', 'Google Meet'],
    ['Join https://teams.microsoft.com/l/meetup-join/19%3a', 'Teams'],
    ['https://us02web.zoom.us/j/123', 'Zoom'],
    ['https://acme.webex.com/meet/sam', 'Webex'],
    ['Room 4B', null],
  ])('reads %s as %s', (text, expected) => {
    expect(detectConference(text)).toBe(expected);
  });
});
