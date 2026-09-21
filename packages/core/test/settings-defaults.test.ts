import { describe, expect, it } from 'vitest';
import { settingsWithDefaults } from '../src/runtime-manager.js';
import { ADSB_DEFAULT_SETTINGS } from '@gca/module-adsb-monitor';

/**
 * A settings row is written once and read for the life of the instance. Everything
 * here is about what happens to a key the module only gained afterwards.
 */
describe('settingsWithDefaults', () => {
  it('fills a key the stored row predates', () => {
    const stored = { locationLabel: 'Home', searchRadiusNm: 25 };
    const merged = settingsWithDefaults(
      { locationLabel: 'x', searchRadiusNm: 1, newFlag: true },
      stored,
    );

    expect(merged).toMatchObject({ locationLabel: 'Home', searchRadiusNm: 25, newFlag: true });
  });

  it('never lets a default overwrite a stored choice', () => {
    const merged = settingsWithDefaults(
      { accent: 'cyan', airborneOnly: true },
      { accent: 'amber' },
    );
    expect(merged).toMatchObject({ accent: 'amber', airborneOnly: true });
  });

  it('keeps an explicit falsy value rather than treating it as absent', () => {
    // The whole bug this guards against is a flag reading as undefined, so a stored
    // `false` must survive and not be replaced by a `true` default.
    const merged = settingsWithDefaults({ routeLookup: true }, { routeLookup: false });
    expect(merged).toMatchObject({ routeLookup: false });
  });

  it('gives an ADS-B row written before route lookup existed the new default', () => {
    // Exactly the shape found in the running deployment: a valid settings row from
    // before the setting was added. Without the merge, enrichment silently never ran.
    const legacy = {
      provider: 'adsb-fi',
      locationLabel: 'Home',
      latitude: 51.470020,
      longitude: -0.454295,
      searchRadiusNm: 25,
      airborneOnly: true,
      units: 'aviation',
      accent: 'cyan',
    };

    const merged = settingsWithDefaults(ADSB_DEFAULT_SETTINGS, legacy) as Record<string, unknown>;

    expect(merged['routeLookup']).toBe(ADSB_DEFAULT_SETTINGS.routeLookup);
    expect(merged['routeLookup']).toBe(true);
    expect(merged['latitude']).toBe(51.470020);
  });

  it('tolerates a row that is not an object at all', () => {
    expect(settingsWithDefaults({ a: 1 }, null)).toEqual({ a: 1 });
    expect(settingsWithDefaults({ a: 1 }, 'nonsense')).toEqual({ a: 1 });
    expect(settingsWithDefaults({ a: 1 }, [])).toEqual({ a: 1 });
    expect(settingsWithDefaults(null, { a: 1 })).toEqual({ a: 1 });
  });
});
