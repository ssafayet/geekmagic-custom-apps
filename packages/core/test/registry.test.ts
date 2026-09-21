import { describe, expect, it } from 'vitest';
import type { AnyAppModule } from '@gca/module-sdk';
import { adsbMonitorModule } from '@gca/module-adsb-monitor';
import { claudeUsageModule } from '@gca/module-claude-usage';
import { builtInModules, ModuleRegistry, validateModule } from '../src/registry.js';
import { SettingsValidator, migrateToCurrent, formatAjvError } from '../src/settings-validator.js';

function sampleModule(overrides: Partial<AnyAppModule> = {}): AnyAppModule {
  return {
    manifest: {
      id: 'sample-module',
      version: '1.0.0',
      settingsVersion: 1,
      displayName: 'Sample',
      description: 'A third module used to prove the registry needs no core changes.',
      icon: 'gauge',
      category: 'other',
      singleton: false,
      refresh: { defaultSeconds: 60, minimumSeconds: 10, maximumSeconds: 600 },
      permissions: [],
      views: [{ id: 'main', displayName: 'Main' }],
      actions: [{ id: 'sample.ping', displayName: 'Ping', confirmation: 'none', timeoutMs: 1000 }],
    },
    settingsSchema: { type: 'object', properties: { label: { type: 'string', default: 'hi' } } },
    uiSchema: {
      sections: [{ id: 'general', title: 'General' }],
      fields: { label: { section: 'general', order: 1 } },
    },
    defaultSettings: { label: 'hi' },
    secretKeys: [],
    async validateSettings(settings) {
      return { ok: true, value: settings };
    },
    async migrateSettings(fromVersion, settings) {
      return { version: fromVersion, settings };
    },
    createRuntime() {
      throw new Error('not used in this test');
    },
    ...overrides,
  } as AnyAppModule;
}

describe('built-in registry', () => {
  it('loads both shipped modules with no rejections', () => {
    const registry = new ModuleRegistry(builtInModules);
    expect(registry.report.loaded).toEqual(['claude-usage', 'adsb-monitor']);
    expect(registry.report.rejected).toEqual([]);
  });

  it('accepts a third module without any core change', () => {
    const registry = new ModuleRegistry([...builtInModules, sampleModule()]);
    expect(registry.report.loaded).toContain('sample-module');
    expect(registry.get('sample-module').manifest.displayName).toBe('Sample');
  });

  it('rejects only the malformed module and keeps the rest running', () => {
    const broken = sampleModule({
      manifest: { ...sampleModule().manifest, id: 'Bad_ID' },
    });
    const registry = new ModuleRegistry([...builtInModules, broken]);

    expect(registry.report.loaded).toEqual(['claude-usage', 'adsb-monitor']);
    expect(registry.report.rejected[0]?.reason).toMatch(/kebab-case/);
  });

  it('rejects duplicate module ids', () => {
    const registry = new ModuleRegistry([claudeUsageModule, claudeUsageModule]);
    expect(registry.report.loaded).toEqual(['claude-usage']);
    expect(registry.report.rejected[0]?.reason).toMatch(/Duplicate/);
  });

  it('throws MODULE_NOT_FOUND for an unregistered id', () => {
    const registry = new ModuleRegistry(builtInModules);
    expect(() => registry.get('nope')).toThrowError(
      expect.objectContaining({ code: 'MODULE_NOT_FOUND' }),
    );
    expect(registry.tryGet('nope')).toBeNull();
  });
});

describe('validateModule', () => {
  it('accepts both shipped modules', () => {
    expect(() => validateModule(claudeUsageModule)).not.toThrow();
    expect(() => validateModule(adsbMonitorModule)).not.toThrow();
  });

  it.each([
    [
      'an inconsistent refresh range',
      { refresh: { defaultSeconds: 5, minimumSeconds: 10, maximumSeconds: 600 } },
      /refresh range/,
    ],
    ['an unknown permission', { permissions: ['network:evil'] }, /unknown permission/],
    ['no views', { views: [] }, /at least one view/],
    [
      'a duplicate view id',
      {
        views: [
          { id: 'a', displayName: 'A' },
          { id: 'a', displayName: 'B' },
        ],
      },
      /duplicate view/,
    ],
    [
      'a zero action timeout',
      { actions: [{ id: 'x', displayName: 'X', confirmation: 'none', timeoutMs: 0 }] },
      /positive timeoutMs/,
    ],
    ['a non-integer settingsVersion', { settingsVersion: 0 }, /settingsVersion/],
  ])('rejects %s', (_label, manifestPatch, pattern) => {
    const broken = sampleModule({
      manifest: { ...sampleModule().manifest, ...(manifestPatch as object) },
    });
    expect(() => validateModule(broken)).toThrow(pattern as RegExp);
  });

  it('rejects a UI field pointing at a section that does not exist', () => {
    const broken = sampleModule({
      uiSchema: {
        sections: [{ id: 'general', title: 'General' }],
        fields: { label: { section: 'missing', order: 1 } },
      },
    });
    expect(() => validateModule(broken)).toThrow(/unknown section/);
  });

  it('rejects a UI field referencing an action that does not exist', () => {
    const broken = sampleModule({
      uiSchema: {
        sections: [{ id: 'general', title: 'General' }],
        fields: { label: { section: 'general', order: 1, actionId: 'nope' } },
      },
    });
    expect(() => validateModule(broken)).toThrow(/unknown action/);
  });

  it('allows the built-in core.refreshNow action reference', () => {
    const module = sampleModule({
      uiSchema: {
        sections: [{ id: 'general', title: 'General' }],
        fields: { label: { section: 'general', order: 1, actionId: 'core.refreshNow' } },
      },
    });
    expect(() => validateModule(module)).not.toThrow();
  });

  it('requires an explicit secretKeys declaration', () => {
    const broken = sampleModule({ secretKeys: undefined as never });
    expect(() => validateModule(broken)).toThrow(/secretKeys/);
  });
});

describe('SettingsValidator', () => {
  const validator = new SettingsValidator();
  const ctx = { instanceId: null, secretConfigured: () => false };

  it('applies schema defaults for omitted fields', async () => {
    const result = await validator.validate(
      adsbMonitorModule,
      { latitude: 51.5, longitude: -0.4 },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({
      searchRadiusNm: 25,
      pollIntervalSeconds: 15,
      units: 'aviation',
    });
  });

  it('reports a readable message for an out-of-range value', async () => {
    const result = await validator.validate(
      adsbMonitorModule,
      { latitude: 120, longitude: 0 },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toEqual({
      path: '/latitude',
      message: 'latitude must be at most 90.',
    });
  });

  it('rejects an unrecognised setting rather than silently dropping it', async () => {
    const result = await validator.validate(
      adsbMonitorModule,
      { latitude: 51, longitude: 0, bogusField: true },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toMatch(/not a recognised setting/);
  });

  it('runs module cross-field rules after the schema passes', async () => {
    const result = await validator.validate(
      adsbMonitorModule,
      { latitude: 51, longitude: 0, overheadEnterRadiusNm: 5, overheadExitRadiusNm: 4 },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toMatch(/exit radius must be larger/);
  });

  it('surfaces warnings without failing validation', async () => {
    const result = await validator.validate(
      adsbMonitorModule,
      { latitude: 51, longitude: 0, pollIntervalSeconds: 2 },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.warnings[0]).toMatch(/rate limit/);
  });

  it('sees the post-update secret state when validating', async () => {
    const withoutSecret = await validator.validate(
      claudeUsageModule,
      { source: 'anthropic-usage-api' },
      ctx,
    );
    expect(withoutSecret.ok).toBe(false);

    const withSecret = await validator.validate(
      claudeUsageModule,
      { source: 'anthropic-usage-api' },
      { instanceId: 'm1', secretConfigured: (key) => key === 'adminApiKey' },
    );
    expect(withSecret.ok).toBe(true);
  });

  it('does not mutate the caller settings object', async () => {
    const input = { latitude: 51, longitude: 0 };
    await validator.validate(adsbMonitorModule, input, ctx);
    expect(Object.keys(input)).toEqual(['latitude', 'longitude']);
  });
});

describe('migrateToCurrent', () => {
  it('is a no-op when already current', async () => {
    const result = await migrateToCurrent(adsbMonitorModule, 1, { latitude: 51 });
    expect(result).toMatchObject({ version: 1, migrated: false });
  });

  it('walks a multi-step migration chain', async () => {
    const module = sampleModule({
      manifest: { ...sampleModule().manifest, settingsVersion: 3 },
      async migrateSettings(fromVersion, settings) {
        const current = settings as Record<string, unknown>;
        return { version: fromVersion + 1, settings: { ...current, [`step${fromVersion}`]: true } };
      },
    });

    const result = await migrateToCurrent(module, 1, { base: true });

    expect(result.version).toBe(3);
    expect(result.settings).toEqual({ base: true, step1: true, step2: true });
    expect(result.migrated).toBe(true);
  });

  it('stops safely when a module refuses to advance the version', async () => {
    const module = sampleModule({
      manifest: { ...sampleModule().manifest, settingsVersion: 5 },
      async migrateSettings(_fromVersion, settings) {
        return { version: 1, settings };
      },
    });

    const result = await migrateToCurrent(module, 1, { a: 1 });
    expect(result.version).toBe(5);
  });
});

describe('formatAjvError', () => {
  it('turns keywords into actionable sentences', () => {
    expect(
      formatAjvError({
        keyword: 'required',
        instancePath: '',
        params: { missingProperty: 'latitude' },
        schemaPath: '',
      } as never),
    ).toMatchObject({ message: 'latitude is required.' });

    expect(
      formatAjvError({
        keyword: 'enum',
        instancePath: '/units',
        params: { allowedValues: ['a', 'b'] },
        schemaPath: '',
      } as never),
    ).toMatchObject({ message: 'units must be one of: a, b.' });
  });
});

describe('ADS-B provider selection', () => {
  const validator = new SettingsValidator();
  const base = { latitude: 51.4706, longitude: -0.4619 };

  it('accepts a fast poll on the community provider', async () => {
    const result = await validator.validate(
      adsbMonitorModule,
      { ...base, provider: 'adsb-fi', pollIntervalSeconds: 15 },
      { instanceId: null, secretConfigured: () => false },
    );
    expect(result.ok).toBe(true);
  });

  it('refuses a poll that would exhaust the anonymous OpenSky budget', async () => {
    // A 5s poll is ~17k requests/day against a ~400/day allowance.
    const result = await validator.validate(
      adsbMonitorModule,
      { ...base, provider: 'opensky', pollIntervalSeconds: 5 },
      { instanceId: null, secretConfigured: () => false },
    );

    expect(result.ok).toBe(false);
    expect(result.errors[0]?.path).toBe('/pollIntervalSeconds');
    expect(result.errors[0]?.message).toMatch(/400 requests a day/);
  });

  it('allows a faster poll once credentials are configured', async () => {
    const ctx = {
      instanceId: 'm1',
      secretConfigured: (key: string) => key === 'openSkyClientId' || key === 'openSkyClientSecret',
    };

    const tooFast = await validator.validate(
      adsbMonitorModule,
      { ...base, provider: 'opensky', pollIntervalSeconds: 5 },
      ctx,
    );
    expect(tooFast.ok).toBe(false);

    const acceptable = await validator.validate(
      adsbMonitorModule,
      { ...base, provider: 'opensky', pollIntervalSeconds: 30 },
      ctx,
    );
    expect(acceptable.ok).toBe(true);
  });

  it('warns that OpenSky carries no registration or aircraft type', async () => {
    const result = await validator.validate(
      adsbMonitorModule,
      { ...base, provider: 'opensky', pollIntervalSeconds: 300 },
      { instanceId: null, secretConfigured: () => false },
    );
    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/registration or aircraft type/i);
  });

  it('declares the hosts both providers need', () => {
    const permissions = adsbMonitorModule.manifest.permissions;
    expect(permissions).toContain('network:adsb-fi');
    expect(permissions).toContain('network:opensky');
    // Credentials are read through the scoped secret service.
    expect(permissions).toContain('secrets:read-own');
    expect(adsbMonitorModule.secretKeys).toEqual(['openSkyClientId', 'openSkyClientSecret']);
  });
});
