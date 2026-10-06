import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { ApiError } from '../../api/client.js';
import { useSaveSettings, useSettings } from '../../api/hooks.js';
import { Banner, Card, Field, Spinner4, Switch, inputClass } from '../../components/ui.js';
import { StepFooter, type StepProps } from './shared.js';
import type { CoreSettingsDto } from '../../api/types.js';

type Draft = Pick<
  CoreSettingsDto,
  'displayTimezone' | 'theme' | 'defaultDwellSeconds' | 'discoveryEnabled'
>;

/**
 * The handful of server-wide choices that shape what a display looks like.
 *
 * Write spacing and image quality are left at their defaults here: they protect the
 * hardware and almost nobody needs to change them on day one.
 */
export function PreferencesStep({ go }: StepProps) {
  const settings = useSettings();
  const save = useSaveSettings();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const browserZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const zones = useMemo(() => {
    try {
      return Intl.supportedValuesOf('timeZone');
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    if (!settings.data || draft) return;
    setDraft({
      displayTimezone: settings.data.displayTimezone,
      theme: settings.data.theme,
      defaultDwellSeconds: settings.data.defaultDwellSeconds,
      discoveryEnabled: settings.data.discoveryEnabled,
    });
  }, [settings.data, draft]);

  if (settings.isLoading || (settings.data && !draft)) return <Spinner4 />;
  if (!settings.data || !draft) return <Banner tone="bad">Settings are unavailable.</Banner>;
  const saved = settings.data;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current));

  const changed = (Object.keys(draft) as Array<keyof Draft>).filter(
    (key) => draft[key] !== saved[key],
  );

  const next = async () => {
    setError(null);
    if (changed.length > 0) {
      try {
        await save.mutateAsync(Object.fromEntries(changed.map((key) => [key, draft[key]])));
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : String(caught));
        return;
      }
    }
    go('display');
  };

  return (
    <Card
      title="Preferences"
      description="How screens look and how long each one stays up. You can change any of this later in Settings."
    >
      <div className="grid gap-6">
        <Field
          label="Time zone"
          htmlFor="setup-timezone"
          help="Clocks, calendars and “updated 5 minutes ago” on the display use this zone."
        >
          <div className="flex flex-wrap gap-2">
            <input
              id="setup-timezone"
              list="setup-timezones"
              className={`${inputClass} min-w-0 flex-1`}
              value={draft.displayTimezone}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => set('displayTimezone', event.target.value)}
            />
            {browserZone && browserZone !== draft.displayTimezone && (
              <button
                type="button"
                onClick={() => set('displayTimezone', browserZone)}
                className="rounded-lg border border-[var(--color-line)] px-3 py-2 text-xs text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]"
              >
                Use {browserZone}
              </button>
            )}
          </div>
          <datalist id="setup-timezones">
            {zones.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        </Field>

        <fieldset className="grid gap-1.5">
          <legend className="mb-1.5 text-sm font-medium text-[var(--color-ink)]">Theme</legend>
          <div className="flex flex-wrap gap-2">
            {saved.themes.map((theme) => (
              <label
                key={theme.id}
                className={clsx(
                  'cursor-pointer rounded-lg border px-3 py-2 text-sm transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--color-accent)]',
                  draft.theme === theme.id
                    ? 'border-[var(--color-accent)] bg-[var(--color-surface-2)] text-[var(--color-ink)]'
                    : 'border-[var(--color-line)] text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-2)]',
                )}
              >
                <input
                  type="radio"
                  name="setup-theme"
                  value={theme.id}
                  checked={draft.theme === theme.id}
                  onChange={() => set('theme', theme.id)}
                  className="sr-only"
                />
                {theme.displayName}
              </label>
            ))}
          </div>
          <p className="text-xs text-[var(--color-ink-faint)]">
            Colours for every screen. Previews later in the guide use the theme you pick here.
          </p>
        </fieldset>

        <Field
          label="Show each screen for"
          htmlFor="setup-dwell"
          unit="seconds"
          help="The starting time for each module you add to the rotation. You can set a different time per screen afterwards."
        >
          <input
            id="setup-dwell"
            type="number"
            min={5}
            max={3600}
            className={`${inputClass} w-32`}
            value={draft.defaultDwellSeconds}
            onChange={(event) => set('defaultDwellSeconds', Number(event.target.value))}
          />
        </Field>

        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-[var(--color-ink)]">
              Allow finding displays on my network
            </p>
            <p className="mt-1 text-xs leading-relaxed text-[var(--color-ink-faint)]">
              Lets the next step scan one subnet you choose, once, to find the display&rsquo;s
              address. It never scans in the background.
            </p>
          </div>
          <Switch
            label="Allow finding displays on my network"
            checked={draft.discoveryEnabled}
            onChange={(value) => set('discoveryEnabled', value)}
          />
        </div>

        {error && <Banner tone="bad">{error}</Banner>}
      </div>

      <StepFooter
        onBack={() => go('welcome')}
        onNext={() => void next()}
        nextLabel={changed.length > 0 ? 'Save and continue' : 'Continue'}
        nextBusy={save.isPending}
      />
    </Card>
  );
}
