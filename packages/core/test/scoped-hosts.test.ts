import { describe, expect, it } from 'vitest';
import { FEED_HOSTS } from '@gca/module-calendar';
import { allowedHostsFor, isHostAllowed } from '../src/scoped-services.js';

describe('isHostAllowed', () => {
  const allowed = ['api.example.com', '*.icloud.com'];

  it('matches exact hosts case-insensitively', () => {
    expect(isHostAllowed(allowed, 'api.example.com')).toBe(true);
    expect(isHostAllowed(allowed, 'API.Example.com')).toBe(true);
    expect(isHostAllowed(allowed, 'www.example.com')).toBe(false);
  });

  it('matches a wildcard against subdomains only', () => {
    expect(isHostAllowed(allowed, 'p52-caldav.icloud.com')).toBe(true);
    expect(isHostAllowed(allowed, 'a.b.icloud.com')).toBe(true);
    // Not the apex, and not a lookalike that merely ends in the same letters.
    expect(isHostAllowed(allowed, 'icloud.com')).toBe(false);
    expect(isHostAllowed(allowed, 'evilicloud.com')).toBe(false);
    expect(isHostAllowed(allowed, 'icloud.com.evil.example')).toBe(false);
  });

  it('gives an exact entry no wildcard meaning', () => {
    expect(isHostAllowed(['example.com'], 'sub.example.com')).toBe(false);
  });
});

describe('network:calendar-feeds', () => {
  it('allows exactly the hosts the calendar module says it supports', () => {
    // The module keeps its own copy to explain refusals; this keeps the two honest.
    expect([...allowedHostsFor(['network:calendar-feeds'])].sort()).toEqual([...FEED_HOSTS].sort());
  });
});
