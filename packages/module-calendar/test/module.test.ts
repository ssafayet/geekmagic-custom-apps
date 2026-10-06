import { afterEach, describe, expect, it } from 'vitest';
import type {
  AttentionRequest,
  EventFrameLayout,
  ModuleContext,
  ModuleFrameDraft,
  ScopedHttpClient,
} from '@gca/module-sdk';
import { calendarModule } from '../src/module.js';
import { normaliseFeedUrl } from '../src/providers.js';
import {
  CALENDAR_DEFAULT_SETTINGS,
  CALENDAR_URL_SECRET,
  type CalendarSettings,
} from '../src/settings.js';
import { feed, SAMPLE_EVENTS } from './fixtures.js';

const GOOGLE_URL =
  'https://calendar.google.com/calendar/ical/me%40example.com/private-abc123/basic.ics';
const signal = new AbortController().signal;

interface Harness {
  runtime: ReturnType<typeof calendarModule.createRuntime>;
  urls: string[];
  attention: Array<['raise', AttentionRequest] | ['release', string]>;
  setNow(value: string): void;
  setFeed(response: { status?: number; body: string } | Error): void;
}

const running: Harness[] = [];
afterEach(async () => {
  for (const harness of running.splice(0)) await harness.runtime.stop();
});

async function harness(
  options: { settings?: Partial<CalendarSettings>; url?: string | null; now?: string } = {},
): Promise<Harness> {
  let now = new Date(options.now ?? '2026-10-06T12:00:00Z');
  let response: { status?: number; body: string } | Error = { body: feed(SAMPLE_EVENTS) };
  const urls: string[] = [];
  const attention: Harness['attention'] = [];
  const http: ScopedHttpClient = {
    async request(url) {
      urls.push(url);
      if (response instanceof Error) throw response;
      const status = response.status ?? 200;
      const text = response.body;
      return { status, ok: status < 300, headers: {}, text, json: <T>() => JSON.parse(text) as T };
    },
  };
  const url = options.url === undefined ? GOOGLE_URL : options.url;
  const noop = () => undefined;
  const ctx: ModuleContext<CalendarSettings> = {
    instanceId: 'cal-1',
    moduleId: 'calendar',
    instanceName: 'Calendar',
    settings: { ...CALENDAR_DEFAULT_SETTINGS, calendarLabel: 'Work', ...options.settings },
    logger: { debug: noop, info: noop, warn: noop, error: noop },
    http,
    secrets: {
      get: async (key) => (key === CALENDAR_URL_SECRET ? url : null),
      has: async (key) => key === CALENDAR_URL_SECRET && url !== null,
    },
    state: { get: async () => null, set: async () => undefined, delete: async () => undefined },
    events: {
      requestDisplayRefresh: noop,
      requestAttention: (request) => attention.push(['raise', request]),
      releaseAttention: (key) => attention.push(['release', key]),
      reportHealth: noop,
    },
    now: () => now,
    host: {},
  };
  const runtime = calendarModule.createRuntime(ctx);
  await runtime.start();
  const created: Harness = {
    runtime,
    urls,
    attention,
    setNow: (value) => (now = new Date(value)),
    setFeed: (next) => (response = next),
  };
  running.push(created);
  return created;
}

async function frames(h: Harness, now: string, timezone = 'America/New_York') {
  h.setNow(now);
  return h.runtime.getFrames({ now: new Date(now), timezone, accent: 'blue' });
}

function eventLayout(list: ModuleFrameDraft[], viewId = 'next'): EventFrameLayout {
  const layout = list.find((frame) => frame.viewId === viewId)?.layout;
  if (layout?.kind !== 'event') throw new Error(`expected an event layout, got ${layout?.kind}`);
  return layout;
}

describe('calendar runtime', () => {
  it('shows the next meeting in the viewer’s time zone, and the one after', async () => {
    const h = await harness();
    await h.runtime.refresh('manual', signal);

    // 08:00 New York; the standup is at 09:30 local.
    const list = await frames(h, '2026-10-06T12:00:00Z');
    expect(list[0]?.title).toBe('Next meeting');
    expect(eventLayout(list)).toMatchObject({
      countdownText: 'in 1h 30m',
      title: 'Standup',
      timeText: '09:30 – 09:45',
      detail: 'Google Meet',
      next: { timeText: '13:00', title: 'Declined sync' },
      attribution: 'Work',
    });
  });

  it('follows the 12-hour preference', async () => {
    const h = await harness({ settings: { timeFormat: '12h' } });
    await h.runtime.refresh('manual', signal);
    expect(eventLayout(await frames(h, '2026-10-06T12:00:00Z')).timeText).toBe('9:30 AM – 9:45 AM');
  });

  it('says how long is left in a meeting already under way', async () => {
    const h = await harness();
    await h.runtime.refresh('manual', signal);
    const list = await frames(h, '2026-10-06T19:40:00Z');
    expect(list[0]?.title).toBe('In progress');
    expect(eventLayout(list)).toMatchObject({
      countdownText: 'ends in 20 min',
      title: 'Design review',
      detail: 'Room 4B',
    });
  });

  it('skips the meeting you declined once it knows who you are', async () => {
    const h = await harness({ settings: { attendeeEmail: 'me@example.com' } });
    await h.runtime.refresh('manual', signal);
    expect(eventLayout(await frames(h, '2026-10-06T12:00:00Z')).next?.title).toBe('Design review');
  });

  it('labels a meeting on another day by day and time', async () => {
    const h = await harness();
    await h.runtime.refresh('manual', signal);
    // After the last meeting on the 6th; the next is the moved standup on the 8th.
    const layout = eventLayout(await frames(h, '2026-10-06T21:00:00Z'));
    expect(layout.countdownText).toBe('Thu 11:00');
    expect(layout.title).toBe('Standup (moved)');
  });
});

describe('reminders', () => {
  it('raises the reminder ten minutes before, with a countdown frame', async () => {
    const h = await harness({ now: '2026-10-06T13:19:00Z' });
    await h.runtime.refresh('manual', signal);
    expect(h.attention).toEqual([]);

    h.setNow('2026-10-06T13:20:00Z');
    (h.runtime as unknown as { checkReminders(): void }).checkReminders();
    expect(h.attention[0]).toEqual([
      'raise',
      expect.objectContaining({ viewId: 'reminder', key: expect.stringContaining('standup@test') }),
    ]);

    const list = await frames(h, '2026-10-06T13:21:30Z');
    const reminder = list.find((frame) => frame.viewId === 'reminder')!;
    expect(reminder.priority).toBe('attention');
    expect(reminder.title).toBe('Starting soon');
    expect(eventLayout(list, 'reminder')).toMatchObject({
      countdownText: 'in 9 min',
      countdownTone: 'amber',
      title: 'Standup',
    });
  });

  it('ends the reminder when the meeting starts', async () => {
    const h = await harness({ now: '2026-10-06T13:25:00Z' });
    await h.runtime.refresh('manual', signal);

    h.setNow('2026-10-06T13:30:00Z');
    (h.runtime as unknown as { checkReminders(): void }).checkReminders();
    expect(h.attention.at(-1)).toEqual(['release', expect.stringContaining('standup@test')]);
    // No reminder frame either, so the scheduler drops the interruption at once.
    const list = await frames(h, '2026-10-06T13:30:00Z');
    expect(list.map((frame) => frame.viewId)).toEqual(['next']);
  });

  it('reminds at once for a meeting found already inside its lead time', async () => {
    const h = await harness({ now: '2026-10-06T13:26:00Z' });
    await h.runtime.refresh('manual', signal);
    expect(h.attention[0]?.[0]).toBe('raise');
  });

  it('follows the configured lead time', async () => {
    const h = await harness({ now: '2026-10-06T13:20:00Z', settings: { reminderMinutes: 5 } });
    await h.runtime.refresh('manual', signal);
    expect(h.attention).toEqual([]);
    const list = await frames(h, '2026-10-06T13:20:00Z');
    expect(list.some((frame) => frame.viewId === 'reminder')).toBe(false);
  });

  it('keeps reminding from the cached list while the feed is down', async () => {
    const h = await harness({ now: '2026-10-06T12:00:00Z' });
    await h.runtime.refresh('manual', signal);
    h.setFeed(new Error('getaddrinfo ENOTFOUND'));
    h.setNow('2026-10-06T13:21:00Z');
    await expect(h.runtime.refresh('scheduled', signal)).rejects.toThrow();

    (h.runtime as unknown as { checkReminders(): void }).checkReminders();
    expect(h.attention.at(-1)?.[0]).toBe('raise');
  });

  it('releases an active reminder when the module stops', async () => {
    const h = await harness({ now: '2026-10-06T13:25:00Z' });
    await h.runtime.refresh('manual', signal);
    await h.runtime.stop();
    expect(h.attention.at(-1)).toEqual(['release', expect.stringContaining('standup@test')]);
  });
});

describe('failures', () => {
  it('asks for a link before doing anything', async () => {
    const h = await harness({ url: null });
    await expect(h.runtime.refresh('startup', signal)).rejects.toMatchObject({
      code: 'CALENDAR_NOT_CONFIGURED',
    });
    expect(h.urls).toEqual([]);
    expect((await frames(h, '2026-10-06T12:00:00Z'))[0]?.layout).toMatchObject({
      kind: 'error',
      headline: 'Add your calendar',
    });
  });

  it('refuses a link from an unsupported host before any request', async () => {
    const h = await harness({ url: 'https://example.com/calendar.ics' });
    await expect(h.runtime.refresh('manual', signal)).rejects.toMatchObject({
      code: 'CALENDAR_FEED_UNSUPPORTED',
      message: expect.stringContaining('Google Calendar'),
    });
    expect(h.urls).toEqual([]);
  });

  it('explains a reset link without retrying it', async () => {
    const h = await harness();
    h.setFeed({ status: 404, body: 'Not Found' });
    await expect(h.runtime.refresh('manual', signal)).rejects.toMatchObject({
      code: 'CALENDAR_FEED_UNAVAILABLE',
      retryable: false,
      message: expect.stringMatching(/reset/),
    });
  });

  it('goes stale, then offline, without losing the known meetings early', async () => {
    const h = await harness({ now: '2026-10-06T12:00:00Z' });
    await h.runtime.refresh('manual', signal);
    h.setFeed({ status: 503, body: 'busy' });

    h.setNow('2026-10-06T13:00:00Z');
    await expect(h.runtime.refresh('scheduled', signal)).rejects.toThrow();
    const stale = (await frames(h, '2026-10-06T13:00:00Z'))[0]!;
    expect(stale.badge).toEqual({ text: 'stale', tone: 'amber' });
    expect(stale.layout.kind).toBe('event');

    const offline = (await frames(h, '2026-10-07T13:00:00Z'))[0]!;
    expect(offline.layout).toMatchObject({ kind: 'error', headline: 'Calendar offline' });
  });

  it('never puts the secret link in an error or the status panel', async () => {
    const h = await harness();
    h.setFeed({ status: 500, body: 'oops' });
    const failure = await h.runtime.refresh('manual', signal).catch((error: unknown) => error);
    const panel = await h.runtime.getStatusPanel?.();
    const health = await h.runtime.getHealth();
    expect(JSON.stringify({ failure: String(failure), panel, health })).not.toContain(
      'private-abc123',
    );
  });
});

describe('test action', () => {
  it('tests a link typed into the form before it is saved', async () => {
    const h = await harness({ url: null });
    const typed = GOOGLE_URL.replace('https://', 'webcal://');
    const result = await h.runtime.runAction!('calendar.test', { calendarUrl: typed }, signal);

    expect(result.ok).toBe(true);
    expect(h.urls[0]).toBe(GOOGLE_URL);
    expect(result.panel?.rows[0]).toEqual({
      label: 'Calendar',
      value: 'Google Calendar',
      tone: 'good',
    });
    expect(result.panel?.rows.length).toBeGreaterThan(1);
  });

  it('reports a bad link as a failed test with the reason', async () => {
    const h = await harness();
    h.setFeed({ body: '<html>Sign in to continue</html>' });
    const result = await h.runtime.runAction!('calendar.test', {}, signal);
    expect(result).toMatchObject({ ok: false, code: 'CALENDAR_FEED_INVALID' });
  });
});

describe('validateSettings', () => {
  const ctx = (configured: boolean) => ({
    instanceId: null,
    secretConfigured: (key: string) => configured && key === CALENDAR_URL_SECRET,
  });

  it('accepts defaults with no link, so the module can be added first', async () => {
    // The Add button creates an instance from defaults with no secrets.
    const result = await calendarModule.validateSettings({}, ctx(false));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings?.[0]).toMatch(/No calendar link yet/);
  });

  it('checks the email looks like one, and trims it', async () => {
    const bad = await calendarModule.validateSettings({ attendeeEmail: 'not an email' }, ctx(true));
    expect(bad.ok).toBe(false);
    const good = await calendarModule.validateSettings(
      { attendeeEmail: ' me@example.com ' },
      ctx(true),
    );
    expect(good.ok && good.value.attendeeEmail).toBe('me@example.com');
  });

  it('warns that a long lead time outlasts the display’s ten-minute hold', async () => {
    const result = await calendarModule.validateSettings({ reminderMinutes: 15 }, ctx(true));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings?.[0]).toMatch(/at most 10 minutes/);

    const brief = await calendarModule.validateSettings(
      { reminderMinutes: 15, reminderDisplay: 'brief' },
      ctx(true),
    );
    expect(brief.ok && brief.warnings).toBeFalsy();
  });
});

describe('normaliseFeedUrl', () => {
  it.each([
    [GOOGLE_URL, 'Google Calendar'],
    ['https://outlook.office365.com/owa/calendar/abc/def/calendar.ics', 'Outlook'],
    ['webcal://p52-caldav.icloud.com/published/2/MTIz', 'iCloud'],
    ['https://user.fm/calendar/v1-abc/Calendar.ics', 'Fastmail'],
  ])('accepts %s as %s', (url, provider) => {
    expect(normaliseFeedUrl(url).provider).toBe(provider);
    expect(normaliseFeedUrl(url).url.startsWith('https://')).toBe(true);
  });

  it.each([
    ['http://calendar.google.com/x.ics', /https/],
    ['https://icloud.com.evil.example/x.ics', /not supported/],
    ['https://evilicloud.com/x.ics', /not supported/],
    ['not a url', /does not look like a link/],
  ])('refuses %s', (url, message) => {
    expect(() => normaliseFeedUrl(url)).toThrowError(message);
  });
});
