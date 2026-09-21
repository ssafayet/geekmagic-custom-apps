import { createHash } from 'node:crypto';
import { isValidIso, toIso } from '@gca/shared';

/** Hard cap enforced by both the bridge and the ingestion endpoint. */
export const MAX_STATUSLINE_BYTES = 64 * 1024;

export interface UsageWindow {
  usedPercentage: number;
  resetsAt: string;
}

/**
 * The only shape that crosses from Claude Code into this application.
 *
 * Deliberately tiny. Prompt text, transcript paths, workspace paths and tool details
 * are never accepted, and the raw session id is hashed rather than stored, because the
 * display has no use for any of it.
 */
export interface SanitizedStatuslinePayload {
  receivedAt: string;
  claudeCodeVersion: string | null;
  sessionKey: string | null;
  modelId: string | null;
  modelDisplayName: string | null;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  spendLimit: UsageWindow | null;
  sessionCostUsd: number | null;
}

export interface SanitizeResult {
  ok: boolean;
  payload: SanitizedStatuslinePayload | null;
  errors: string[];
}

/**
 * Validates and reduces a Claude Code status-line payload to the approved fields.
 *
 * Absence is preserved: Claude Code omits `rate_limits` entirely outside an active
 * session, and omits individual windows too. Those must surface as `unknown`, never
 * as zero, or the display would claim the user has full quota when it does not know.
 */
export function sanitizeStatuslinePayload(
  input: unknown,
  options: { now?: Date } = {},
): SanitizeResult {
  const now = options.now ?? new Date();
  const errors: string[] = [];

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, payload: null, errors: ['Payload must be a JSON object.'] };
  }
  const record = input as Record<string, unknown>;

  const rateLimits =
    record['rate_limits'] &&
    typeof record['rate_limits'] === 'object' &&
    !Array.isArray(record['rate_limits'])
      ? (record['rate_limits'] as Record<string, unknown>)
      : null;

  const payload: SanitizedStatuslinePayload = {
    receivedAt: now.toISOString(),
    claudeCodeVersion: readString(record['version'], 32),
    sessionKey: hashSessionId(record['session_id']),
    modelId: readString(readNested(record['model'], 'id'), 64),
    modelDisplayName: readString(readNested(record['model'], 'display_name'), 64),
    fiveHour: rateLimits ? readWindow(rateLimits['five_hour'], now, errors, 'five_hour') : null,
    sevenDay: rateLimits ? readWindow(rateLimits['seven_day'], now, errors, 'seven_day') : null,
    spendLimit: rateLimits
      ? readWindow(rateLimits['spend_limit'], now, errors, 'spend_limit', {
          allowOverHundred: true,
        })
      : null,
    sessionCostUsd: readCost(record['cost']),
  };

  return { ok: true, payload, errors };
}

function readWindow(
  value: unknown,
  now: Date,
  errors: string[],
  label: string,
  options: { allowOverHundred?: boolean } = {},
): UsageWindow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  const raw = record['used_percentage'];
  const percentage =
    typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(percentage) || percentage < 0) return null;

  // Spend limits legitimately exceed 100%; quota windows are clamped.
  const usedPercentage = options.allowOverHundred ? percentage : Math.min(100, percentage);

  const resetsAt = readResetTimestamp(record['resets_at']);
  if (!resetsAt) return null;

  // A window whose reset time has passed is describing a period that already ended.
  // Showing its old value would be worse than showing nothing.
  if (Date.parse(resetsAt) <= now.getTime()) {
    errors.push(`${label} window already reset at ${resetsAt}`);
    return null;
  }

  return { usedPercentage, resetsAt };
}

/** Claude Code reports reset times as Unix epoch seconds. */
function readResetTimestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const iso = toIso(value);
    return isValidIso(iso) ? iso : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      const iso = toIso(numeric);
      return isValidIso(iso) ? iso : null;
    }
    return isValidIso(value) ? new Date(value).toISOString() : null;
  }
  return null;
}

function readCost(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  const total = (value as Record<string, unknown>)['total_cost_usd'];
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) return null;
  return total;
}

function readNested(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function readString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, maxLength);
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Session ids are hashed before they are ever stored.
 *
 * The display never needs to identify a session, only to notice when one changes, and
 * a truncated hash is enough for that.
 */
export function hashSessionId(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return createHash('sha256').update(value.trim()).digest('hex').slice(0, 16);
}
