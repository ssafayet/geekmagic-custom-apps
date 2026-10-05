import { describe, expect, it } from 'vitest';
import { sanitizeStatuslinePayload } from '@gca/module-claude-usage';
import {
  buildStatuslinePayload,
  describePush,
  pushUsage,
  type PushDeps,
  type UsageReading,
} from '../src/push.js';

const config = {
  version: 1,
  endpoint: 'http://127.0.0.1:3210/internal/claude/statusline',
  tokenFile: '/tmp/token',
  chainedCommand: null,
};

const reading: UsageReading = {
  fetchedAt: '2026-09-22T12:00:00.000Z',
  fiveHour: { usedPercentage: 15, resetsAt: '2026-09-22T14:10:00.000Z' },
  sevenDay: { usedPercentage: 47, resetsAt: '2026-09-26T09:00:00.000Z' },
};

function deps(overrides: Partial<PushDeps> = {}): PushDeps & { posts: string[] } {
  const posts: string[] = [];
  return {
    posts,
    async readUsage() {
      return reading;
    },
    readToken() {
      return 'a-token';
    },
    async post(_endpoint, _token, body) {
      posts.push(body);
      return { status: 200, body: JSON.stringify({ accepted: true }) };
    },
    ...overrides,
  };
}

describe('buildStatuslinePayload', () => {
  it('produces something the server parses as a real status line', () => {
    const payload: unknown = JSON.parse(buildStatuslinePayload(reading));
    const result = sanitizeStatuslinePayload(payload, { now: new Date('2026-09-22T12:00:00Z') });

    expect(result.ok).toBe(true);
    expect(result.payload?.fiveHour).toEqual({
      usedPercentage: 15,
      resetsAt: '2026-09-22T14:10:00.000Z',
    });
    expect(result.payload?.sevenDay?.usedPercentage).toBe(47);
  });

  it('omits a window the CLI did not report rather than sending a zero', () => {
    const payload = JSON.parse(buildStatuslinePayload({ ...reading, sevenDay: null })) as {
      rate_limits: Record<string, unknown>;
    };

    expect(payload.rate_limits).toHaveProperty('five_hour');
    expect(payload.rate_limits).not.toHaveProperty('seven_day');

    const result = sanitizeStatuslinePayload(payload, { now: new Date('2026-09-22T12:00:00Z') });
    expect(result.payload?.sevenDay).toBeNull();
  });
});

describe('pushUsage', () => {
  it('posts the reading and reports which windows went', async () => {
    const d = deps();
    const result = await pushUsage(config, d);

    expect(result.posted).toBe(true);
    expect(result.accepted).toBe(true);
    expect(result.windows).toEqual({ fiveHour: true, sevenDay: true });
    expect(d.posts).toHaveLength(1);
    expect(describePush(result)).toBe('Pushed usage (5h, 7d).');
  });

  it('sends the token as a bearer and never in the body', async () => {
    let seenToken = '';
    const d = deps({
      async post(_endpoint, token, body) {
        seenToken = token;
        expect(body).not.toContain('a-token');
        return { status: 200, body: '{"accepted":true}' };
      },
    });

    await pushUsage(config, d);
    expect(seenToken).toBe('a-token');
  });

  it('does not post when this machine has no token', async () => {
    const d = deps({ readToken: () => '' });
    const result = await pushUsage(config, d);

    expect(result.posted).toBe(false);
    expect(result.reason).toBe('missing-token');
    expect(d.posts).toHaveLength(0);
    expect(describePush(result)).toContain('pnpm bridge:install');
  });

  it('does not post when there is no local reading', async () => {
    const d = deps({ readUsage: async () => null });
    const result = await pushUsage(config, d);

    expect(result.posted).toBe(false);
    expect(result.reason).toBe('no-local-usage');
    expect(d.posts).toHaveLength(0);
  });

  it('does not post an empty reading', async () => {
    const d = deps({
      readUsage: async () => ({ fetchedAt: reading.fetchedAt, fiveHour: null, sevenDay: null }),
    });
    const result = await pushUsage(config, d);

    expect(result.reason).toBe('no-windows');
    expect(d.posts).toHaveLength(0);
  });

  it('names a token mismatch rather than reporting a generic failure', async () => {
    const d = deps({
      async post() {
        return { status: 401, body: '{"error":{"code":"UNAUTHORIZED"}}' };
      },
    });
    const result = await pushUsage(config, d);

    expect(result.posted).toBe(false);
    expect(result.status).toBe(401);
    expect(describePush(result)).toContain('different bridge token');
  });

  it('reports a payload the server took but could not use', async () => {
    const d = deps({
      async post() {
        return { status: 202, body: '{"accepted":false,"reason":"Invalid payload"}' };
      },
    });
    const result = await pushUsage(config, d);

    expect(result.accepted).toBe(false);
    expect(describePush(result)).toContain('not the payload');
  });
});
