import { describe, expect, it } from 'vitest';
import { parseUsageUtilization } from '../src/host/claude-cli.js';

const FETCHED_AT_MS = Date.parse('2026-09-21T17:30:00.000Z');

/** Shaped after a real `~/.claude.json`, sibling codenames and all. */
function config(overrides: Record<string, unknown> = {}) {
  return {
    userID: 'irrelevant',
    cachedUsageUtilization: {
      fetchedAtMs: FETCHED_AT_MS,
      accountUuid: 'irrelevant',
      utilization: {
        five_hour: {
          utilization: 5,
          resets_at: '2026-09-21T20:10:00.882633+00:00',
          limit_dollars: null,
        },
        seven_day: {
          utilization: 47,
          resets_at: '2026-09-22T09:00:00.882660+00:00',
          limit_dollars: null,
        },
        seven_day_opus: null,
        nimbus_quill: { utilization: 0, resets_at: null },
        ...((overrides['utilization'] as object) ?? {}),
      },
    },
  };
}

describe('parseUsageUtilization', () => {
  it('reads the two subscription windows and ignores the rest', () => {
    const parsed = parseUsageUtilization(config());

    expect(parsed).not.toBeNull();
    expect(parsed?.fetchedAtMs).toBe(FETCHED_AT_MS);
    expect(parsed?.reading).toEqual({
      fetchedAt: '2026-09-21T17:30:00.000Z',
      fiveHour: { usedPercentage: 5, resetsAt: '2026-09-21T20:10:00.882Z' },
      sevenDay: { usedPercentage: 47, resetsAt: '2026-09-22T09:00:00.882Z' },
    });
  });

  it('keeps a window whose sibling is missing', () => {
    const parsed = parseUsageUtilization(config({ utilization: { seven_day: null } }));

    expect(parsed?.reading.fiveHour).not.toBeNull();
    expect(parsed?.reading.sevenDay).toBeNull();
  });

  it('returns null when neither window is present, rather than inventing zeros', () => {
    const parsed = parseUsageUtilization(
      config({ utilization: { five_hour: null, seven_day: null } }),
    );

    expect(parsed).toBeNull();
  });

  // The field is internal to Claude Code, so a shape change must degrade to "no
  // local source" instead of throwing inside a refresh.
  it.each([
    ['not an object', 42],
    ['no cache key', { userID: 'x' }],
    ['cache is not an object', { cachedUsageUtilization: 'soon' }],
    ['no utilization member', { cachedUsageUtilization: { fetchedAtMs: 1 } }],
    [
      'window is missing resets_at',
      { cachedUsageUtilization: { utilization: { five_hour: { utilization: 5 } } } },
    ],
    [
      'window has an unparseable reset time',
      {
        cachedUsageUtilization: {
          utilization: { five_hour: { utilization: 5, resets_at: 'whenever' } },
        },
      },
    ],
  ])('returns null when %s', (_label, value) => {
    expect(parseUsageUtilization(value)).toBeNull();
  });

  it('clamps a percentage into range', () => {
    const parsed = parseUsageUtilization(
      config({
        utilization: {
          five_hour: { utilization: 140, resets_at: '2026-09-21T20:10:00Z' },
          seven_day: { utilization: -3, resets_at: '2026-09-22T09:00:00Z' },
        },
      }),
    );

    expect(parsed?.reading.fiveHour?.usedPercentage).toBe(100);
    expect(parsed?.reading.sevenDay?.usedPercentage).toBe(0);
  });
});
