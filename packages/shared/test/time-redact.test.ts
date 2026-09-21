import { describe, expect, it } from 'vitest';
import {
  ageSeconds,
  formatAge,
  formatRelativeDuration,
  isValidIso,
  secondsUntil,
  toIso,
} from '../src/time.js';
import { lastFour, redactDeep, roundCoordinateForLog } from '../src/redact.js';
import { slugify } from '../src/ids.js';

describe('time handling', () => {
  it('treats a small number as Unix epoch seconds and a large one as milliseconds', () => {
    // Claude Code reports reset timestamps in seconds.
    expect(toIso(1_700_000_000)).toBe('2023-11-14T22:13:20.000Z');
    expect(toIso(1_700_000_000_000)).toBe('2023-11-14T22:13:20.000Z');
  });

  it('validates ISO timestamps', () => {
    expect(isValidIso('2026-09-21T12:00:00.000Z')).toBe(true);
    expect(isValidIso('not-a-date')).toBe(false);
    expect(isValidIso(1700000000)).toBe(false);
  });

  it('computes ages and countdowns against a fixed reference', () => {
    const reference = new Date('2026-09-21T12:00:00Z');
    expect(ageSeconds('2026-09-21T11:59:00Z', reference)).toBe(60);
    expect(ageSeconds('2026-09-21T12:00:30Z', reference)).toBe(0);
    expect(secondsUntil('2026-09-21T12:05:00Z', reference)).toBe(300);
    expect(secondsUntil('2026-09-21T11:55:00Z', reference)).toBe(-300);
  });

  it.each([
    [30, 'now'],
    [60, '1m'],
    [90, '2m'],
    [3600, '1h'],
    [3720, '1h 2m'],
    [86_400, '1d'],
    [90_000, '1d 1h'],
  ])('formats %d seconds as %s', (seconds, expected) => {
    expect(formatRelativeDuration(seconds)).toBe(expected);
  });

  it('formats sub-minute ages in seconds', () => {
    expect(formatAge(5)).toBe('5s');
    expect(formatAge(59)).toBe('59s');
    expect(formatAge(120)).toBe('2m');
  });
});

describe('redaction', () => {
  it('replaces sensitive keys recursively', () => {
    const input = {
      host: '192.168.1.5',
      apiKey: 'sk-ant-secret',
      nested: { authorization: 'Bearer abc', token: 'xyz', safe: 'keep' },
      list: [{ secret: 'hide' }, { visible: 'show' }],
    };

    const output = redactDeep(input);

    expect(output.apiKey).toBe('[redacted]');
    expect(output.nested.authorization).toBe('[redacted]');
    expect(output.nested.token).toBe('[redacted]');
    expect(output.nested.safe).toBe('keep');
    expect(output.list[0]?.secret).toBe('[redacted]');
    expect(output.list[1]?.visible).toBe('show');
    expect(output.host).toBe('192.168.1.5');
  });

  it('redacts session identifiers and cookies', () => {
    const output = redactDeep({ session_id: 'abc', cookie: 'a=b', sessionId: 'def' });
    expect(output.session_id).toBe('[redacted]');
    expect(output.cookie).toBe('[redacted]');
    expect(output.sessionId).toBe('[redacted]');
  });

  it('survives cyclic-depth abuse without throwing', () => {
    let deep: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < 40; i += 1) deep = { nested: deep };
    expect(() => redactDeep(deep)).not.toThrow();
  });

  it('masks short secrets entirely in lastFour', () => {
    expect(lastFour('sk-ant-admin-abcd7K2P')).toBe('7K2P');
    expect(lastFour('abc')).toBe('***');
  });

  it('rounds coordinates to one decimal place for logs', () => {
    // ~11 km of precision: enough to debug, not enough to locate a home.
    expect(roundCoordinateForLog(51.477512)).toBe(51.5);
    expect(roundCoordinateForLog(-0.461389)).toBe(-0.5);
  });
});

describe('slugify', () => {
  it('produces lowercase kebab-case ids', () => {
    expect(slugify('Home Sky!')).toBe('home-sky');
    expect(slugify('  --Multiple   Spaces--  ')).toBe('multiple-spaces');
  });
});
