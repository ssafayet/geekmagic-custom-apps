import { afterEach, describe, expect, it } from 'vitest';
import { ReminderController, type CalendarEvent } from '@gca/module-calendar';
import { draft, SchedulerHarness } from './scheduler-harness.js';

/**
 * The calendar reminder against the real scheduler.
 *
 * The module's own tests check what it asks for; these check that what it asks for
 * makes the display do the right thing — interrupt at the lead time, hold until the
 * meeting starts, survive a cooldown, and hand the display back afterwards.
 */

const TICK_MS = 15_000;
let harness: SchedulerHarness | null = null;
afterEach(() => {
  harness?.close();
  harness = null;
});

function setup(display: 'until-start' | 'brief') {
  const h = new SchedulerHarness();
  harness = h;
  h.addModule('claude', [draft('claude-frame', 'Claude')]);
  h.addModule('calendar', [draft('calendar-next', 'Next meeting', 'next')]);
  h.addDevice('dev1');
  h.setPlaylist('dev1', [
    { moduleInstanceId: 'claude', viewId: 'main', dwellSeconds: 20 },
    { moduleInstanceId: 'calendar', viewId: 'next', dwellSeconds: 20 },
  ]);
  h.scheduler.rebuildSchedules();

  const controller = new ReminderController(
    {
      requestAttention: (request) =>
        h.events.emit('module.attention', {
          instanceId: 'calendar',
          moduleId: 'calendar',
          ...request,
        }),
      releaseAttention: (key) =>
        h.events.emit('module.attention-released', { instanceId: 'calendar', key }),
    },
    'reminder',
  );

  const meetingStart = h.now + 10 * 60_000;
  const meeting: CalendarEvent = {
    key: 'standup@test|1',
    title: 'Standup',
    start: new Date(meetingStart).toISOString(),
    end: new Date(meetingStart + 15 * 60_000).toISOString(),
    location: null,
    conference: null,
  };

  /** One module tick: what `checkReminders` does, with the frame the module would build. */
  const moduleTick = () => {
    const due = h.now < meetingStart ? meeting : null;
    h.setFrame(
      'calendar',
      'reminder',
      due ? draft('calendar-reminder', 'in 9 min', 'reminder') : null,
    );
    controller.update(due, new Date(h.now), { reminderDisplay: display });
  };

  /** Advances in scheduler ticks, running the module's reminder check every 15 s. */
  const run = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
      h.advance(1_000);
      if ((h.now - meetingStart) % TICK_MS === 0) moduleTick();
      await h.scheduler.tick();
    }
  };

  return { h, meetingStart, moduleTick, run };
}

describe('calendar reminder on the display', () => {
  it('interrupts ten minutes before and holds until the meeting starts', async () => {
    const { h, moduleTick, run } = setup('until-start');
    await h.scheduler.tick();
    expect(h.uploadsFor('dev1')).toEqual(['claude-frame']);

    moduleTick();
    await h.scheduler.tick();
    expect(h.scheduler.describeDevice('dev1').interrupted).toBe(true);
    expect(h.uploadsFor('dev1').at(-1)).toBe('calendar-reminder');

    // Nine and a half minutes of rotation time pass; the reminder stays up throughout.
    await run(9 * 60_000 + 30_000);
    expect(h.scheduler.describeDevice('dev1').interrupted).toBe(true);
    expect(h.uploadsFor('dev1').filter((id) => id === 'claude-frame')).toHaveLength(1);

    // The meeting starts: the reminder is released and has no frame left to show.
    await run(31_000);
    expect(h.scheduler.describeDevice('dev1').interrupted).toBe(false);
    // The display resumes the item the reminder displaced, with a full dwell.
    const uploads = h.uploadsFor('dev1');
    expect(uploads[uploads.lastIndexOf('calendar-reminder') + 1]).toBe('claude-frame');
  });

  it('still arrives when the first raise lands inside another interruption’s cooldown', async () => {
    const { h, moduleTick, run } = setup('until-start');
    await h.scheduler.tick();

    // An unrelated interruption ended a moment ago, so the cooldown is in force.
    h.events.emit('module.attention', {
      instanceId: 'calendar',
      moduleId: 'calendar',
      viewId: 'next',
      key: 'other',
      holdSeconds: 1,
      reason: 'other',
    });
    h.events.emit('module.attention-released', { instanceId: 'calendar', key: 'other' });
    await run(2_000);
    expect(h.scheduler.describeDevice('dev1').interrupted).toBe(false);

    moduleTick();
    await h.scheduler.tick();
    // Dropped by the cooldown…
    expect(h.scheduler.describeDevice('dev1').interrupted).toBe(false);

    // …and picked up by a later check. The checks run on a fixed 15 s phase, so the
    // first retry can still fall inside the 15 s cooldown; the second cannot.
    await run(2 * TICK_MS + 1_000);
    expect(h.scheduler.describeDevice('dev1').interrupted).toBe(true);
    expect(h.uploadsFor('dev1').at(-1)).toBe('calendar-reminder');
  });

  it('shows a brief reminder for about a minute, then returns to the playlist', async () => {
    const { h, moduleTick, run } = setup('brief');
    await h.scheduler.tick();

    moduleTick();
    await h.scheduler.tick();
    expect(h.scheduler.describeDevice('dev1').interrupted).toBe(true);

    await run(50_000);
    expect(h.scheduler.describeDevice('dev1').interrupted).toBe(true);

    await run(15_000);
    expect(h.scheduler.describeDevice('dev1').interrupted).toBe(false);
  });
});
