import { useEffect, useState } from 'react';
import { ApiError } from '../api/client.js';
import {
  useAuthState,
  useChangePassword,
  useHealth,
  useSaveSettings,
  useSettings,
} from '../api/hooks.js';
import { Banner, Button, Card, Field, Kv, Spinner4, Switch, inputClass } from '../components/ui.js';
import { absoluteTime } from '../format.js';
import type { CoreSettingsDto } from '../api/types.js';

export function SettingsPage() {
  const settings = useSettings();
  const health = useHealth();
  const auth = useAuthState();
  const save = useSaveSettings();

  const [draft, setDraft] = useState<Partial<CoreSettingsDto>>({});
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  useEffect(() => {
    if (settings.data) setDraft(settings.data);
  }, [settings.data]);

  if (settings.isLoading) return <Spinner4 />;
  const data = settings.data;
  if (!data) return <Banner tone="bad">Settings are unavailable.</Banner>;

  const dirty = (Object.keys(draft) as Array<keyof CoreSettingsDto>).some(
    (key) => draft[key] !== data[key],
  );

  const persist = async () => {
    setNotice(null);
    try {
      await save.mutateAsync(draft);
      setNotice({ tone: 'ok', text: 'Settings saved.' });
    } catch (caught) {
      setNotice({
        tone: 'bad',
        text: caught instanceof ApiError ? caught.message : String(caught),
      });
    }
  };

  return (
    <div className="grid gap-5">
      <Card
        title="Display"
        actions={
          <Button
            variant="primary"
            disabled={!dirty}
            busy={save.isPending}
            onClick={() => void persist()}
          >
            Save
          </Button>
        }
      >
        {notice && (
          <div className="mb-4">
            <Banner tone={notice.tone === 'ok' ? 'ok' : 'bad'}>{notice.text}</Banner>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Theme" htmlFor="theme">
            <select
              id="theme"
              className={inputClass}
              value={draft.theme ?? data.theme}
              onChange={(event) =>
                setDraft((current: Partial<CoreSettingsDto>) => ({
                  ...current,
                  theme: event.target.value,
                }))
              }
            >
              {data.themes.map((theme) => (
                <option key={theme.id} value={theme.id}>
                  {theme.displayName}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Time zone"
            htmlFor="timezone"
            help="Used for relative times rendered on the display."
          >
            <input
              id="timezone"
              className={inputClass}
              value={draft.displayTimezone ?? data.displayTimezone}
              onChange={(event) =>
                setDraft((current: Partial<CoreSettingsDto>) => ({
                  ...current,
                  displayTimezone: event.target.value,
                }))
              }
            />
          </Field>

          <Field
            label="Default dwell time"
            htmlFor="dwell"
            unit="seconds"
            help="Applied to newly added display-order entries."
          >
            <input
              id="dwell"
              type="number"
              min={5}
              max={3600}
              className={inputClass}
              value={draft.defaultDwellSeconds ?? data.defaultDwellSeconds}
              onChange={(event) =>
                setDraft((current: Partial<CoreSettingsDto>) => ({
                  ...current,
                  defaultDwellSeconds: Number(event.target.value),
                }))
              }
            />
          </Field>

          <Field
            label="Minimum write interval"
            htmlFor="interval"
            unit="seconds"
            help="Protects device flash. Identical frames are never re-sent regardless of this value."
          >
            <input
              id="interval"
              type="number"
              min={5}
              max={3600}
              className={inputClass}
              value={draft.minimumUploadIntervalSeconds ?? data.minimumUploadIntervalSeconds}
              onChange={(event) =>
                setDraft((current: Partial<CoreSettingsDto>) => ({
                  ...current,
                  minimumUploadIntervalSeconds: Number(event.target.value),
                }))
              }
            />
          </Field>

          <Field
            label="JPEG quality"
            htmlFor="quality"
            help="86 to 90. The default of 88 suits these panels."
          >
            <input
              id="quality"
              type="number"
              min={86}
              max={90}
              className={inputClass}
              value={draft.jpegQuality ?? data.jpegQuality}
              onChange={(event) =>
                setDraft((current: Partial<CoreSettingsDto>) => ({
                  ...current,
                  jpegQuality: Number(event.target.value),
                }))
              }
            />
          </Field>

          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-[var(--color-ink)]">Allow network discovery</p>
              <p className="mt-1 text-xs text-[var(--color-ink-faint)]">
                Lets you scan one subnet you choose. Never runs in the background.
              </p>
            </div>
            <Switch
              label="Allow network discovery"
              checked={draft.discoveryEnabled ?? data.discoveryEnabled}
              onChange={(value) =>
                setDraft((current: Partial<CoreSettingsDto>) => ({
                  ...current,
                  discoveryEnabled: value,
                }))
              }
            />
          </div>
        </div>
      </Card>

      <Card title="Privacy and security">
        <ul className="grid gap-2 text-sm text-[var(--color-ink-muted)]">
          <li>· No analytics or telemetry is collected, and no cloud account is required.</li>
          <li>
            · Credentials are encrypted at rest and never returned to this page after you save them.
          </li>
          <li>· ADS-B coordinates are rounded before they reach any log file.</li>
          <li>
            · Device requests are restricted to private network addresses and never follow
            redirects.
          </li>
          <li>
            · The server binds to 127.0.0.1 unless you change GCA_HOST; LAN exposure requires a
            password, and it only answers to hostnames on your own network.
          </li>
        </ul>
      </Card>

      {auth.data?.required && auth.data.configured && <ChangePasswordCard />}

      <Card title="Server">
        <dl className="grid gap-x-8 sm:grid-cols-2">
          <Kv label="Version" value={health.data?.version ?? '—'} />
          <Kv label="Started" value={absoluteTime(health.data?.startedAt)} />
          <Kv
            label="Modules loaded"
            value={(health.data?.modules.loaded ?? []).join(', ') || '—'}
          />
          <Kv
            label="Bridge token"
            value={health.data?.bridge.tokenConfigured ? 'configured' : 'not configured'}
            tone={health.data?.bridge.tokenConfigured ? 'good' : 'warn'}
          />
        </dl>
        {(health.data?.modules.rejected ?? []).length > 0 && (
          <div className="mt-3">
            <Banner tone="bad" title="Some modules failed to load">
              <ul className="grid gap-1">
                {health.data?.modules.rejected.map((entry) => (
                  <li key={entry.id}>
                    <span className="font-mono text-xs">{entry.id}</span>: {entry.reason}
                  </li>
                ))}
              </ul>
            </Banner>
          </div>
        )}
      </Card>
    </div>
  );
}

function ChangePasswordCard() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const change = useChangePassword();

  const submit = async () => {
    setError(null);
    try {
      await change.mutateAsync({ currentPassword, password });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    }
  };

  return (
    <Card
      title="Administrator password"
      description="Changing it signs out every browser, this one included."
    >
      <div className="grid gap-4 sm:max-w-md">
        <Field label="Current password" htmlFor="current-password">
          <input
            id="current-password"
            type="password"
            className={inputClass}
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </Field>
        <Field label="New password" htmlFor="replacement-password" help="At least 12 characters.">
          <input
            id="replacement-password"
            type="password"
            className={inputClass}
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        {error && <Banner tone="bad">{error}</Banner>}
        <div>
          <Button
            variant="primary"
            busy={change.isPending}
            disabled={!currentPassword || password.length < 12}
            onClick={() => void submit()}
          >
            Change password
          </Button>
        </div>
      </div>
    </Card>
  );
}
