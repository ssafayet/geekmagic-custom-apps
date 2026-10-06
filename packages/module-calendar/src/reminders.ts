import type { ModuleEvents } from '@gca/module-sdk';
import type { CalendarSettings } from './settings.js';
import type { CalendarEvent } from './types.js';

/**
 * The scheduler ends any interruption ten minutes after it was raised, so re-raising
 * past that would only restart it and get round the cap. Stop just short of it.
 */
const UNTIL_START_RAISE_WINDOW_MS = 10 * 60 * 1000 - 5_000;
const BRIEF_HOLD_SECONDS = 60;
/**
 * A raise can be dropped by the per-device cooldown after another interruption, and
 * nothing reports that back. Repeating it for a short while is what makes a brief
 * reminder reliable; each repeat only extends the same frame.
 */
const BRIEF_RAISE_WINDOW_MS = 30_000;
const MIN_HOLD_SECONDS = 30;

/** The meeting to remind about now, if any: the soonest one inside its lead time. */
export function dueReminder(
  events: readonly CalendarEvent[],
  now: Date,
  settings: Pick<CalendarSettings, 'remindersEnabled' | 'reminderMinutes'>,
): CalendarEvent | null {
  if (!settings.remindersEnabled) return null;
  const nowMs = now.getTime();
  const leadMs = settings.reminderMinutes * 60_000;
  let soonest: CalendarEvent | null = null;
  for (const event of events) {
    const startMs = Date.parse(event.start);
    if (startMs <= nowMs || startMs - leadMs > nowMs) continue;
    if (!soonest || startMs < Date.parse(soonest.start)) soonest = event;
  }
  return soonest;
}

/**
 * Turns "a meeting is due" into attention requests, one meeting at a time.
 *
 * Only the soonest due meeting is raised: two raised together would replace each other
 * on every tick. Until-start mode keeps the key active, so the scheduler holds the
 * countdown until the meeting starts and the reminder view runs out of frames. Brief
 * mode raises and releases, so the frame stays for its minimum hold and then yields.
 */
export class ReminderController {
  #active: { key: string; firstRaisedAt: number } | null = null;

  constructor(
    private readonly events: Pick<ModuleEvents, 'requestAttention' | 'releaseAttention'>,
    private readonly viewId: string,
  ) {}

  get activeKey(): string | null {
    return this.#active?.key ?? null;
  }

  update(
    due: CalendarEvent | null,
    now: Date,
    settings: Pick<CalendarSettings, 'reminderDisplay'>,
  ): void {
    if (!due) {
      this.release();
      return;
    }

    const key = `reminder:${due.key}`;
    const nowMs = now.getTime();
    if (this.#active?.key !== key) {
      this.release();
      this.#active = { key, firstRaisedAt: nowMs };
    }
    const elapsed = nowMs - this.#active!.firstRaisedAt;
    // The meeting title stays out of this: the reason is written to the audit log.
    const reason = 'Meeting reminder';

    if (settings.reminderDisplay === 'brief') {
      if (elapsed >= BRIEF_RAISE_WINDOW_MS) return;
      // Hold to a fixed end, so repeats inside the window do not stretch the frame.
      const holdSeconds = Math.max(1, Math.round(BRIEF_HOLD_SECONDS - elapsed / 1000));
      this.events.requestAttention({ viewId: this.viewId, key, holdSeconds, reason });
      this.events.releaseAttention(key);
      return;
    }

    if (elapsed >= UNTIL_START_RAISE_WINDOW_MS) return;
    const secondsToStart = Math.round((Date.parse(due.start) - nowMs) / 1000);
    this.events.requestAttention({
      viewId: this.viewId,
      key,
      holdSeconds: Math.min(600, Math.max(MIN_HOLD_SECONDS, secondsToStart)),
      reason,
    });
  }

  release(): void {
    if (!this.#active) return;
    this.events.releaseAttention(this.#active.key);
    this.#active = null;
  }
}
