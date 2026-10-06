import type { JsonSchema, ModuleUiSchema } from '@gca/module-sdk';

/**
 * Vault key for the calendar link. It is a credential: anyone holding a secret iCal
 * address can read every event on the calendar, so it never sits in settings_json.
 */
export const CALENDAR_URL_SECRET = 'calendarUrl';

export interface CalendarSettings {
  /** Shown in the footer, e.g. `Work`. */
  calendarLabel: string;
  remindersEnabled: boolean;
  reminderMinutes: number;
  /** Keep the reminder up until the meeting starts, or show it briefly and return. */
  reminderDisplay: 'until-start' | 'brief';
  /** Optional. Meetings this attendee declined are skipped. */
  attendeeEmail: string;
  timeFormat: '24h' | '12h';
  pollIntervalSeconds: number;
  accent: 'cyan' | 'blue' | 'green' | 'amber' | 'purple' | 'magenta';
}

export const CALENDAR_DEFAULT_SETTINGS: CalendarSettings = {
  calendarLabel: 'Calendar',
  remindersEnabled: true,
  reminderMinutes: 10,
  reminderDisplay: 'until-start',
  attendeeEmail: '',
  timeFormat: '24h',
  pollIntervalSeconds: 300,
  accent: 'blue',
};

export const CALENDAR_MIN_POLL_SECONDS = 60;
export const CALENDAR_MAX_POLL_SECONDS = 3600;
export const REMINDER_MAX_MINUTES = 60;

export const CALENDAR_SETTINGS_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  properties: {
    calendarLabel: { type: 'string', minLength: 1, maxLength: 24, default: 'Calendar' },
    remindersEnabled: { type: 'boolean', default: true },
    reminderMinutes: {
      type: 'integer',
      minimum: 1,
      maximum: REMINDER_MAX_MINUTES,
      default: 10,
    },
    reminderDisplay: { type: 'string', enum: ['until-start', 'brief'], default: 'until-start' },
    attendeeEmail: { type: 'string', maxLength: 254, default: '' },
    timeFormat: { type: 'string', enum: ['24h', '12h'], default: '24h' },
    pollIntervalSeconds: {
      type: 'integer',
      minimum: CALENDAR_MIN_POLL_SECONDS,
      maximum: CALENDAR_MAX_POLL_SECONDS,
      default: 300,
    },
    accent: {
      type: 'string',
      enum: ['cyan', 'blue', 'green', 'amber', 'purple', 'magenta'],
      default: 'blue',
    },
  },
};

export const CALENDAR_UI_SCHEMA: ModuleUiSchema = {
  sections: [
    {
      id: 'calendar',
      title: 'Calendar',
      description:
        'Paste the secret iCal link from Google Calendar, Outlook, iCloud, Fastmail or Proton. It is stored encrypted; only this module can read it.',
    },
    {
      id: 'reminders',
      title: 'Reminders',
      description:
        'A reminder interrupts whatever the display is showing. It only reaches displays whose playlist includes this calendar.',
    },
    { id: 'display', title: 'Display' },
  ],
  fields: {
    calendarUrl: {
      section: 'calendar',
      order: 1,
      label: 'Calendar link',
      widget: 'password',
      secret: true,
      placeholder: 'https://calendar.google.com/calendar/ical/…/basic.ics',
      help: 'Google: Settings → your calendar → Integrate calendar → Secret address in iCal format. Outlook: Settings → Calendar → Shared calendars → Publish a calendar → ICS. Anyone with this link can read your calendar, so treat it like a password.',
      actionId: 'calendar.test',
    },
    calendarLabel: {
      section: 'calendar',
      order: 2,
      label: 'Label',
      widget: 'text',
      placeholder: 'Calendar',
      help: 'Shown in the footer.',
    },
    attendeeEmail: {
      section: 'calendar',
      order: 3,
      label: 'Your email',
      widget: 'text',
      placeholder: 'you@example.com',
      help: 'Optional. Meetings you declined are skipped. It is matched against the link’s contents on this machine and sent nowhere.',
    },
    remindersEnabled: {
      section: 'reminders',
      order: 1,
      label: 'Remind me before meetings',
      widget: 'switch',
    },
    reminderMinutes: {
      section: 'reminders',
      order: 2,
      label: 'Remind me',
      widget: 'number',
      unit: 'min before',
      min: 1,
      max: REMINDER_MAX_MINUTES,
      step: 1,
      visibleWhen: { field: 'remindersEnabled', equals: [true] },
    },
    reminderDisplay: {
      section: 'reminders',
      order: 3,
      label: 'Reminder stays',
      widget: 'select',
      options: [
        {
          value: 'until-start',
          label: 'Until the meeting starts',
          description: 'A countdown holds the display, for at most ten minutes.',
        },
        {
          value: 'brief',
          label: 'For one minute',
          description: 'Shows once, then the playlist carries on.',
        },
      ],
      visibleWhen: { field: 'remindersEnabled', equals: [true] },
    },
    timeFormat: {
      section: 'display',
      order: 1,
      label: 'Time format',
      widget: 'select',
      options: [
        { value: '24h', label: '24-hour (14:30)' },
        { value: '12h', label: '12-hour (2:30 PM)' },
      ],
    },
    pollIntervalSeconds: {
      section: 'display',
      order: 2,
      label: 'Check the calendar every',
      widget: 'duration',
      unit: 's',
      min: CALENDAR_MIN_POLL_SECONDS,
      max: CALENDAR_MAX_POLL_SECONDS,
      help: 'How soon a newly added meeting appears, at best. The provider may update the link less often than this.',
    },
    accent: {
      section: 'display',
      order: 3,
      label: 'Accent colour',
      widget: 'select',
      options: [
        { value: 'cyan', label: 'Cyan' },
        { value: 'blue', label: 'Blue' },
        { value: 'green', label: 'Green' },
        { value: 'amber', label: 'Amber' },
        { value: 'purple', label: 'Purple' },
        { value: 'magenta', label: 'Magenta' },
      ],
    },
  },
  sectionActions: { calendar: ['calendar.test'], display: ['core.refreshNow'] },
};
