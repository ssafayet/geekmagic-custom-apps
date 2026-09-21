import type { OrganizationUsageSnapshot } from './usage-api.js';
import type { UsageWindow } from './statusline.js';

export interface ClaudeRateLimitSnapshot {
  source: 'claude-code-statusline';
  capturedAt: string;
  claudeCodeVersion: string | null;
  modelDisplayName: string | null;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  spendLimit: UsageWindow | null;
  sessionCostUsd: number | null;
}

export type ClaudeUsageSnapshot = ClaudeRateLimitSnapshot | OrganizationUsageSnapshot;

export type { UsageWindow };
export type { OrganizationUsageSnapshot };
