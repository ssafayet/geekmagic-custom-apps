import { useState } from 'react';
import { ApiError } from '../api/client.js';
import { useAlbumPlan, useDeviceAction, useUpdateDevice } from '../api/hooks.js';
import { Banner, Button } from './ui.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import type { AlbumPlan, DeviceDto } from '../api/types.js';

export type DeviceNotice = { tone: 'ok' | 'bad'; text: string };

/**
 * Asks for managed-album consent on a display that shows an album slideshow.
 *
 * Renders nothing once consent is given or when the model does not need it. The plan
 * is fetched first so the dialog names every picture that would be removed.
 */
export function AlbumTakeover({
  device,
  onResult,
}: {
  device: DeviceDto;
  onResult: (notice: DeviceNotice) => void;
}) {
  const albumPlan = useAlbumPlan();
  const action = useDeviceAction(device.id);
  const [pending, setPending] = useState<AlbumPlan | null>(null);

  if (!device.capabilities.requiresAlbumManagement || device.albumManagementConsent) return null;

  const fail = (caught: unknown) =>
    onResult({
      tone: 'bad',
      text: caught instanceof ApiError ? caught.message : String(caught),
    });

  return (
    <>
      <Banner
        tone="warn"
        title="This display needs managed-album setup"
        actions={
          <Button
            variant="primary"
            busy={albumPlan.isPending}
            onClick={async () => {
              try {
                setPending(await albumPlan.mutateAsync({ deviceId: device.id }));
              } catch (caught) {
                fail(caught);
              }
            }}
          >
            Review what will change
          </Button>
        }
      >
        Picture mode on this model is an album slideshow. For a deterministic dashboard the managed
        image has to be the only picture in the album. Your existing pictures are downloaded here
        first and can be restored later.
      </Banner>

      <ConfirmDialog
        open={pending !== null}
        title="Take over the picture album?"
        destructive
        confirmLabel="Back up and take over"
        busy={action.isPending}
        consequence={pending?.consequence ?? ''}
        onCancel={() => setPending(null)}
        onConfirm={async () => {
          const token = pending?.confirmationToken;
          setPending(null);
          try {
            await action.mutateAsync({
              action: 'takeover-album',
              body: { confirmationToken: token },
            });
            onResult({ tone: 'ok', text: 'Album takeover succeeded.' });
          } catch (caught) {
            fail(caught);
          }
        }}
      >
        {pending && pending.filesToDelete.length > 0 && (
          <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
              Will be removed from the device
            </p>
            <ul className="mt-1 grid gap-0.5 text-sm text-[var(--color-ink)]">
              {pending.filesToDelete.map((file) => (
                <li key={file}>· {file}</li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-[var(--color-ink-muted)]">
              {pending.willBackUp
                ? 'Each file is downloaded and checksummed here first. Nothing is deleted unless the backup and the new image both verify.'
                : 'This firmware cannot export album contents, so no backup can be taken.'}
            </p>
          </div>
        )}
      </ConfirmDialog>
    </>
  );
}

/** Writes brightness when the slider is released, not on every step of a drag. */
export function BrightnessSlider({
  device,
  id,
  disabled,
  onResult,
}: {
  device: DeviceDto;
  id: string;
  disabled?: boolean;
  onResult: (notice: DeviceNotice) => void;
}) {
  const update = useUpdateDevice(device.id);
  const [brightness, setBrightness] = useState(device.brightness ?? 50);

  const commit = async () => {
    try {
      await update.mutateAsync({ brightness });
      onResult({ tone: 'ok', text: 'Brightness succeeded.' });
    } catch (caught) {
      onResult({
        tone: 'bad',
        text: caught instanceof ApiError ? caught.message : String(caught),
      });
    }
  };

  return (
    <div className="flex items-center gap-3">
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        disabled={disabled || !device.capabilities.canSetBrightness}
        className="h-2 flex-1 accent-[var(--color-accent)]"
        value={brightness}
        onChange={(event) => setBrightness(Number(event.target.value))}
        onPointerUp={() => void commit()}
        onKeyUp={(event) => {
          if (event.key.startsWith('Arrow')) void commit();
        }}
      />
      <span className="w-10 text-right text-sm tabular-nums text-[var(--color-ink)]">
        {brightness}
      </span>
    </div>
  );
}
