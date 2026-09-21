import { ageSeconds, formatAge, formatRelativeDuration, secondsUntil } from '@gca/shared';
import {
  formatCompactNumber,
  formatPercent,
  formatUsd,
  type FrameContext,
  type ModuleFrameDraft,
  type ProgressGauge,
  type SemanticColor,
  type SupportingItem,
} from '@gca/module-sdk';
import type { ClaudeUsageSettings } from './settings.js';
import { isRateLimitSnapshot } from './types.js';
import type { ClaudeRateLimitSnapshot, ClaudeUsageSnapshot } from './types.js';
import type { UsageWindow } from './statusline.js';

export const CLAUDE_VIEW_RATE_LIMITS = 'rate-limits';
export const CLAUDE_VIEW_API_COST = 'api-cost';

/** Thresholds from the spec, applied to whichever window is most constrained. */
export function usageTone(percent: number | null, accent: SemanticColor): SemanticColor {
  if (percent === null || !Number.isFinite(percent)) return 'slate';
  if (percent >= 100) return 'red';
  if (percent >= 85) return 'orange';
  if (percent >= 60) return 'amber';
  return accent;
}

export interface ClaudeFrameInput {
  snapshot: ClaudeUsageSnapshot | null;
  settings: ClaudeUsageSettings;
  ctx: FrameContext;
  stale: boolean;
  /** Set when there is nothing to display yet and the user must act. */
  setupState: { headline: string; detail: string; code?: string; waiting: boolean } | null;
}

export function buildClaudeFrames(input: ClaudeFrameInput): ModuleFrameDraft[] {
  const { snapshot, settings, ctx, stale, setupState } = input;
  const accent = settings.accent as SemanticColor;

  if (setupState) {
    return [
      {
        id: setupState.waiting ? 'claude-waiting' : 'claude-setup',
        viewId: CLAUDE_VIEW_RATE_LIMITS,
        title: 'Claude Usage',
        icon: 'sparkle',
        accent,
        priority: 'normal',
        layout: setupState.waiting
          ? {
              kind: 'empty',
              icon: 'clock',
              headline: setupState.headline,
              detail: setupState.detail,
            }
          : {
              kind: 'error',
              severity: 'info',
              headline: setupState.headline,
              detail: setupState.detail,
              ...(setupState.code ? { code: setupState.code } : {}),
            },
      },
    ];
  }

  if (!snapshot) {
    return [
      {
        id: 'claude-empty',
        viewId: CLAUDE_VIEW_RATE_LIMITS,
        title: 'Claude Usage',
        icon: 'sparkle',
        accent,
        priority: 'normal',
        layout: {
          kind: 'empty',
          icon: 'clock',
          headline: 'No data yet',
          detail: 'Waiting for the first update',
        },
      },
    ];
  }

  return isRateLimitSnapshot(snapshot)
    ? [buildRateLimitFrame(snapshot, settings, ctx, stale)]
    : [buildApiCostFrame(snapshot, settings, ctx, stale)];
}

function buildRateLimitFrame(
  snapshot: ClaudeRateLimitSnapshot,
  settings: ClaudeUsageSettings,
  ctx: FrameContext,
  stale: boolean,
): ModuleFrameDraft {
  const accent = settings.accent as SemanticColor;
  const windows: Array<{ label: string; window: UsageWindow | null }> = [
    { label: '5H', window: snapshot.fiveHour },
    { label: '7D', window: snapshot.sevenDay },
  ];
  // The spend limit replaces the 5-hour ring only when it is the binding constraint.
  if (snapshot.spendLimit && snapshot.spendLimit.usedPercentage >= 85 && !snapshot.fiveHour) {
    windows[0] = { label: 'SPEND', window: snapshot.spendLimit };
  }

  const gauges: ProgressGauge[] = windows.map(({ label, window }) => ({
    label,
    percent: window ? window.usedPercentage : null,
    valueText: window ? formatPercent(window.usedPercentage) : '—',
    caption: captionFor(window, settings, ctx.now),
    tone: usageTone(window?.usedPercentage ?? null, accent),
  }));

  const constrained = mostConstrained(snapshot);
  const known = windows.filter((entry) => entry.window !== null);

  const hero =
    constrained === null
      ? { value: '—', caption: 'Usage not reported by Claude Code', tone: 'slate' as SemanticColor }
      : {
          value: formatPercent(constrained.window.usedPercentage),
          caption: heroCaption(constrained, settings, ctx.now),
          tone: usageTone(constrained.window.usedPercentage, accent),
        };

  const footerParts: string[] = [];
  if (snapshot.modelDisplayName) footerParts.push(snapshot.modelDisplayName);
  if (settings.showSessionCost && snapshot.sessionCostUsd !== null) {
    footerParts.push(`session ${formatUsd(snapshot.sessionCostUsd)}`);
  }
  footerParts.push(`${formatAge(ageSeconds(snapshot.capturedAt, ctx.now))} ago`);

  return {
    id: 'claude-rate-limits',
    viewId: CLAUDE_VIEW_RATE_LIMITS,
    title: 'Claude Usage',
    icon: 'sparkle',
    accent,
    priority: 'normal',
    ...(stale ? { badge: { text: 'stale', tone: 'amber' as const } } : {}),
    ...(known.length === 0 && !stale ? { badge: { text: 'no data', tone: 'slate' as const } } : {}),
    layout: { kind: 'dual-progress', hero, gauges, footer: footerParts.join(' · ') },
  };
}

function buildApiCostFrame(
  snapshot: Extract<ClaudeUsageSnapshot, { source: 'anthropic-usage-api' }>,
  settings: ClaudeUsageSettings,
  ctx: FrameContext,
  stale: boolean,
): ModuleFrameDraft {
  const supporting: SupportingItem[] = [
    { label: 'Input', value: formatCompactNumber(snapshot.usage.inputTokens) },
    { label: 'Output', value: formatCompactNumber(snapshot.usage.outputTokens) },
    {
      label: `${snapshot.windowDays}-day cost`,
      value: formatUsd(snapshot.cost.rangeUsd),
    },
  ];

  if (snapshot.usage.cacheReadTokens > 0) {
    supporting[2] = {
      label: 'Cache read',
      value: formatCompactNumber(snapshot.usage.cacheReadTokens),
    };
    supporting.push({
      label: `${snapshot.windowDays}-day cost`,
      value: formatUsd(snapshot.cost.rangeUsd),
    });
  }

  return {
    id: 'claude-api-cost',
    viewId: CLAUDE_VIEW_API_COST,
    title: 'Claude API',
    icon: 'cost',
    accent: 'blue',
    priority: 'normal',
    ...(stale ? { badge: { text: 'stale', tone: 'amber' as const } } : {}),
    layout: {
      kind: 'hero',
      value: formatUsd(snapshot.cost.todayUsd),
      caption: 'Cost today',
      supporting: supporting.slice(0, 3),
      footer: `Organization usage · ${formatAge(ageSeconds(snapshot.capturedAt, ctx.now))} ago`,
    },
  };
}

/** The window closest to its limit is what the viewer actually needs to see. */
export function mostConstrained(
  snapshot: ClaudeRateLimitSnapshot,
): { label: string; window: UsageWindow } | null {
  const candidates: Array<{ label: string; window: UsageWindow }> = [];
  if (snapshot.fiveHour) candidates.push({ label: '5-hour', window: snapshot.fiveHour });
  if (snapshot.sevenDay) candidates.push({ label: '7-day', window: snapshot.sevenDay });
  if (snapshot.spendLimit) candidates.push({ label: 'Spend', window: snapshot.spendLimit });
  if (candidates.length === 0) return null;

  return candidates.reduce((best, candidate) =>
    candidate.window.usedPercentage > best.window.usedPercentage ? candidate : best,
  );
}

function captionFor(
  window: UsageWindow | null,
  settings: ClaudeUsageSettings,
  now: Date,
): string | undefined {
  if (!window) return 'not reported';
  if (!settings.showResetTime) return undefined;
  const seconds = secondsUntil(window.resetsAt, now);
  return seconds <= 0 ? 'resetting' : `in ${formatRelativeDuration(seconds)}`;
}

function heroCaption(
  constrained: { label: string; window: UsageWindow },
  settings: ClaudeUsageSettings,
  now: Date,
): string {
  if (constrained.window.usedPercentage >= 100) {
    const seconds = secondsUntil(constrained.window.resetsAt, now);
    return seconds > 0
      ? `Limit reached · resets in ${formatRelativeDuration(seconds)}`
      : 'Limit reached';
  }
  if (!settings.showResetTime) return `${constrained.label} window`;
  const seconds = secondsUntil(constrained.window.resetsAt, now);
  return seconds > 0
    ? `${constrained.label} window resets in ${formatRelativeDuration(seconds)}`
    : `${constrained.label} window`;
}
