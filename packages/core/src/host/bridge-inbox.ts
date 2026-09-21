import { timingSafeEqual } from 'node:crypto';
import { AppError, nowIso } from '@gca/shared';
import type { BridgeInboxService, BridgePayload } from '@gca/module-sdk';
import { sanitizeStatuslinePayload, MAX_STATUSLINE_BYTES } from '@gca/module-claude-usage';
import type { EventBus } from '../events.js';

/** Sliding-window rate limit for bridge posts; Claude Code fires on every render. */
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX = 40;

export interface IngestResult {
  accepted: boolean;
  reason?: string;
  payload: BridgePayload | null;
  warnings: string[];
}

/**
 * Holds the most recent sanitized status-line payload.
 *
 * Kept in memory only: it is a live reading, it contains nothing worth persisting,
 * and a restart should show "waiting" rather than resurrect an hour-old percentage.
 */
export class BridgeInbox implements BridgeInboxService {
  #latest: BridgePayload | null = null;
  #token: string | null = null;
  #hits: number[] = [];

  constructor(private readonly events: EventBus) {}

  setToken(token: string): void {
    this.#token = token;
  }

  /** Constant-time comparison so the endpoint cannot be probed for a token prefix. */
  verifyToken(candidate: string | undefined): boolean {
    if (!this.#token || !candidate) return false;
    const expected = Buffer.from(this.#token, 'utf8');
    const actual = Buffer.from(candidate, 'utf8');
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  checkRateLimit(now = Date.now()): boolean {
    this.#hits = this.#hits.filter((at) => now - at < RATE_LIMIT_WINDOW_MS);
    if (this.#hits.length >= RATE_LIMIT_MAX) return false;
    this.#hits.push(now);
    return true;
  }

  ingest(raw: unknown, options: { byteLength?: number; now?: Date } = {}): IngestResult {
    if ((options.byteLength ?? 0) > MAX_STATUSLINE_BYTES) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Status-line payload exceeds the ${MAX_STATUSLINE_BYTES} byte limit.`,
      );
    }

    const result = sanitizeStatuslinePayload(raw, options.now ? { now: options.now } : {});
    if (!result.ok || !result.payload) {
      return {
        accepted: false,
        reason: result.errors.join('; ') || 'Invalid payload',
        payload: null,
        warnings: [],
      };
    }

    this.#latest = result.payload;
    this.events.emit('bridge.payload', { receivedAt: result.payload.receivedAt });
    return { accepted: true, payload: result.payload, warnings: result.errors };
  }

  async latest(): Promise<BridgePayload | null> {
    return this.#latest;
  }

  latestSync(): BridgePayload | null {
    return this.#latest;
  }

  clear(): void {
    this.#latest = null;
  }

  get lastReceivedAt(): string | null {
    return this.#latest?.receivedAt ?? null;
  }

  /** Diagnostics helper: describes state without exposing the token. */
  describe(): {
    connected: boolean;
    lastReceivedAt: string | null;
    tokenConfigured: boolean;
    checkedAt: string;
  } {
    return {
      connected: this.#latest !== null,
      lastReceivedAt: this.#latest?.receivedAt ?? null,
      tokenConfigured: this.#token !== null,
      checkedAt: nowIso(),
    };
  }
}
