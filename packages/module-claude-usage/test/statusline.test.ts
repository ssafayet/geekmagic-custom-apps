import { describe, expect, it } from 'vitest';
import { hashSessionId, sanitizeStatuslinePayload } from '../src/statusline.js';

const NOW = new Date('2026-09-21T12:00:00Z');
const IN_THREE_HOURS = Math.floor(NOW.getTime() / 1000) + 3 * 3600;
const IN_TWO_DAYS = Math.floor(NOW.getTime() / 1000) + 2 * 86400;
const AN_HOUR_AGO = Math.floor(NOW.getTime() / 1000) - 3600;

function payload(overrides: Record<string, unknown> = {}) {
  return {
    version: '2.1.263',
    session_id: 'session-abc-123',
    model: { id: 'claude-opus-5', display_name: 'Claude Opus 5' },
    rate_limits: {
      five_hour: { used_percentage: 41.6, resets_at: IN_THREE_HOURS },
      seven_day: { used_percentage: 88.2, resets_at: IN_TWO_DAYS },
    },
    cost: { total_cost_usd: 3.4187 },
    ...overrides,
  };
}

describe('sanitizeStatuslinePayload', () => {
  it('keeps only the approved fields', () => {
    const result = sanitizeStatuslinePayload(payload(), { now: NOW });

    expect(result.ok).toBe(true);
    expect(result.payload).toEqual({
      receivedAt: NOW.toISOString(),
      claudeCodeVersion: '2.1.263',
      sessionKey: hashSessionId('session-abc-123'),
      modelId: 'claude-opus-5',
      modelDisplayName: 'Claude Opus 5',
      fiveHour: { usedPercentage: 41.6, resetsAt: new Date(IN_THREE_HOURS * 1000).toISOString() },
      sevenDay: { usedPercentage: 88.2, resetsAt: new Date(IN_TWO_DAYS * 1000).toISOString() },
      spendLimit: null,
      sessionCostUsd: 3.4187,
    });
  });

  it('discards prompt, transcript, workspace and tool fields entirely', () => {
    const result = sanitizeStatuslinePayload(
      payload({
        cwd: '/Users/someone/private/project',
        transcript_path: '/Users/someone/.claude/transcripts/x.jsonl',
        workspace: { current_dir: '/secret' },
        prompt: 'the user typed something confidential',
        tools: [{ name: 'Bash', input: 'rm -rf /' }],
        output_style: { name: 'default' },
      }),
      { now: NOW },
    );

    const serialized = JSON.stringify(result.payload);
    expect(serialized).not.toContain('private/project');
    expect(serialized).not.toContain('transcripts');
    expect(serialized).not.toContain('confidential');
    expect(serialized).not.toContain('rm -rf');
    expect(Object.keys(result.payload ?? {})).toEqual([
      'receivedAt',
      'claudeCodeVersion',
      'sessionKey',
      'modelId',
      'modelDisplayName',
      'fiveHour',
      'sevenDay',
      'spendLimit',
      'sessionCostUsd',
    ]);
  });

  it('never stores the raw session id', () => {
    const result = sanitizeStatuslinePayload(payload(), { now: NOW });
    expect(result.payload?.sessionKey).not.toBe('session-abc-123');
    expect(result.payload?.sessionKey).toMatch(/^[0-9a-f]{16}$/);
  });

  it('represents a missing rate_limits object as unknown, not zero', () => {
    const { rate_limits: _omitted, ...withoutLimits } = payload();
    const result = sanitizeStatuslinePayload(withoutLimits, { now: NOW });

    expect(result.ok).toBe(true);
    expect(result.payload?.fiveHour).toBeNull();
    expect(result.payload?.sevenDay).toBeNull();
  });

  it('represents an individually omitted window as unknown', () => {
    const result = sanitizeStatuslinePayload(
      payload({ rate_limits: { seven_day: { used_percentage: 12, resets_at: IN_TWO_DAYS } } }),
      { now: NOW },
    );

    expect(result.payload?.fiveHour).toBeNull();
    expect(result.payload?.sevenDay?.usedPercentage).toBe(12);
  });

  it('discards a window whose reset time has already passed', () => {
    const result = sanitizeStatuslinePayload(
      payload({
        rate_limits: { five_hour: { used_percentage: 99, resets_at: AN_HOUR_AGO } },
      }),
      { now: NOW },
    );

    // Showing a stale 99% would be worse than showing nothing.
    expect(result.payload?.fiveHour).toBeNull();
    expect(result.errors.join(' ')).toMatch(/five_hour window already reset/);
  });

  it('discards a window with no reset timestamp', () => {
    const result = sanitizeStatuslinePayload(
      payload({ rate_limits: { five_hour: { used_percentage: 40 } } }),
      { now: NOW },
    );
    expect(result.payload?.fiveHour).toBeNull();
  });

  it('clamps quota windows at 100 percent', () => {
    const result = sanitizeStatuslinePayload(
      payload({ rate_limits: { five_hour: { used_percentage: 143, resets_at: IN_THREE_HOURS } } }),
      { now: NOW },
    );
    expect(result.payload?.fiveHour?.usedPercentage).toBe(100);
  });

  it('preserves a spend limit above 100 percent', () => {
    const result = sanitizeStatuslinePayload(
      payload({
        rate_limits: { spend_limit: { used_percentage: 118.4, resets_at: IN_TWO_DAYS } },
      }),
      { now: NOW },
    );
    expect(result.payload?.spendLimit?.usedPercentage).toBe(118.4);
  });

  it('rejects a negative or non-finite percentage', () => {
    for (const value of [-1, Number.NaN, 'lots', null]) {
      const result = sanitizeStatuslinePayload(
        payload({
          rate_limits: { five_hour: { used_percentage: value, resets_at: IN_THREE_HOURS } },
        }),
        { now: NOW },
      );
      expect(result.payload?.fiveHour).toBeNull();
    }
  });

  it('accepts a percentage sent as a numeric string', () => {
    const result = sanitizeStatuslinePayload(
      payload({
        rate_limits: { five_hour: { used_percentage: '55.5', resets_at: IN_THREE_HOURS } },
      }),
      { now: NOW },
    );
    expect(result.payload?.fiveHour?.usedPercentage).toBe(55.5);
  });

  it('accepts a reset time sent as an ISO string', () => {
    const iso = new Date(IN_THREE_HOURS * 1000).toISOString();
    const result = sanitizeStatuslinePayload(
      payload({ rate_limits: { five_hour: { used_percentage: 10, resets_at: iso } } }),
      { now: NOW },
    );
    expect(result.payload?.fiveHour?.resetsAt).toBe(iso);
  });

  it('omits a missing or invalid session cost', () => {
    expect(
      sanitizeStatuslinePayload(payload({ cost: {} }), { now: NOW }).payload?.sessionCostUsd,
    ).toBeNull();
    expect(
      sanitizeStatuslinePayload(payload({ cost: { total_cost_usd: -1 } }), { now: NOW }).payload
        ?.sessionCostUsd,
    ).toBeNull();
  });

  it('rejects a non-object payload', () => {
    for (const value of [null, 'string', 42, []]) {
      const result = sanitizeStatuslinePayload(value, { now: NOW });
      expect(result.ok).toBe(false);
      expect(result.payload).toBeNull();
    }
  });

  it('truncates absurdly long strings rather than storing them', () => {
    const result = sanitizeStatuslinePayload(payload({ version: 'x'.repeat(5_000) }), { now: NOW });
    expect(result.payload?.claudeCodeVersion?.length).toBe(32);
  });

  it('is stable: the same session id always hashes the same way', () => {
    expect(hashSessionId('abc')).toBe(hashSessionId('abc'));
    expect(hashSessionId('abc')).not.toBe(hashSessionId('abd'));
    expect(hashSessionId('')).toBeNull();
    expect(hashSessionId(undefined)).toBeNull();
  });
});
