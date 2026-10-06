import { describe, expect, it } from 'vitest';
import type { AttentionRequest } from '@gca/module-sdk';
import { dueReminder, ReminderController } from '../src/reminders.js';
import type { CalendarEvent } from '../src/types.js';

const START = Date.parse('2026-10-06T14:30:00Z');
const at = (offsetSeconds: number) => new Date(START + offsetSeconds * 1000);

function meeting(key: string, startMs = START, minutes = 30): CalendarEvent {
  return {
    key,
    title: key,
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + minutes * 60_000).toISOString(),
    location: null,
    conference: null,
  };
}

const TEN_MINUTES = { remindersEnabled: true, reminderMinutes: 10 };

describe('dueReminder', () => {
  it('is due from exactly ten minutes before until the start', () => {
    const events = [meeting('a')];
    expect(dueReminder(events, at(-601), TEN_MINUTES)).toBeNull();
    expect(dueReminder(events, at(-600), TEN_MINUTES)?.key).toBe('a');
    expect(dueReminder(events, at(-1), TEN_MINUTES)?.key).toBe('a');
    // Once it has started it is a meeting in progress, not a reminder.
    expect(dueReminder(events, at(0), TEN_MINUTES)).toBeNull();
  });

  it('picks the soonest when two are due', () => {
    const events = [meeting('later', START + 5 * 60_000), meeting('sooner')];
    expect(dueReminder(events, at(-60), TEN_MINUTES)?.key).toBe('sooner');
  });

  it('honours the lead time and the switch', () => {
    const events = [meeting('a')];
    expect(dueReminder(events, at(-300), { remindersEnabled: true, reminderMinutes: 5 })?.key).toBe(
      'a',
    );
    expect(
      dueReminder(events, at(-301), { remindersEnabled: true, reminderMinutes: 5 }),
    ).toBeNull();
    expect(
      dueReminder(events, at(-60), { remindersEnabled: false, reminderMinutes: 10 }),
    ).toBeNull();
  });
});

function recorder() {
  const log: Array<['raise', AttentionRequest] | ['release', string]> = [];
  return {
    log,
    events: {
      requestAttention: (request: AttentionRequest) => log.push(['raise', request]),
      releaseAttention: (key: string) => log.push(['release', key]),
    },
  };
}

describe('ReminderController, until the meeting starts', () => {
  const settings = { reminderDisplay: 'until-start' as const };

  it('holds the reminder until the start, then releases it', () => {
    const { log, events } = recorder();
    const controller = new ReminderController(events, 'reminder');

    controller.update(meeting('a'), at(-600), settings);
    expect(log).toEqual([
      [
        'raise',
        { viewId: 'reminder', key: 'reminder:a', holdSeconds: 600, reason: 'Meeting reminder' },
      ],
    ]);

    // Re-raised on later ticks, so a raise dropped by the cooldown is retried.
    controller.update(meeting('a'), at(-300), settings);
    expect(log[1]).toEqual([
      'raise',
      expect.objectContaining({ key: 'reminder:a', holdSeconds: 300 }),
    ]);
    // Nothing is released while it is still due.
    expect(log.filter(([kind]) => kind === 'release')).toEqual([]);

    controller.update(null, at(0), settings);
    expect(log.at(-1)).toEqual(['release', 'reminder:a']);
    expect(controller.activeKey).toBeNull();
  });

  it('never puts the meeting title in the reason, which is audited', () => {
    const { log, events } = recorder();
    new ReminderController(events, 'reminder').update(
      { ...meeting('a'), title: 'Confidential: layoffs' },
      at(-60),
      settings,
    );
    expect(JSON.stringify(log)).not.toContain('Confidential');
  });

  it('stops re-raising before the scheduler’s ten-minute cap', () => {
    const { log, events } = recorder();
    const controller = new ReminderController(events, 'reminder');
    const long = meeting('a', START);
    controller.update(long, at(-15 * 60), settings);
    controller.update(long, at(-15 * 60 + 9 * 60), settings);
    const raisesBefore = log.length;
    controller.update(long, at(-15 * 60 + 10 * 60), settings);
    expect(log.length).toBe(raisesBefore);
  });

  it('moves to the next meeting, releasing the previous one', () => {
    const { log, events } = recorder();
    const controller = new ReminderController(events, 'reminder');
    controller.update(meeting('a'), at(-60), settings);
    controller.update(meeting('b'), at(-30), settings);
    expect(log.slice(-2)).toEqual([
      ['release', 'reminder:a'],
      ['raise', expect.objectContaining({ key: 'reminder:b' })],
    ]);
  });
});

describe('ReminderController, brief', () => {
  const settings = { reminderDisplay: 'brief' as const };

  it('raises and releases, to a fixed one-minute end', () => {
    const { log, events } = recorder();
    const controller = new ReminderController(events, 'reminder');

    controller.update(meeting('a'), at(-600), settings);
    controller.update(meeting('a'), at(-585), settings);
    expect(log).toEqual([
      ['raise', expect.objectContaining({ key: 'reminder:a', holdSeconds: 60 })],
      ['release', 'reminder:a'],
      // A repeat holds to the same end rather than extending it.
      ['raise', expect.objectContaining({ key: 'reminder:a', holdSeconds: 45 })],
      ['release', 'reminder:a'],
    ]);
  });

  it('stops repeating after its short window', () => {
    const { log, events } = recorder();
    const controller = new ReminderController(events, 'reminder');
    controller.update(meeting('a'), at(-600), settings);
    const count = log.length;
    controller.update(meeting('a'), at(-560), settings);
    expect(log.length).toBe(count);
  });
});
