import { AppError } from '@gca/shared';

interface FeedProvider {
  name: string;
  /** Exact hosts, or `*.domain` for any subdomain of it. Mirrors the core allowlist. */
  hosts: readonly string[];
}

/**
 * Services whose secret iCal links this module may fetch.
 *
 * The host's `network:calendar-feeds` permission holds the same list and is what
 * actually enforces it; this copy exists so a refused link gets a sentence naming the
 * supported services rather than a bare "not permitted".
 */
export const FEED_PROVIDERS: readonly FeedProvider[] = [
  { name: 'Google Calendar', hosts: ['calendar.google.com'] },
  {
    name: 'Outlook',
    hosts: ['outlook.office365.com', 'outlook.office.com', 'outlook.live.com'],
  },
  { name: 'iCloud', hosts: ['*.icloud.com'] },
  { name: 'Fastmail', hosts: ['user.fm'] },
  { name: 'Proton Calendar', hosts: ['calendar.proton.me'] },
];

export const FEED_HOSTS: readonly string[] = FEED_PROVIDERS.flatMap((provider) => provider.hosts);

function hostMatches(entry: string, host: string): boolean {
  if (!entry.startsWith('*.')) return entry === host;
  const suffix = entry.slice(1);
  return host.endsWith(suffix) && host.length > suffix.length;
}

export function providerForHost(hostname: string): string | null {
  const host = hostname.toLowerCase();
  return (
    FEED_PROVIDERS.find((provider) => provider.hosts.some((entry) => hostMatches(entry, host)))
      ?.name ?? null
  );
}

/**
 * Turns what the user pasted into a fetchable HTTPS URL, or explains why not.
 *
 * `webcal://` is what most "subscribe" buttons hand out; it is plain HTTPS underneath.
 * Plain `http://` is refused rather than upgraded: a provider that offers it is not one
 * of the supported ones, and a secret sent in the clear is not a secret.
 */
export function normaliseFeedUrl(raw: string): { url: string; provider: string } {
  const trimmed = raw.trim();
  const candidate = trimmed.replace(/^webcals?:\/\//i, 'https://');

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new AppError(
      'CALENDAR_FEED_UNSUPPORTED',
      'That does not look like a link. Paste the full iCal address, starting https:// or webcal://.',
    );
  }
  if (parsed.protocol !== 'https:') {
    throw new AppError(
      'CALENDAR_FEED_UNSUPPORTED',
      'The calendar link must use https:// or webcal://.',
    );
  }

  const provider = providerForHost(parsed.hostname);
  if (!provider) {
    throw new AppError(
      'CALENDAR_FEED_UNSUPPORTED',
      `Links from ${parsed.hostname} are not supported. Use a secret iCal link from ${supportedList()}.`,
    );
  }
  return { url: parsed.toString(), provider };
}

function supportedList(): string {
  const names = FEED_PROVIDERS.map((provider) => provider.name);
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}
