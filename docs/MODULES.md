# Writing a module

A module declares what it needs and what it shows. The management UI generates the
rest — form, validation, secret handling, action buttons, previews — from that
declaration. There is no module-specific code anywhere in the UI or the API layer.

## The contract

```ts
import type { AppModule } from '@gca/module-sdk';

export const weatherModule: AppModule<WeatherSettings, WeatherSnapshot> = {
  manifest, // identity, views, actions, permissions, refresh bounds
  settingsSchema, // JSON Schema 2020-12; validated by Ajv, fills defaults
  uiSchema, // sections, field order, widgets, help text
  defaultSettings,
  secretKeys: [], // vault keys; these never appear in settings_json
  validateSettings, // cross-field rules a schema cannot express
  migrateSettings, // version N -> N+1
  createRuntime, // the working part
};
```

Register it in `packages/core/src/registry.ts`:

```ts
export const builtInModules = [claudeUsageModule, adsbMonitorModule, weatherModule];
```

The registry validates every manifest at startup. A malformed module is rejected
individually and named on the Settings page; it never stops the server.

## Manifest

```ts
const manifest: ModuleManifest = {
  id: 'weather', // lowercase kebab-case, stable forever
  version: '1.0.0',
  settingsVersion: 1, // bump when settings shape changes
  displayName: 'Weather',
  description: 'Shown to the user in the catalog.',
  icon: 'gauge', // a built-in icon id; modules cannot supply paths
  category: 'monitoring',
  singleton: false, // true prevents a second instance
  refresh: { defaultSeconds: 300, minimumSeconds: 60, maximumSeconds: 3600 },
  permissions: ['network:example'],
  views: [
    { id: 'current', displayName: 'Current conditions', selectable: true },
    { id: 'alert', displayName: 'Severe alert', selectable: false }, // interrupt only
  ],
  actions: [{ id: 'weather.test', displayName: 'Test', confirmation: 'none', timeoutMs: 10_000 }],
};
```

`selectable: false` keeps a view out of playlists: the module raises it as an
interruption instead.

## Permissions

Permissions are enforced, not advisory. A module receives an HTTP client that can
reach only the hosts its permissions allow, and host services only when declared.

| Permission                   | Grants                                            |
| ---------------------------- | ------------------------------------------------- |
| `network:anthropic`          | HTTPS to `api.anthropic.com`                      |
| `network:adsb-fi`            | HTTPS to `opendata.adsb.fi`                       |
| `network:opensky`            | HTTPS to `opensky-network.org` and its auth host  |
| `network:adsbdb`             | HTTPS to `api.adsbdb.com`                         |
| `network:open-meteo`         | HTTPS to `api.open-meteo.com` and its AQ host     |
| `network:airgradient`        | HTTPS to `api.airgradient.com`                    |
| `network:calendar-feeds`     | HTTPS to the major calendar providers' iCal hosts |
| `host:claude-cli-status`     | `ctx.host.claudeCli`, `ctx.host.bridgeInbox`      |
| `host:claude-settings-write` | `ctx.host.claudeSettings`                         |
| `secrets:read-own`           | `ctx.secrets` for declared keys                   |
| `location:configured`        | Descriptive; shown in the catalog                 |

An entry written `*.example.com` matches any subdomain of `example.com` and never the
domain itself. It exists for iCloud, which serves calendars from numbered hosts; use it
only where one operator alone controls every subdomain.

A new outbound host means a new permission plus an entry in `PERMISSION_HOSTS`
(`packages/core/src/scoped-services.ts`). That is deliberate: adding a network
destination should be a visible change.

## Settings and the generated form

The JSON Schema drives validation and defaults; the UI schema drives presentation.

```ts
const uiSchema: ModuleUiSchema = {
  sections: [{ id: 'place', title: 'Place', description: 'Sent to the provider.' }],
  fields: {
    latitude: { section: 'place', order: 1, label: 'Coordinates', widget: 'location' },
    longitude: { section: 'place', order: 2 }, // consumed by the location widget
    units: {
      section: 'place',
      order: 3,
      widget: 'select',
      options: [{ value: 'metric', label: 'Metric' }],
      visibleWhen: { field: 'showDetail', equals: [true] },
    },
  },
  sectionActions: { place: ['weather.test', 'core.refreshNow'] },
};
```

Widgets: `text`, `password`, `number`, `switch`, `select`, `slider`, `location`,
`duration`, `textarea`. Omit `widget` and one is inferred from the schema type.

`core.refreshNow` is provided by the host; every module can reference it.

## Secrets

List them in `secretKeys`. They live in the vault, never in `settings_json`, and the
API returns only whether one exists plus its last four characters.

```ts
const apiKey = await ctx.secrets.get('apiKey'); // decrypted for this call only
```

Form semantics, handled for you: an empty field preserves the stored value, and
removal is a separate explicit action.

Cross-field rules see the **post-save** secret state, so a schema can legitimately
require "a credential, or local mode":

```ts
async validateSettings(settings, ctx) {
  const value = { ...defaultSettings, ...(settings as Partial<WeatherSettings>) };
  if (value.source === 'api' && !ctx.secretConfigured('apiKey')) {
    return { ok: false, errors: [{ path: '/apiKey', message: 'API mode needs a key.' }] };
  }
  return { ok: true, value, warnings: [] };
}
```

## Runtime

```ts
class WeatherRuntime implements ModuleRuntime<WeatherSnapshot> {
  async start() {}
  async stop() {}

  async refresh(reason, signal) {
    const response = await this.ctx.http.request(URL, { signal, timeoutMs: 8_000 });
    if (!response.ok) {
      throw new AppError('INTERNAL_ERROR', 'Provider unavailable', { retryable: true });
    }
    this.snapshot = normalize(response.json());
    return this.snapshot;
  }

  getSnapshot() {
    return this.snapshot;
  }
  hydrate(snapshot) {
    /* restore after a restart; tolerate unknown shapes */
  }

  async getFrames(ctx) {
    return [/* frame drafts */];
  }
  async getHealth() {
    return { status: 'healthy' };
  }
  async getStatusPanel() {
    return { title: 'Provider', rows: [] };
  }
  async runAction(actionId, input, signal) {
    /* ... */
  }
}
```

Rules worth following:

- **Honour the signal.** Refreshes are aborted on timeout and shutdown.
- **Throw `AppError` with `retryable`.** It decides whether the scheduler backs off.
- **Never turn absence into zero.** A missing value is `null` and renders as `—`.
- **An empty result is healthy** if the fetch succeeded.
- **Keep snapshots small** — over 128 KiB they are not persisted — and free of secrets.

## Frames

Modules describe content; the renderer owns typography, spacing and encoding.

```ts
{
  id: 'weather-current',
  viewId: 'current',
  title: 'Weather',
  icon: 'gauge',
  accent: 'cyan',
  priority: 'normal',                       // 'attention' interrupts rotation
  badge: { text: 'stale', tone: 'amber' },  // optional corner chip
  layout: { kind: 'hero', value: '12°C', caption: 'Feels like 9°C' },
}
```

Layouts: `hero`, `dual-progress`, `aircraft`, `weather`, `event`, `empty`, `error`. The runtime fills in
`fingerprint` and `validUntil`.

Two constraints the renderer enforces and modules should respect:

- **Never communicate state by colour alone.** Pair a tone with a word or glyph.
- **Text is escaped and measured** before rasterization, so provider strings are safe,
  but shorter strings still read better on a 240 px panel.

`priority: 'urgent'` is reserved for future safety-critical modules. Informational
traffic uses `attention`.

## Actions

Actions give a module buttons without shipping frontend code.

```ts
{ id: 'weather.test', displayName: 'Test', confirmation: 'none', timeoutMs: 10_000 }
```

`confirmation` is `none`, `confirm` or `destructive`; anything other than `none`
requires an explicit confirmation from the client. Set `writes: true` when the action
changes something outside this application, and the confirmation dialog says so.

Return a message, optional data, and an optional panel — all rendered generically:

```ts
return {
  ok: true,
  message: '3 stations within 20 km.',
  panel: { title: 'Test result', rows: [{ label: 'Nearest', value: 'EGLL', tone: 'good' }] },
};
```

Unsaved form values are passed as the action input, so a test acts on what is on
screen rather than what was last saved.

## Migrations

```ts
async migrateSettings(fromVersion, settings) {
  if (fromVersion === 1) {
    const old = settings as { radiusKm: number };
    return { version: 2, settings: { ...old, radiusNm: old.radiusKm * 0.54 } };
  }
  return { version: fromVersion, settings };
}
```

Bump `settingsVersion`, return the next version each call, and the host walks the chain
on load. Returning a version that does not advance ends the walk safely.

## Testing

Everything a module needs is injectable, so no network is required:

- `ctx.http` — hand it a stub `ScopedHttpClient`
- `ctx.now` — inject a fixed clock
- `ctx.secrets`, `ctx.state` — in-memory doubles

See `packages/module-adsb-monitor/test` for provider, normalization and selection
tests, and `packages/renderer/test/fixtures/frames.ts` for adding your states to the
visual regression corpus.
