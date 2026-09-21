/** Helpers modules use to produce display-ready strings without knowing about pixels. */

export function upperTrim(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

export function formatPercent(value: number | null, fallback = '—'): string {
  if (value === null || !Number.isFinite(value)) return fallback;
  return `${Math.round(value)}%`;
}

export function formatThousands(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/**
 * Compact token counts for a 240px-wide hero: 1.2M, 847K, 912.
 */
export function formatCompactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${trimZero(value / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${trimZero(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${trimZero(value / 1_000)}K`;
  return String(Math.round(value));
}

function trimZero(value: number): string {
  const rounded = value >= 100 ? value.toFixed(0) : value.toFixed(1);
  return rounded.endsWith('.0') ? rounded.slice(0, -2) : rounded;
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1000) return `$${formatCompactNumber(value)}`;
  if (value >= 10) return `$${value.toFixed(0)}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(value >= 0.01 ? 2 : 3)}`;
}
