import { useState } from 'react';
import clsx from 'clsx';
import { ApiError } from '../../api/client.js';
import { useDeviceAction, useDevices, usePlaylist, useUpdateDevice } from '../../api/hooks.js';
import {
  Banner,
  Button,
  Card,
  Field,
  HealthBadge,
  Spinner4,
  inputClass,
} from '../../components/ui.js';
import { AlbumTakeover, BrightnessSlider } from '../../components/DeviceControls.js';
import { Preview } from '../../components/Preview.js';
import { AddDeviceForm } from '../AddDeviceForm.js';
import { profileLabel } from '../../format.js';
import { StepFooter, type StepProps } from './shared.js';

export function DisplayStep({ deviceId, go }: StepProps) {
  const devices = useDevices();
  const list = devices.data ?? [];
  const [adding, setAdding] = useState(false);

  if (devices.isLoading) return <Spinner4 />;

  return (
    <Card
      title="Add a display"
      description="Enter the address shown on the display's own screen, or let the guide look for it. Detection only reads; nothing is written to the display yet."
    >
      {list.length > 0 && (
        <fieldset className="mb-4 grid gap-2">
          <legend className="mb-2 text-sm font-medium text-[var(--color-ink)]">
            Set up this display
          </legend>
          {list.map((device) => (
            <label
              key={device.id}
              className={clsx(
                'flex cursor-pointer flex-wrap items-center justify-between gap-2 rounded-lg border p-3 transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--color-accent)]',
                device.id === deviceId
                  ? 'border-[var(--color-accent)] bg-[var(--color-surface-2)]'
                  : 'border-[var(--color-line)] bg-[var(--color-surface-2)] hover:bg-[var(--color-surface-3)]',
              )}
            >
              <input
                type="radio"
                name="setup-display"
                className="sr-only"
                checked={device.id === deviceId}
                onChange={() => go('display', { deviceId: device.id })}
              />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-[var(--color-ink)]">
                  {device.name}
                </span>
                <span className="block text-xs text-[var(--color-ink-faint)]">
                  {device.host} · {profileLabel(device.profileId)}
                </span>
              </span>
              <HealthBadge status={device.health} label={device.online ? undefined : 'Offline'} />
            </label>
          ))}
          {!adding && (
            <div>
              <Button variant="ghost" onClick={() => setAdding(true)}>
                + Add another display
              </Button>
            </div>
          )}
        </fieldset>
      )}

      {(list.length === 0 || adding) && (
        <>
          <ol className="mb-4 grid gap-1 text-sm text-[var(--color-ink-muted)]">
            <li>1. Power the display on and connect it to the same Wi-Fi as this computer.</li>
            <li>2. Note the IP address it shows when it starts up, or find it below.</li>
            <li>3. Detect it, check what was found, then add it.</li>
          </ol>
          <AddDeviceForm onAdded={(device) => go('check', { deviceId: device.id })} />
        </>
      )}

      <StepFooter
        onBack={() => go('preferences')}
        onNext={() => go('check')}
        nextDisabled={list.length === 0}
        skip={
          list.length === 0 ? { label: 'Add one later', onClick: () => go('modules') } : undefined
        }
      />
    </Card>
  );
}

export function CheckStep({ deviceId, go }: StepProps) {
  const devices = useDevices();
  const device = devices.data?.find((candidate) => candidate.id === deviceId);
  const action = useDeviceAction(deviceId ?? '');
  const update = useUpdateDevice(deviceId ?? '');
  const playlist = usePlaylist(deviceId ?? undefined);
  const [name, setName] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'bad'; text: string } | null>(null);

  if (devices.isLoading) return <Spinner4 />;
  if (!device) {
    return (
      <Card title="Check the display">
        <Banner tone="warn">Add a display first, then come back to check it.</Banner>
        <StepFooter onBack={() => go('display')} onNext={() => go('modules')} />
      </Card>
    );
  }

  const unsupported = device.profileId === 'unknown' || device.profileId === 'weather-clock-legacy';
  const needsConsent =
    device.capabilities.requiresAlbumManagement && !device.albumManagementConsent;
  const draftName = name ?? device.name;
  const rotating = (playlist.data ?? []).filter((item) => item.enabled).length;

  const sendTestFrame = async () => {
    setNotice(null);
    try {
      const response = (await action.mutateAsync({ action: 'test-frame' })) as {
        warning?: string | null;
      };
      setNotice(
        response.warning
          ? { tone: 'warn', text: response.warning }
          : { tone: 'ok', text: 'Test frame delivered. Is it on the display?' },
      );
    } catch (caught) {
      setNotice({
        tone: 'bad',
        text: caught instanceof ApiError ? caught.message : String(caught),
      });
    }
  };

  return (
    <Card
      title="Check the display"
      description="Name it, set the brightness, and confirm it shows what this app sends."
    >
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="grid content-start gap-5">
          {unsupported && (
            <Banner tone="warn" title="This firmware is not writable">
              The display answered but cannot receive images from this app. Export a probe report
              from Diagnostics to help add support, or go back and add a different display.
            </Banner>
          )}

          <AlbumTakeover device={device} onResult={setNotice} />

          <Field
            label="Name"
            htmlFor="setup-device-name"
            help="Shown in lists when you have more than one display."
          >
            <div className="flex gap-2">
              <input
                id="setup-device-name"
                className={inputClass}
                value={draftName}
                onChange={(event) => setName(event.target.value)}
              />
              <Button
                disabled={!draftName.trim() || draftName === device.name}
                busy={update.isPending}
                onClick={async () => {
                  try {
                    await update.mutateAsync({ name: draftName.trim() });
                    setName(null);
                  } catch (caught) {
                    setNotice({
                      tone: 'bad',
                      text: caught instanceof ApiError ? caught.message : String(caught),
                    });
                  }
                }}
              >
                Rename
              </Button>
            </div>
          </Field>

          <Field
            label="Brightness"
            htmlFor="setup-device-brightness"
            help={
              device.capabilities.canSetBrightness
                ? 'Applied as soon as you let go of the slider.'
                : 'This firmware does not expose brightness.'
            }
          >
            <BrightnessSlider
              device={device}
              id="setup-device-brightness"
              disabled={unsupported}
              onResult={(result) => {
                // A successful slide speaks for itself on the display.
                if (result.tone === 'bad') setNotice(result);
              }}
            />
          </Field>

          <div className="grid gap-3">
            <p className="text-sm text-[var(--color-ink-muted)]">
              {needsConsent
                ? 'Once the album is set up, send a test frame to confirm the display shows it.'
                : 'Send a test frame, then look at the display: a test picture should appear within a few seconds.'}
            </p>
            <div>
              <Button
                variant="primary"
                disabled={unsupported || needsConsent}
                busy={action.isPending}
                onClick={() => void sendTestFrame()}
              >
                Send test frame
              </Button>
            </div>
            {notice && <Banner tone={notice.tone}>{notice.text}</Banner>}
            {device.profileId === 'stock-pro' && (
              <Banner tone="info" title="One step on the display itself">
                On a SmallTV-PRO, open the Picture app once using the device&rsquo;s own buttons and
                confirm the dashboard appears. That cannot be done reliably over the network.
              </Banner>
            )}
          </div>
        </div>

        <div className="grid content-start justify-items-center gap-2">
          <Preview
            path={`/devices/${device.id}/preview`}
            label={`What ${device.name} should show`}
            size={200}
            refreshMs={6_000}
          />
          <p className="max-w-[200px] text-center text-xs text-[var(--color-ink-faint)]">
            {rotating > 0
              ? 'What the display should show'
              : 'Your screens appear here once you add modules.'}
          </p>
        </div>
      </div>

      <StepFooter onBack={() => go('display')} onNext={() => go('modules')} />
    </Card>
  );
}
