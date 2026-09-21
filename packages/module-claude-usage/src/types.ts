import type { OrganizationUsageSnapshot } from './usage-api.js';
import type { UsageWindow } from './statusline.js';

/**
 * Where a rate-limit reading came from.
 *
 * `claude-code-statusline` is the bridge: free, but only updates while Claude Code
 * is rendering. `claude-code-cli` is a local `claude -p "/usage"` poll: costs no
 * tokens, works immediately after a restart, but needs the CLI on this machine.
 */
export type ClaudeRateLimitSource = 'claude-code-statusline' | 'claude-code-cli';

export interface ClaudeRateLimitSnapshot {
  source: ClaudeRateLimitSource;
  capturedAt: string;
  claudeCodeVersion: string | null;
  modelDisplayName: string | null;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  spendLimit: UsageWindow | null;
  sessionCostUsd: number | null;
  /**
   * Set when a poll completed but no reading was available yet.
   *
   * Distinguishes "nothing has arrived" from "zero usage", and lets a refresh
   * report that truthfully instead of throwing — a throw would count against the
   * crash backoff every poll, which after a restart is guaranteed.
   */
  pending?: boolean;
}

export type ClaudeUsageSnapshot = ClaudeRateLimitSnapshot | OrganizationUsageSnapshot;

/** True for any source produced by the local machine rather than the org API. */
export function isLocalRateLimitSource(source: unknown): source is ClaudeRateLimitSource {
  return source === 'claude-code-statusline' || source === 'claude-code-cli';
}

/** True for the placeholder a refresh returns when no source had a reading. */
export function isPendingSnapshot(snapshot: ClaudeUsageSnapshot | null): boolean {
  return snapshot !== null && 'pending' in snapshot && snapshot.pending === true;
}

/** Narrows a snapshot to the rate-limit shape the two local sources share. */
export function isRateLimitSnapshot(
  snapshot: ClaudeUsageSnapshot,
): snapshot is ClaudeRateLimitSnapshot {
  return isLocalRateLimitSource(snapshot.source);
}

export type { UsageWindow };
export type { OrganizationUsageSnapshot };
