import { describe, expect, it } from 'vitest';
import type { ScopedHttpClient } from '@gca/module-sdk';
import {
  aggregateCost,
  aggregateUsage,
  AnthropicUsageClient,
  startOfNextUtcDay,
  startOfUtcDay,
} from '../src/usage-api.js';

const NOW = new Date('2026-09-21T14:30:00Z');
const signal = new AbortController().signal;

interface Route {
  status?: number;
  body: unknown;
}

function client(routes: (url: string, call: number) => Route): {
  http: ScopedHttpClient;
  urls: string[];
  headers: Array<Record<string, string>>;
} {
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  let call = 0;

  const http: ScopedHttpClient = {
    async request(url, options) {
      urls.push(url);
      headers.push((options?.headers ?? {}) as Record<string, string>);
      const route = routes(url, call++);
      const text = JSON.stringify(route.body);
      const status = route.status ?? 200;
      return {
        status,
        ok: status >= 200 && status < 300,
        headers: {},
        text,
        json: <T>() => JSON.parse(text) as T,
      };
    },
  };
  return { http, urls, headers };
}

describe('AnthropicUsageClient', () => {
  it('sends the documented headers and never a credential in the URL', async () => {
    const { http, urls, headers } = client(() => ({ body: { data: [], has_more: false } }));

    await new AnthropicUsageClient(http).fetchSnapshot({
      apiKey: 'sk-ant-admin-secret',
      windowDays: 7,
      now: NOW,
      signal,
    });

    expect(headers[0]).toMatchObject({
      'anthropic-version': '2023-06-01',
      'x-api-key': 'sk-ant-admin-secret',
    });
    expect(headers[0]?.['user-agent']).toMatch(/^geekmagic-custom-apps\//);
    for (const url of urls) expect(url).not.toContain('sk-ant');
  });

  it('requests bounded UTC day buckets covering the configured window', async () => {
    const { http, urls } = client(() => ({ body: { data: [], has_more: false } }));

    await new AnthropicUsageClient(http).fetchSnapshot({
      apiKey: 'k',
      windowDays: 7,
      now: NOW,
      signal,
    });

    const parsed = new URL(urls[0] as string);
    expect(parsed.pathname).toBe('/v1/organizations/usage_report/messages');
    expect(parsed.searchParams.get('bucket_width')).toBe('1d');
    expect(parsed.searchParams.get('starting_at')).toBe('2026-09-15T00:00:00.000Z');
    expect(parsed.searchParams.get('ending_at')).toBe('2026-09-22T00:00:00.000Z');
    expect(urls[1]).toContain('/v1/organizations/cost_report');
  });

  it('follows pagination through has_more and next_page', async () => {
    const { http, urls } = client((url, call) => {
      if (url.includes('usage_report')) {
        if (call === 0) {
          return {
            body: {
              data: [{ results: [{ uncached_input_tokens: 100, output_tokens: 10 }] }],
              has_more: true,
              next_page: 'page-2',
            },
          };
        }
        return {
          body: {
            data: [{ results: [{ uncached_input_tokens: 50, output_tokens: 5 }] }],
            has_more: false,
          },
        };
      }
      return { body: { data: [], has_more: false } };
    });

    const snapshot = await new AnthropicUsageClient(http).fetchSnapshot({
      apiKey: 'k',
      windowDays: 1,
      now: NOW,
      signal,
    });

    expect(urls[1]).toContain('page=page-2');
    expect(snapshot.usage.inputTokens).toBe(150);
    expect(snapshot.usage.outputTokens).toBe(15);
  });

  it('stops paginating at the page cap and flags truncation', async () => {
    const { http, urls } = client(() => ({
      body: { data: [{ results: [{ output_tokens: 1 }] }], has_more: true, next_page: 'again' },
    }));

    const snapshot = await new AnthropicUsageClient(http).fetchSnapshot({
      apiKey: 'k',
      windowDays: 1,
      now: NOW,
      signal,
    });

    expect(snapshot.truncated).toBe(true);
    // 20 pages for each of the two reports.
    expect(urls).toHaveLength(40);
  });

  it('maps 401 to an invalid-credential error', async () => {
    const { http } = client(() => ({ status: 401, body: { error: 'unauthorized' } }));

    await expect(
      new AnthropicUsageClient(http).fetchSnapshot({
        apiKey: 'k',
        windowDays: 7,
        now: NOW,
        signal,
      }),
    ).rejects.toMatchObject({ code: 'ANTHROPIC_USAGE_CREDENTIAL_INVALID' });
  });

  it('maps 403 and 404 to a precise "not authorized for usage reporting" message', async () => {
    for (const status of [403, 404]) {
      const { http } = client(() => ({ status, body: {} }));
      const error = await new AnthropicUsageClient(http)
        .fetchSnapshot({ apiKey: 'k', windowDays: 7, now: NOW, signal })
        .catch((e: unknown) => e);

      expect(error).toMatchObject({ code: 'ANTHROPIC_USAGE_FORBIDDEN' });
      expect(String((error as Error).message)).toMatch(
        /can call Claude, but it is not authorized for organization usage reporting/,
      );
    }
  });

  it('validates a credential with a single minimal query and no model call', async () => {
    const { http, urls } = client(() => ({ body: { data: [], has_more: false } }));

    const result = await new AnthropicUsageClient(http).validateCredential('sk-ant-admin', signal);

    expect(result.ok).toBe(true);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('usage_report/messages');
    expect(urls[0]).toContain('limit=1');
    // Nothing that costs money is ever called.
    expect(urls.some((url) => url.includes('/v1/messages?') || url.endsWith('/v1/messages'))).toBe(
      false,
    );
  });

  it('reports a credential failure without throwing', async () => {
    const { http } = client(() => ({ status: 403, body: {} }));
    const result = await new AnthropicUsageClient(http).validateCredential('sk-ant', signal);

    expect(result.ok).toBe(false);
    expect(result.code).toBe('ANTHROPIC_USAGE_FORBIDDEN');
  });
});

describe('aggregateUsage', () => {
  it('sums nested results across buckets', () => {
    const totals = aggregateUsage([
      {
        results: [
          {
            uncached_input_tokens: 1000,
            output_tokens: 200,
            cache_read_input_tokens: 50,
            num_requests: 3,
          },
          { uncached_input_tokens: 500, output_tokens: 100, num_requests: 2 },
        ],
      },
      { results: [{ uncached_input_tokens: 250, output_tokens: 25, num_requests: 1 }] },
    ]);

    expect(totals).toEqual({
      inputTokens: 1750,
      outputTokens: 325,
      cacheReadTokens: 50,
      cacheCreationTokens: 0,
      requestCount: 6,
    });
  });

  it('accepts flat records without a results array', () => {
    expect(aggregateUsage([{ input_tokens: 10, output_tokens: 2 }]).inputTokens).toBe(10);
  });

  it('sums a nested cache_creation breakdown', () => {
    const totals = aggregateUsage([
      {
        results: [
          { cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 40 } },
        ],
      },
    ]);
    expect(totals.cacheCreationTokens).toBe(140);
  });

  it('returns zeros for an empty report rather than throwing', () => {
    expect(aggregateUsage([])).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      requestCount: 0,
    });
  });
});

describe('aggregateCost', () => {
  const todayStart = startOfUtcDay(NOW);

  it('separates today from the rest of the range', () => {
    const totals = aggregateCost(
      [
        { starting_at: '2026-09-20T00:00:00Z', results: [{ amount: 12.5, currency: 'USD' }] },
        { starting_at: '2026-09-21T00:00:00Z', results: [{ amount: 7.25, currency: 'USD' }] },
      ],
      todayStart,
    );

    expect(totals.todayUsd).toBe(7.25);
    expect(totals.rangeUsd).toBe(19.75);
    expect(totals.currency).toBe('USD');
  });

  it('reads a nested amount object', () => {
    const totals = aggregateCost(
      [
        {
          starting_at: '2026-09-21T00:00:00Z',
          results: [{ amount: { value: 3.5, currency: 'USD' } }],
        },
      ],
      todayStart,
    );
    expect(totals.todayUsd).toBe(3.5);
  });

  it('reads a decimal string amount', () => {
    const totals = aggregateCost(
      [{ starting_at: '2026-09-21T00:00:00Z', results: [{ amount: '1.23' }] }],
      todayStart,
    );
    expect(totals.todayUsd).toBe(1.23);
  });

  it('rounds to cents', () => {
    const totals = aggregateCost(
      [{ starting_at: '2026-09-21T00:00:00Z', results: [{ amount: 0.1 }, { amount: 0.2 }] }],
      todayStart,
    );
    expect(totals.todayUsd).toBe(0.3);
  });
});

describe('UTC day boundaries', () => {
  it('computes the start of today and tomorrow in UTC', () => {
    expect(startOfUtcDay(NOW).toISOString()).toBe('2026-09-21T00:00:00.000Z');
    expect(startOfNextUtcDay(NOW).toISOString()).toBe('2026-09-22T00:00:00.000Z');
  });
});
