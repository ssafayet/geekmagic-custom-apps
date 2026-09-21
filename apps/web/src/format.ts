/** Shared display formatting for the management UI. */

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return 'never';
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function absoluteTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const PROFILE_LABELS: Record<string, string> = {
  'stock-ultra': 'SmallTV Ultra (stock)',
  'stock-pro': 'SmallTV-PRO (stock)',
  'sd-pro': 'SmallTV Ultra (SD_PRO firmware)',
  'weather-clock-legacy': 'Legacy weather clock',
  unknown: 'Unrecognised firmware',
};

export function profileLabel(profileId: string): string {
  return PROFILE_LABELS[profileId] ?? profileId;
}

export const PERMISSION_LABELS: Record<string, string> = {
  'network:anthropic': 'Contact api.anthropic.com',
  'network:adsb-fi': 'Contact opendata.adsb.fi',
  'network:opensky': 'Contact opensky-network.org',
  'network:adsbdb': 'Contact api.adsbdb.com',
  'host:claude-cli-status': 'Check the local Claude Code installation',
  'host:claude-settings-write': 'Modify ~/.claude/settings.json',
  'secrets:read-own': 'Read its own stored credentials',
  'location:configured': 'Use the coordinates you configure',
};

export function permissionLabel(permission: string): string {
  return PERMISSION_LABELS[permission] ?? permission;
}
