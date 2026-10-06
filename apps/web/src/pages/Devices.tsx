import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api/client.js';
import {
  useBackups,
  useDeleteDevice,
  useDeviceAction,
  useDevices,
  useProbeDevice,
  useRestorePlan,
  useUpdateDevice,
} from '../api/hooks.js';
import {
  Banner,
  Button,
  Card,
  EmptyState,
  Field,
  HealthBadge,
  Kv,
  Spinner4,
  inputClass,
} from '../components/ui.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { AlbumTakeover, BrightnessSlider } from '../components/DeviceControls.js';
import { Preview } from '../components/Preview.js';
import { AddDeviceForm } from './AddDeviceForm.js';
import { formatBytes, profileLabel, relativeTime } from '../format.js';
import type { DeviceDto } from '../api/types.js';

export function DevicesPage() {
  const devices = useDevices();
  const { deviceId } = useParams<{ deviceId: string }>();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);

  if (devices.isLoading) return <Spinner4 />;

  const list = devices.data ?? [];
  const selected = deviceId ? list.find((device) => device.id === deviceId) : list[0];

  return (
    <div className="grid gap-5">
      <Card
        title="Displays"
        description="Detection is read-only. Nothing is written to a display until you ask for it."
        actions={
          <Button variant="primary" onClick={() => setAdding((value) => !value)}>
            {adding ? 'Close' : 'Add a display'}
          </Button>
        }
      >
        {adding && (
          <div className="mb-4">
            <AddDeviceForm
              onAdded={(device) => {
                setAdding(false);
                navigate(`/devices/${device.id}`);
              }}
            />
          </div>
        )}

        {list.length === 0 ? (
          <EmptyState title="No displays configured">
            Add one by IP address or hostname. Discovery is optional and only scans a subnet you
            pick.
          </EmptyState>
        ) : (
          <ul className="grid gap-2">
            {list.map((device) => (
              <li key={device.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/devices/${device.id}`)}
                  aria-current={selected?.id === device.id ? 'true' : undefined}
                  className={`w-full rounded-lg border p-3 text-left transition-colors ${
                    selected?.id === device.id
                      ? 'border-[var(--color-accent)] bg-[var(--color-surface-2)]'
                      : 'border-[var(--color-line)] bg-[var(--color-surface-2)] hover:bg-[var(--color-surface-3)]'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-[var(--color-ink)]">
                      {device.name}
                    </span>
                    <HealthBadge
                      status={device.health}
                      label={device.online ? undefined : 'Offline'}
                    />
                  </div>
                  <p className="mt-0.5 text-xs text-[var(--color-ink-faint)]">
                    {device.host} · {profileLabel(device.profileId)}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {selected && <DeviceDetail key={selected.id} device={selected} />}
    </div>
  );
}

function DeviceDetail({ device }: { device: DeviceDto }) {
  const navigate = useNavigate();
  const update = useUpdateDevice(device.id);
  const action = useDeviceAction(device.id);
  const remove = useDeleteDevice();
  const backups = useBackups(device.id);
  const restorePlan = useRestorePlan();

  const [name, setName] = useState(device.name);
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn' | 'bad'; text: string } | null>(
    null,
  );
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<
    (Awaited<ReturnType<typeof restorePlan.mutateAsync>> & { backupId: string }) | null
  >(null);

  const unsupported = device.profileId === 'unknown' || device.profileId === 'weather-clock-legacy';
  const needsConsent =
    device.capabilities.requiresAlbumManagement && !device.albumManagementConsent;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setMessage(null);
    try {
      await fn();
      setMessage({ tone: 'ok', text: `${label} succeeded.` });
    } catch (error) {
      const text = error instanceof ApiError ? error.message : String(error);
      setMessage({ tone: 'bad', text });
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto]">
      <div className="grid gap-5">
        {unsupported && (
          <Banner tone="warn" title="This firmware is not writable">
            {device.profileId === 'unknown'
              ? 'The device responded but did not match a known firmware profile, so all write actions are disabled. Export a probe report from Diagnostics to help add support.'
              : 'This legacy firmware is recognised for diagnostics only. Version 1 performs no writes to it.'}
          </Banner>
        )}

        <AlbumTakeover device={device} onResult={setMessage} />

        {message && (
          <Banner tone={message.tone === 'ok' ? 'ok' : message.tone}>{message.text}</Banner>
        )}

        <Card
          title="Device"
          actions={
            <>
              <Button
                busy={action.isPending}
                onClick={() => run('Probe', () => action.mutateAsync({ action: 'probe' }))}
              >
                Re-probe
              </Button>
              <Button
                disabled={unsupported || needsConsent}
                busy={action.isPending}
                onClick={() =>
                  run('Test frame', () => action.mutateAsync({ action: 'test-frame' }))
                }
              >
                Send test frame
              </Button>
              <Button
                disabled={unsupported || needsConsent}
                onClick={() => run('Render', () => action.mutateAsync({ action: 'render-now' }))}
              >
                Render now
              </Button>
            </>
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="device-name">
              <div className="flex gap-2">
                <input
                  id="device-name"
                  className={inputClass}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
                <Button
                  disabled={name === device.name}
                  busy={update.isPending}
                  onClick={() => run('Rename', () => update.mutateAsync({ name }))}
                >
                  Save
                </Button>
              </div>
            </Field>

            <Field
              label="Brightness"
              htmlFor="device-brightness"
              help={
                device.capabilities.canSetBrightness
                  ? undefined
                  : 'This firmware does not expose brightness.'
              }
            >
              <BrightnessSlider
                device={device}
                id="device-brightness"
                disabled={unsupported}
                onResult={setMessage}
              />
            </Field>
          </div>

          <dl className="mt-4 grid gap-x-8 sm:grid-cols-2">
            <Kv label="Host" value={device.host} />
            <Kv label="Profile" value={profileLabel(device.profileId)} />
            <Kv label="Model" value={device.modelName ?? '—'} />
            <Kv label="Firmware" value={device.firmwareVersion ?? '—'} />
            <Kv label="Last seen" value={relativeTime(device.lastSeenAt)} />
            <Kv label="Last upload" value={relativeTime(device.lastUploadAt)} />
            <Kv
              label="Managed album"
              value={device.albumManagementConsent ? 'Enabled' : 'Not enabled'}
              tone={device.albumManagementConsent ? 'good' : 'neutral'}
            />
            <Kv label="Minimum write interval" value={`${device.minimumUploadIntervalSeconds}s`} />
          </dl>

          {device.lastErrorMessage && (
            <div className="mt-3">
              <Banner tone="bad" title={device.lastErrorCode ?? 'Error'}>
                {device.lastErrorMessage}
              </Banner>
            </div>
          )}
        </Card>

        <Card title="Capabilities">
          <ul className="grid gap-1 text-sm sm:grid-cols-2">
            {[
              ['Upload images', device.capabilities.canUploadImage],
              ['Set brightness', device.capabilities.canSetBrightness],
              ['List files', device.capabilities.canListFiles],
              ['Delete files', device.capabilities.canDeleteFiles],
              ['Read state', device.capabilities.canReadState],
              ['Back up content', device.capabilities.supportsBackup],
            ].map(([label, enabled]) => (
              <li key={String(label)} className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={enabled ? 'text-[var(--color-ok)]' : 'text-[var(--color-ink-faint)]'}
                >
                  {enabled ? '✓' : '—'}
                </span>
                <span
                  className={enabled ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-faint)]'}
                >
                  {String(label)}
                </span>
              </li>
            ))}
          </ul>
          {device.capabilities.notes.length > 0 && (
            <ul className="mt-3 grid gap-1 text-xs text-[var(--color-ink-muted)]">
              {device.capabilities.notes.map((note) => (
                <li key={note}>· {note}</li>
              ))}
            </ul>
          )}
        </Card>

        {device.capabilities.supportsBackup && (
          <Card
            title="Backups"
            description="Album contents downloaded before this app took the display over."
          >
            {(backups.data ?? []).length === 0 ? (
              <p className="text-sm text-[var(--color-ink-muted)]">No backups yet.</p>
            ) : (
              <ul className="grid gap-2">
                {(backups.data ?? []).map((backup) => (
                  <li
                    key={backup.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] p-3"
                  >
                    <div>
                      <p className="text-sm text-[var(--color-ink)]">
                        {backup.fileCount} file{backup.fileCount === 1 ? '' : 's'} ·{' '}
                        {formatBytes(backup.totalBytes)}
                        {backup.status === 'partial' && (
                          <span className="ml-2 text-xs text-[var(--color-warn)]">partial</span>
                        )}
                      </p>
                      <p className="text-xs text-[var(--color-ink-faint)]">
                        {relativeTime(backup.createdAt)} ·{' '}
                        {backup.files.map((file) => file.filename).join(', ')}
                      </p>
                    </div>
                    <Button
                      busy={restorePlan.isPending}
                      onClick={() =>
                        run('Fetching the restore plan', async () => {
                          const plan = await restorePlan.mutateAsync({
                            deviceId: device.id,
                            backupId: backup.id,
                          });
                          setPendingRestore({ ...plan, backupId: backup.id });
                        })
                      }
                    >
                      Restore
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        <Card title="Remove">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-[var(--color-ink-muted)]">
              Removes this display and its playlist. Backups stay on disk.
            </p>
            <Button variant="danger" onClick={() => setConfirmRemove(true)}>
              Remove display
            </Button>
          </div>
        </Card>
      </div>

      <Card title="Preview" className="lg:w-[320px]">
        <Preview
          path={`/devices/${device.id}/preview`}
          label={`Current frame on ${device.name}`}
          size={240}
          refreshMs={8_000}
        />
        <p className="mt-2 text-xs text-[var(--color-ink-faint)]">
          What this display should be showing right now.
        </p>
      </Card>

      <ConfirmDialog
        open={confirmRemove}
        title={`Remove ${device.name}?`}
        destructive
        confirmLabel="Remove display"
        busy={remove.isPending}
        consequence={
          <>
            This deletes the display at <strong>{device.host}</strong> and its display order. Any
            backups of its album stay on disk and are not deleted.
          </>
        }
        onCancel={() => setConfirmRemove(false)}
        onConfirm={async () => {
          await remove.mutateAsync({ id: device.id });
          setConfirmRemove(false);
          navigate('/devices');
        }}
      />

      <ConfirmDialog
        open={pendingRestore !== null}
        title="Restore your pictures?"
        confirmLabel="Restore"
        busy={action.isPending}
        consequence={pendingRestore?.consequence ?? ''}
        onCancel={() => setPendingRestore(null)}
        onConfirm={async () => {
          const pending = pendingRestore;
          setPendingRestore(null);
          if (!pending) return;
          await run('Restore', () =>
            action.mutateAsync({
              action: `restore/${pending.backupId}`,
              body: { confirmationToken: pending.confirmationToken },
            }),
          );
        }}
      />
    </div>
  );
}
