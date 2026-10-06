export { calendarModule, calendarManifest } from './module.js';
export {
  CALENDAR_DEFAULT_SETTINGS,
  CALENDAR_SETTINGS_SCHEMA,
  CALENDAR_UI_SCHEMA,
  CALENDAR_URL_SECRET,
} from './settings.js';
export type { CalendarSettings } from './settings.js';
export { expandFeed, detectConference } from './ics.js';
export { FEED_HOSTS, FEED_PROVIDERS, normaliseFeedUrl, providerForHost } from './providers.js';
export { ReminderController, dueReminder } from './reminders.js';
export {
  buildCalendarFrames,
  buildNextFrame,
  buildReminderFrame,
  CALENDAR_VIEW_NEXT,
  CALENDAR_VIEW_REMINDER,
} from './frames.js';
export type * from './types.js';
