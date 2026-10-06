import { AppError, ageSeconds, formatAge, toAppError } from '@gca/shared';
import type {
  AppModule,
  FrameContext,
  ModuleActionResult,
  ModuleContext,
  ModuleFrameDraft,
  ModuleHealth,
  ModuleManifest,
  ModuleRuntime,
  RefreshReason,
  ValidationContext,
  ValidationResult,
} from '@gca/module-sdk';
import {
  buildCalendarFrames,
  CALENDAR_VIEW_NEXT,
  CALENDAR_VIEW_REMINDER,
  staleAfterSeconds,
  usableEvents,
} from './frames.js';
import { expandFeed } from './ics.js';
import { normaliseFeedUrl } from './providers.js';
import { dueReminder, ReminderController } from './reminders.js';
import {
  CALENDAR_DEFAULT_SETTINGS,
  CALENDAR_MAX_POLL_SECONDS,
  CALENDAR_MIN_POLL_SECONDS,
  CALENDAR_SETTINGS_SCHEMA,
  CALENDAR_UI_SCHEMA,
  CALENDAR_URL_SECRET,
  type CalendarSettings,
} from './settings.js';
import { dayLabel, formatClock } from './time.js';
import type { CalendarEvent, CalendarSnapshot } from './types.js';

type PanelRow = NonNullable<ModuleActionResult['panel']>['rows'][number];

/** How far ahead to look. Far enough to say what Monday holds on a Friday evening. */
const HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EVENTS = 40;
/** Reminders are checked against the cached list this often, independent of polling. */
const REMINDER_TICK_MS = 15_000;
const FEED_TIMEOUT_MS = 20_000;
/** Years of history make a busy calendar's feed several megabytes. */
const FEED_MAX_BYTES = 16 * 1024 * 1024;
/** The scheduler holds one interruption for at most this long. */
const SCHEDULER_INTERRUPTION_CAP_MINUTES = 10;

export const calendarManifest: ModuleManifest = {
  id: 'calendar',
  version: '1.0.0',
  settingsVersion: 1,
  displayName: 'Calendar',
  description:
    'Your next meeting from a calendar link — Google, Outlook, iCloud, Fastmail or Proton — with a reminder that interrupts the display before it starts.',
  icon: 'calendar',
  category: 'productivity',
  // One instance per calendar: work and personal are two links, so two instances.
  singleton: false,
  refresh: {
    defaultSeconds: CALENDAR_DEFAULT_SETTINGS.pollIntervalSeconds,
    minimumSeconds: CALENDAR_MIN_POLL_SECONDS,
    maximumSeconds: CALENDAR_MAX_POLL_SECONDS,
  },
  permissions: ['network:calendar-feeds', 'secrets:read-own'],
  views: [
    {
      id: CALENDAR_VIEW_NEXT,
      displayName: 'Next meeting',
      description: 'The meeting in progress or the next one, and the one after',
      selectable: true,
    },
    {
      id: CALENDAR_VIEW_REMINDER,
      displayName: 'Reminder',
      description: 'Interrupting countdown raised before a meeting starts',
      selectable: false,
    },
  ],
  actions: [
    {
      id: 'calendar.test',
      displayName: 'Test calendar link',
      description: 'Reads the link on screen, without saving it, and lists the next meetings.',
      confirmation: 'none',
      timeoutMs: 25_000,
      inputSchema: {
        type: 'object',
        properties: { calendarUrl: { type: 'string' }, attendeeEmail: { type: 'string' } },
      },
    },
  ],
};

class CalendarRuntime implements ModuleRuntime<CalendarSnapshot> {
  #snapshot: CalendarSnapshot | null = null;
  #configured = false;
  #timer: ReturnType<typeof setInterval> | null = null;
  readonly #reminders: ReminderController;

  constructor(private readonly ctx: ModuleContext<CalendarSettings>) {
    this.#reminders = new ReminderController(ctx.events, CALENDAR_VIEW_REMINDER);
  }

  async start(): Promise<void> {
    this.#configured = await this.ctx.secrets.has(CALENDAR_URL_SECRET);
    // Polling decides how fresh the list is; this decides how punctual the reminder
    // is. A five-minute poll must not mean a reminder up to five minutes late.
    this.#timer = setInterval(() => this.checkReminders(), REMINDER_TICK_MS);
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#reminders.release();
  }

  getSnapshot(): CalendarSnapshot | null {
    return this.#snapshot;
  }

  hydrate(snapshot: unknown): void {
    if (isCalendarSnapshot(snapshot)) {
      this.#snapshot = snapshot;
      // A restart inside a meeting's lead time should still remind.
      this.checkReminders();
    }
  }

  /** Public for tests; the timer calls it every tick. */
  checkReminders(): void {
    const now = this.ctx.now();
    const due = this.#configured
      ? dueReminder(usableEvents(this.#snapshot, now), now, this.ctx.settings)
      : null;
    this.#reminders.update(due, now, this.ctx.settings);
  }

  async refresh(_reason: RefreshReason, signal: AbortSignal): Promise<CalendarSnapshot> {
    const raw = await this.ctx.secrets.get(CALENDAR_URL_SECRET);
    this.#configured = raw !== null && raw.trim() !== '';
    if (!this.#configured) {
      throw new AppError(
        'CALENDAR_NOT_CONFIGURED',
        'Paste your calendar’s secret iCal link in module settings.',
      );
    }

    // The injected clock, not the wall clock: staleness is measured against it.
    const at = this.ctx.now().toISOString();
    let provider: string | null = this.#snapshot?.provider ?? null;
    try {
      const feed = normaliseFeedUrl(raw as string);
      provider = feed.provider;
      const now = this.ctx.now();
      const events = await fetchEvents(
        this.ctx,
        feed.url,
        now,
        this.ctx.settings.attendeeEmail,
        signal,
      );
      this.#snapshot = {
        capturedAt: at,
        events,
        provider,
        lastSuccessAt: at,
        error: null,
      };
      // A meeting added inside its lead time reminds now, not at the next tick.
      this.checkReminders();
      return this.#snapshot;
    } catch (error) {
      const appError = toAppError(error, 'Calendar request failed');
      // Keep the known meetings: they are still mostly right, and reminders keep
      // working from them while the feed is unreachable.
      this.#snapshot = {
        capturedAt: at,
        events: this.#snapshot?.events ?? [],
        provider,
        lastSuccessAt: this.#snapshot?.lastSuccessAt ?? null,
        error: { code: appError.code, message: appError.message, at },
      };
      throw appError;
    }
  }

  async getFrames(ctx: FrameContext): Promise<ModuleFrameDraft[]> {
    return buildCalendarFrames({
      snapshot: this.#snapshot,
      settings: this.ctx.settings,
      ctx,
      configured: this.#configured,
    });
  }

  async getHealth(): Promise<ModuleHealth> {
    if (!this.#configured) {
      return {
        status: 'error',
        message: 'No calendar link saved.',
        code: 'CALENDAR_NOT_CONFIGURED',
      };
    }
    const snapshot = this.#snapshot;
    if (!snapshot) return { status: 'unknown', message: 'Not read yet.' };

    const age = snapshot.lastSuccessAt ? ageSeconds(snapshot.lastSuccessAt, this.ctx.now()) : null;
    if (snapshot.error) {
      const offline = age === null || age > staleAfterSeconds(this.ctx.settings);
      return {
        status: offline ? 'error' : 'degraded',
        message: snapshot.error.message,
        code: snapshot.error.code,
      };
    }

    const upcoming = snapshot.events.filter(
      (event) => Date.parse(event.start) > this.ctx.now().getTime(),
    ).length;
    return {
      status: 'healthy',
      message:
        upcoming === 0
          ? 'No meetings in the next seven days.'
          : `${upcoming} meeting${upcoming === 1 ? '' : 's'} in the next seven days.`,
    };
  }

  async getStatusPanel(): Promise<ModuleActionResult['panel'] | null> {
    const settings = this.ctx.settings;
    const snapshot = this.#snapshot;
    const now = this.ctx.now();
    const age = snapshot?.lastSuccessAt ? ageSeconds(snapshot.lastSuccessAt, now) : null;
    const due = this.#configured ? dueReminder(usableEvents(snapshot, now), now, settings) : null;

    return {
      title: 'Calendar',
      rows: [
        {
          label: 'Link',
          value: this.#configured ? (snapshot?.provider ?? 'saved') : 'not saved',
          tone: this.#configured ? 'neutral' : 'warn',
          ...(snapshot?.error ? { hint: snapshot.error.message } : {}),
        },
        {
          label: 'Last read',
          value: age === null ? 'never' : `${formatAge(age)} ago`,
          tone: snapshot?.error ? 'warn' : 'neutral',
        },
        {
          label: 'Reminders',
          value: settings.remindersEnabled
            ? `${settings.reminderMinutes} min before${due ? ' · one showing now' : ''}`
            : 'off',
          tone: due ? 'good' : 'neutral',
        },
      ],
    };
  }

  async runAction(
    actionId: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<ModuleActionResult> {
    if (actionId !== 'calendar.test') {
      throw new AppError('MODULE_ACTION_UNKNOWN', `Unknown action "${actionId}".`);
    }

    // The input is the whole unsaved form, unvalidated; read only what this needs.
    const payload = (input ?? {}) as Record<string, unknown>;
    const typed = typeof payload['calendarUrl'] === 'string' ? payload['calendarUrl'].trim() : '';
    const raw = typed || (await this.ctx.secrets.get(CALENDAR_URL_SECRET));
    if (!raw) {
      return {
        ok: false,
        message: 'Paste a calendar link first.',
        code: 'CALENDAR_NOT_CONFIGURED',
      };
    }
    const email =
      typeof payload['attendeeEmail'] === 'string'
        ? payload['attendeeEmail']
        : this.ctx.settings.attendeeEmail;

    try {
      const feed = normaliseFeedUrl(raw);
      const now = this.ctx.now();
      const events = await fetchEvents(this.ctx, feed.url, now, email, signal);
      const upcoming = events.filter((event) => Date.parse(event.end) > now.getTime());
      const rows: PanelRow[] = [
        { label: 'Calendar', value: feed.provider, tone: 'good' },
        ...upcoming.slice(0, 4).map((event) => meetingRow(event, now, this.ctx.settings)),
      ];
      return {
        ok: true,
        message:
          upcoming.length === 0
            ? `The link works. ${feed.provider} lists no meetings in the next seven days.`
            : `The link works. ${upcoming.length} meeting${upcoming.length === 1 ? '' : 's'} in the next seven days.`,
        panel: { title: 'Test result', rows },
      };
    } catch (error) {
      const appError = toAppError(error, 'Calendar request failed');
      return { ok: false, message: appError.message, code: appError.code };
    }
  }
}

/**
 * Fetches and expands the feed. The URL carries the secret, so it is never logged,
 * and the scoped client names only the host in its own errors.
 */
async function fetchEvents(
  ctx: ModuleContext<CalendarSettings>,
  url: string,
  now: Date,
  attendeeEmail: string,
  signal: AbortSignal,
): Promise<CalendarEvent[]> {
  const response = await ctx.http.request(url, {
    method: 'GET',
    headers: { accept: 'text/calendar, text/plain;q=0.9, */*;q=0.1' },
    timeoutMs: FEED_TIMEOUT_MS,
    maxBytes: FEED_MAX_BYTES,
    signal,
  });

  if (response.status === 404 || response.status === 410) {
    throw new AppError(
      'CALENDAR_FEED_UNAVAILABLE',
      'The calendar link no longer works. It may have been reset; copy it again from your calendar’s settings.',
      { details: { status: response.status }, retryable: false },
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new AppError(
      'CALENDAR_FEED_UNAVAILABLE',
      'The calendar refused the link. Check it is the secret or published address, and that your organisation allows publishing calendars.',
      { details: { status: response.status }, retryable: false },
    );
  }
  if (!response.ok) {
    throw new AppError(
      'CALENDAR_FEED_UNAVAILABLE',
      `The calendar returned HTTP ${response.status}.`,
      {
        details: { status: response.status },
        retryable: response.status === 429 || response.status >= 500,
      },
    );
  }

  return expandFeed(response.text, {
    from: now,
    to: new Date(now.getTime() + HORIZON_MS),
    attendeeEmail: attendeeEmail.trim().toLowerCase(),
    limit: MAX_EVENTS,
  });
}

function meetingRow(event: CalendarEvent, now: Date, settings: CalendarSettings): PanelRow {
  // Actions get no time zone from the host, unlike frames. The server's own is the
  // closest available, and on a native install it is the user's.
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const start = new Date(event.start);
  const day = dayLabel(start, now, zone);
  const clock = formatClock(start, zone, settings.timeFormat);
  return {
    label: day ? `${day} ${clock}` : clock,
    value: event.title,
    ...(event.conference ? { hint: event.conference } : {}),
  };
}

export const calendarModule: AppModule<CalendarSettings, CalendarSnapshot> = {
  manifest: calendarManifest,
  settingsSchema: CALENDAR_SETTINGS_SCHEMA,
  uiSchema: CALENDAR_UI_SCHEMA,
  defaultSettings: CALENDAR_DEFAULT_SETTINGS,
  secretKeys: [CALENDAR_URL_SECRET],

  async validateSettings(
    settings: unknown,
    ctx: ValidationContext,
  ): Promise<ValidationResult<CalendarSettings>> {
    const value = { ...CALENDAR_DEFAULT_SETTINGS, ...(settings as Partial<CalendarSettings>) };
    const errors: Array<{ path: string; message: string }> = [];

    const email = value.attendeeEmail.trim();
    if (email !== '' && !/^[^\s@]+@[^\s@]+$/.test(email)) {
      errors.push({ path: '/attendeeEmail', message: 'That does not look like an email address.' });
    }
    if (errors.length > 0) return { ok: false, errors };

    const warnings: string[] = [];
    // A missing link is a setup step, not an invalid setting: Add creates the instance
    // from defaults with no secrets, and the link is pasted afterwards. Refusing here
    // would make the module impossible to add. The display and health say what is
    // missing until it arrives.
    if (!ctx.secretConfigured(CALENDAR_URL_SECRET)) {
      warnings.push(
        'No calendar link yet. The display shows “Add your calendar” until you paste one.',
      );
    }
    if (
      value.remindersEnabled &&
      value.reminderDisplay === 'until-start' &&
      value.reminderMinutes > SCHEDULER_INTERRUPTION_CAP_MINUTES
    ) {
      warnings.push(
        `The display holds a reminder for at most ${SCHEDULER_INTERRUPTION_CAP_MINUTES} minutes, so it returns to the playlist before the meeting starts.`,
      );
    }
    return {
      ok: true,
      value: { ...value, attendeeEmail: email },
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },

  async migrateSettings(fromVersion: number, settings: unknown) {
    // Version 1 is the first schema; later versions append cases here.
    return { version: Math.max(1, fromVersion), settings };
  },

  createRuntime(ctx) {
    return new CalendarRuntime(ctx);
  },

  snapshotIsValid: isCalendarSnapshot,
};

function isCalendarSnapshot(value: unknown): value is CalendarSnapshot {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<CalendarSnapshot>;
  return typeof record.capturedAt === 'string' && Array.isArray(record.events);
}
