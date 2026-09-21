import { AppError } from '@gca/shared';
import type { ScopedHttpClient } from '@gca/module-sdk';

export const ANTHROPIC_API_HOST = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const USER_AGENT = 'geekmagic-custom-apps/1.0';

/** Defensive pagination caps: a runaway `next_page` must not loop forever. */
const MAX_PAGES = 20;
const MAX_RECORDS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  requestCount: number;
}

export interface CostTotals {
  todayUsd: number;
  rangeUsd: number;
  currency: string;
}

export interface OrganizationUsageSnapshot {
  source: 'anthropic-usage-api';
  capturedAt: string;
  windowDays: number;
  startingAt: string;
  endingAt: string;
  usage: UsageTotals;
  cost: CostTotals;
  pagesFetched: number;
  truncated: boolean;
}

/**
 * Anthropic organization usage and cost reporting.
 *
 * Only documented organization endpoints are used. There is deliberately no code path
 * that reads Claude Code's OAuth tokens or calls the private endpoint behind `/usage`:
 * subscription allowance is a different product and is obtained from the status line.
 */
export class AnthropicUsageClient {
  constructor(private readonly http: ScopedHttpClient) {}

  async fetchSnapshot(options: {
    apiKey: string;
    windowDays: number;
    now: Date;
    signal: AbortSignal;
  }): Promise<OrganizationUsageSnapshot> {
    const { apiKey, windowDays, now, signal } = options;
    const endingAt = startOfNextUtcDay(now);
    const startingAt = addDays(startOfUtcDay(now), -(windowDays - 1));
    const todayStart = startOfUtcDay(now);

    const usagePages = await this.paginate(
      `${ANTHROPIC_API_HOST}/v1/organizations/usage_report/messages`,
      {
        starting_at: startingAt.toISOString(),
        ending_at: endingAt.toISOString(),
        bucket_width: '1d',
      },
      apiKey,
      signal,
    );

    const costPages = await this.paginate(
      `${ANTHROPIC_API_HOST}/v1/organizations/cost_report`,
      {
        starting_at: startingAt.toISOString(),
        ending_at: endingAt.toISOString(),
        bucket_width: '1d',
      },
      apiKey,
      signal,
    );

    const usage = aggregateUsage(usagePages.records);
    const cost = aggregateCost(costPages.records, todayStart);

    return {
      source: 'anthropic-usage-api',
      capturedAt: now.toISOString(),
      windowDays,
      startingAt: startingAt.toISOString(),
      endingAt: endingAt.toISOString(),
      usage,
      cost,
      pagesFetched: usagePages.pages + costPages.pages,
      truncated: usagePages.truncated || costPages.truncated,
    };
  }

  /** Validates a credential using a minimal, zero-cost usage query. */
  async validateCredential(
    apiKey: string,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; code?: string; message: string }> {
    const now = new Date();
    try {
      // A one-day query is the cheapest authorized read. Never call a paid model
      // endpoint just to find out whether a key works.
      await this.requestPage(
        `${ANTHROPIC_API_HOST}/v1/organizations/usage_report/messages`,
        {
          starting_at: startOfUtcDay(now).toISOString(),
          ending_at: startOfNextUtcDay(now).toISOString(),
          bucket_width: '1d',
          limit: '1',
        },
        apiKey,
        signal,
      );
      return { ok: true, message: 'Credential is authorized for organization usage reporting.' };
    } catch (error) {
      if (error instanceof AppError) {
        return { ok: false, code: error.code, message: error.message };
      }
      throw error;
    }
  }

  private async paginate(
    url: string,
    baseQuery: Record<string, string>,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<{ records: Array<Record<string, unknown>>; pages: number; truncated: boolean }> {
    const records: Array<Record<string, unknown>> = [];
    let page: string | null = null;
    let pages = 0;
    let truncated = false;

    do {
      const query = page ? { ...baseQuery, page } : baseQuery;
      const body = await this.requestPage(url, query, apiKey, signal);
      pages += 1;

      const data = Array.isArray(body['data']) ? (body['data'] as unknown[]) : [];
      for (const item of data) {
        if (item && typeof item === 'object') records.push(item as Record<string, unknown>);
        if (records.length >= MAX_RECORDS) {
          truncated = true;
          break;
        }
      }

      const hasMore = body['has_more'] === true;
      const nextPage = typeof body['next_page'] === 'string' ? body['next_page'] : null;
      page = hasMore && nextPage && !truncated ? nextPage : null;

      if (pages >= MAX_PAGES && page) {
        truncated = true;
        page = null;
      }
    } while (page);

    return { records, pages, truncated };
  }

  private async requestPage(
    url: string,
    query: Record<string, string>,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const search = new URLSearchParams(query).toString();
    const response = await this.http.request(`${url}?${search}`, {
      method: 'GET',
      headers: {
        'anthropic-version': ANTHROPIC_VERSION,
        'x-api-key': apiKey,
        'user-agent': USER_AGENT,
        accept: 'application/json',
      },
      timeoutMs: REQUEST_TIMEOUT_MS,
      signal,
    });

    if (response.status === 401) {
      throw new AppError(
        'ANTHROPIC_USAGE_CREDENTIAL_INVALID',
        'This credential was rejected by Anthropic. Check that it was copied in full and has not been revoked.',
      );
    }
    if (response.status === 403 || response.status === 404) {
      // 404 here usually means "your account cannot see this endpoint", not "typo".
      throw new AppError(
        'ANTHROPIC_USAGE_FORBIDDEN',
        'This credential can call Claude, but it is not authorized for organization usage reporting. Use local Claude Code mode or an Admin/authorized organization credential.',
      );
    }
    if (response.status === 429) {
      throw new AppError(
        'RATE_LIMITED',
        'Anthropic is rate limiting usage requests. Polling will back off.',
        {
          retryable: true,
        },
      );
    }
    if (!response.ok) {
      throw new AppError(
        'ANTHROPIC_USAGE_UNAVAILABLE',
        `Anthropic usage API returned HTTP ${response.status}.`,
        {
          details: { status: response.status },
          retryable: true,
        },
      );
    }

    try {
      const parsed = response.json<Record<string, unknown>>();
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (cause) {
      throw new AppError(
        'ANTHROPIC_USAGE_UNAVAILABLE',
        'Anthropic usage API returned malformed JSON.',
        {
          cause,
          retryable: true,
        },
      );
    }
  }
}

/**
 * Sums usage across buckets and their nested `results` arrays.
 *
 * Field names differ a little between report shapes, so each metric accepts the known
 * aliases rather than silently reporting zero when a name changes.
 */
export function aggregateUsage(records: Array<Record<string, unknown>>): UsageTotals {
  const totals: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    requestCount: 0,
  };

  for (const entry of flattenResults(records)) {
    totals.inputTokens += num(entry, ['uncached_input_tokens', 'input_tokens']);
    totals.outputTokens += num(entry, ['output_tokens']);
    totals.cacheReadTokens += num(entry, ['cache_read_input_tokens', 'cache_read_tokens']);
    totals.cacheCreationTokens += sumCacheCreation(entry);
    totals.requestCount += num(entry, ['num_requests', 'request_count', 'requests']);
  }
  return totals;
}

export function aggregateCost(
  records: Array<Record<string, unknown>>,
  todayStart: Date,
): CostTotals {
  let rangeUsd = 0;
  let todayUsd = 0;
  let currency = 'USD';

  for (const bucket of records) {
    const bucketStart = Date.parse(String(bucket['starting_at'] ?? ''));
    const isToday = Number.isFinite(bucketStart) && bucketStart >= todayStart.getTime();

    for (const entry of flattenResults([bucket])) {
      const amount = readAmount(entry);
      if (amount === null) continue;
      rangeUsd += amount.value;
      if (isToday) todayUsd += amount.value;
      if (amount.currency) currency = amount.currency;
    }
  }

  return { todayUsd: round2(todayUsd), rangeUsd: round2(rangeUsd), currency };
}

function flattenResults(records: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const record of records) {
    const results = record['results'];
    if (Array.isArray(results)) {
      for (const item of results) {
        if (item && typeof item === 'object') out.push(item as Record<string, unknown>);
      }
    } else {
      out.push(record);
    }
  }
  return out;
}

function sumCacheCreation(entry: Record<string, unknown>): number {
  const direct = num(entry, ['cache_creation_input_tokens', 'cache_creation_tokens']);
  if (direct > 0) return direct;
  const nested = entry['cache_creation'];
  if (nested && typeof nested === 'object') {
    return Object.values(nested as Record<string, unknown>).reduce<number>(
      (sum, value) => sum + (typeof value === 'number' && Number.isFinite(value) ? value : 0),
      0,
    );
  }
  return 0;
}

function readAmount(
  entry: Record<string, unknown>,
): { value: number; currency: string | null } | null {
  for (const key of ['amount', 'cost', 'cost_usd', 'total_cost_usd']) {
    const raw = entry[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      const currency = typeof entry['currency'] === 'string' ? entry['currency'] : null;
      return { value: raw, currency };
    }
    // Some responses nest as { amount: { value, currency } } or send a decimal string.
    if (raw && typeof raw === 'object') {
      const nested = raw as Record<string, unknown>;
      const value = typeof nested['value'] === 'number' ? nested['value'] : Number(nested['value']);
      if (Number.isFinite(value)) {
        return {
          value,
          currency: typeof nested['currency'] === 'string' ? nested['currency'] : null,
        };
      }
    }
    if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) {
      return { value: Number(raw), currency: null };
    }
  }
  return null;
}

function num(entry: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function startOfNextUtcDay(date: Date): Date {
  return addDays(startOfUtcDay(date), 1);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}
