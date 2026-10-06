/**
 * One occurrence of a meeting, already expanded from any recurrence rule.
 *
 * Only timed events reach here: all-day entries are holidays and out-of-office blocks,
 * not meetings, and a reminder ten minutes before midnight would be noise.
 */
export interface CalendarEvent {
  /** Stable per occurrence: the series UID plus which occurrence it is. */
  key: string;
  title: string;
  start: string;
  end: string;
  /** A room or address. Null when the location was only a meeting link. */
  location: string | null;
  /** `Google Meet`, `Zoom`, `Teams`, … detected from the links in the event. */
  conference: string | null;
}

export interface CalendarSnapshot {
  capturedAt: string;
  /** Upcoming and in-progress meetings within the horizon, soonest first. */
  events: CalendarEvent[];
  /** Which service the link belongs to, for the footer and status panel. */
  provider: string | null;
  lastSuccessAt: string | null;
  error: { code: string; message: string; at: string } | null;
}
