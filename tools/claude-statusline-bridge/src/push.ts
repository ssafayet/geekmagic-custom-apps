import { readFileSync } from 'node:fs';
import type { BridgeConfig } from './bridge.js';

const POST_TIMEOUT_MS = 5_000;

/** Matches `ClaudeCliUsageReading` structurally, without depending on the module SDK. */
export interface UsageWindow {
  usedPercentage: number;
  resetsAt: string;
}

export interface UsageReading {
  fetchedAt: string;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
}

export interface PushResult {
  posted: boolean;
  /** HTTP status when a request was actually made. */
  status: number | null;
  /** Server's own answer: it accepts a payload it cannot use, and says so. */
  accepted: boolean | null;
  windows: { fiveHour: boolean; sevenDay: boolean };
  reason: string | null;
}

export interface PushDeps {
  readUsage: () => Promise<UsageReading | null>;
  readToken: (path: string) => string;
  post: (
    endpoint: string,
    token: string,
    body: string,
  ) => Promise<{ status: number; body: string }>;
}

/**
 * Sends locally-read usage to the service as a status-line payload.
 *
 * The bridge proper only fires when Claude Code renders a status line, which it does
 * not do in every client. A containerised server cannot cover that gap itself: there
 * is no `claude` binary inside the container, and its home directory is deliberately
 * never mounted. So the host pushes instead — same endpoint, same token, same payload
 * shape the server already parses, driven by a timer rather than by a render.
 */
export async function pushUsage(
  config: BridgeConfig,
  deps: PushDeps = defaultPushDeps(),
): Promise<PushResult> {
  const empty = { fiveHour: false, sevenDay: false };

  const token = deps.readToken(config.tokenFile);
  if (!token) {
    return { posted: false, status: null, accepted: null, windows: empty, reason: 'missing-token' };
  }

  const reading = await deps.readUsage();
  if (!reading) {
    // No local reading is not a failure: Claude Code may simply never have run here.
    return {
      posted: false,
      status: null,
      accepted: null,
      windows: empty,
      reason: 'no-local-usage',
    };
  }

  const windows = { fiveHour: reading.fiveHour !== null, sevenDay: reading.sevenDay !== null };
  if (!windows.fiveHour && !windows.sevenDay) {
    return { posted: false, status: null, accepted: null, windows, reason: 'no-windows' };
  }

  const response = await deps.post(config.endpoint, token, buildStatuslinePayload(reading));
  const accepted = readAccepted(response.body);

  return {
    posted: response.status >= 200 && response.status < 300,
    status: response.status,
    accepted,
    windows,
    reason: response.status >= 200 && response.status < 300 ? null : `http-${response.status}`,
  };
}

/**
 * Renders a usage reading in Claude Code's own status-line shape.
 *
 * Deliberately the same wire format as a real render rather than a second ingestion
 * contract: the server keeps one parser, and a payload from here is indistinguishable
 * from one the status line would have sent. Only the windows are filled — there is no
 * session, model or cost to report when nothing rendered.
 */
export function buildStatuslinePayload(reading: UsageReading): string {
  const rateLimits: Record<string, unknown> = {};
  if (reading.fiveHour) rateLimits['five_hour'] = window(reading.fiveHour);
  if (reading.sevenDay) rateLimits['seven_day'] = window(reading.sevenDay);
  return JSON.stringify({ rate_limits: rateLimits });
}

function window(value: UsageWindow): Record<string, unknown> {
  return { used_percentage: value.usedPercentage, resets_at: value.resetsAt };
}

/** The endpoint answers 202 with `accepted: false` for a payload it cannot use. */
function readAccepted(body: string): boolean | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object') return null;
    const accepted = (parsed as Record<string, unknown>)['accepted'];
    return typeof accepted === 'boolean' ? accepted : null;
  } catch {
    return null;
  }
}

export function defaultPushDeps(): PushDeps {
  return {
    async readUsage(): Promise<UsageReading | null> {
      // Imported lazily so `run` — which Claude Code invokes on every render — never
      // pays to load the CLI service it does not use.
      const { LocalClaudeCliService } = await import('@gca/core');
      return (await new LocalClaudeCliService().readUsage()) ?? null;
    },

    readToken(path: string): string {
      try {
        return readFileSync(path, 'utf8').trim();
      } catch {
        return '';
      }
    },

    async post(endpoint, token, body): Promise<{ status: number; body: string }> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body,
          signal: controller.signal,
        });
        return { status: response.status, body: await response.text() };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** One-line summary for the console. Never includes the token or the endpoint's auth. */
export function describePush(result: PushResult): string {
  if (result.posted && result.accepted !== false) {
    const parts = [
      result.windows.fiveHour ? '5h' : null,
      result.windows.sevenDay ? '7d' : null,
    ].filter(Boolean);
    return `Pushed usage (${parts.join(', ')}).`;
  }
  switch (result.reason) {
    case 'missing-token':
      return 'No bridge token on this machine. Run: pnpm bridge:install';
    case 'no-local-usage':
      return 'No local Claude usage to read yet. Run claude once, then retry.';
    case 'no-windows':
      return 'Claude reported no usage windows; nothing to push.';
    case 'http-401':
      return 'Rejected (401). The server has a different bridge token than this machine.';
    case 'http-403':
      return 'Rejected (403). The server refused this source address.';
    default:
      break;
  }
  if (result.accepted === false) return 'The server accepted the request but not the payload.';
  return `Push failed${result.status === null ? '' : ` (HTTP ${result.status})`}.`;
}
