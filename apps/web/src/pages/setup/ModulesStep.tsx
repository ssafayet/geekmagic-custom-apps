import { useEffect, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { ApiError } from '../../api/client.js';
import {
  useCreateInstance,
  useDeleteInstance,
  useDevices,
  useModuleDefinitions,
  useModuleInstances,
  usePlaylist,
} from '../../api/hooks.js';
import { Banner, Button, Card, HealthBadge, Spinner4 } from '../../components/ui.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { ModuleSettingsForm, useModuleSettingsDraft } from '../../components/ModuleSettings.js';
import { ModulePreviews } from '../Modules.js';
import { permissionLabel } from '../../format.js';
import { StepFooter, type StepProps } from './shared.js';
import type { ModuleDefinitionDto, ModuleInstanceDto } from '../../api/types.js';

/**
 * Choose what the display shows and set each choice up without leaving the guide.
 *
 * Adding a module also puts it in the display order (the server does that), so the
 * next step starts from a rotation rather than an empty list.
 */
export function ModulesStep({ deviceId, go }: StepProps) {
  const definitions = useModuleDefinitions();
  const instances = useModuleInstances();
  const create = useCreateInstance();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);

  if (definitions.isLoading || instances.isLoading) return <Spinner4 />;

  const catalog = definitions.data ?? [];
  const configured = instances.data ?? [];
  const selected =
    configured.find((instance) => instance.id === selectedId) ?? configured.at(-1) ?? null;
  const selectedDefinition = catalog.find((definition) => definition.id === selected?.moduleId);

  /** Unsaved settings are worth a question before they are thrown away. */
  const leave = (then: () => void) => {
    if (editorDirty) setPendingLeave(() => then);
    else then();
  };

  const add = (definition: ModuleDefinitionDto) =>
    leave(async () => {
      setError(null);
      try {
        const instance = await create.mutateAsync({ moduleId: definition.id });
        setSelectedId(instance.id);
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : String(caught));
      }
    });

  return (
    <div className="grid gap-5">
      <Card
        title="Choose modules"
        description="Each module is one kind of screen. Add as many as you like; each joins the display's rotation straight away."
      >
        {error && (
          <div className="mb-4">
            <Banner tone="bad">{error}</Banner>
          </div>
        )}
        <ul className="grid gap-3 sm:grid-cols-2">
          {catalog.map((definition) => {
            const existing = configured.filter((instance) => instance.moduleId === definition.id);
            const atLimit = definition.singleton && existing.length > 0;
            return (
              <li
                key={definition.id}
                className={clsx(
                  'flex flex-col rounded-lg border p-3',
                  existing.length > 0
                    ? 'border-[#1d4d36] bg-[var(--color-surface-2)]'
                    : 'border-[var(--color-line)] bg-[var(--color-surface-2)]',
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-sm font-semibold text-[var(--color-ink)]">
                    {definition.displayName}
                  </h3>
                  {existing.length > 0 && (
                    <span className="shrink-0 text-xs font-medium text-[var(--color-ok)]">
                      ✓ Added{existing.length > 1 ? ` ×${existing.length}` : ''}
                    </span>
                  )}
                </div>
                <p className="mt-1 flex-1 text-xs leading-relaxed text-[var(--color-ink-muted)]">
                  {definition.description}
                </p>
                {definition.permissions.length > 0 && (
                  <details className="mt-2 text-xs">
                    <summary className="cursor-pointer text-[var(--color-ink-faint)]">
                      What it can access
                    </summary>
                    <ul className="mt-1 grid gap-0.5 text-[var(--color-ink-muted)]">
                      {definition.permissions.map((permission) => (
                        <li key={permission}>· {permissionLabel(permission)}</li>
                      ))}
                    </ul>
                  </details>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  {!atLimit && (
                    <Button
                      variant={existing.length > 0 ? 'secondary' : 'primary'}
                      busy={create.isPending && create.variables?.moduleId === definition.id}
                      disabled={create.isPending}
                      onClick={() => add(definition)}
                    >
                      {existing.length > 0 ? 'Add another' : `Add ${definition.displayName}`}
                    </Button>
                  )}
                  {existing.map((instance) => (
                    <Button
                      key={instance.id}
                      variant="ghost"
                      aria-pressed={selected?.id === instance.id}
                      onClick={() => leave(() => setSelectedId(instance.id))}
                    >
                      {existing.length > 1 ? `Set up ${instance.name}` : 'Set up'}
                    </Button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
        {configured.length === 0 && (
          <StepFooter
            onBack={() => go('check')}
            onNext={() => go('order')}
            nextLabel="Skip for now"
          />
        )}
      </Card>

      {selected && selectedDefinition && (
        <InstanceSetup
          key={selected.id}
          instance={selected}
          definition={selectedDefinition}
          others={configured.filter((instance) => instance.id !== selected.id)}
          deviceId={deviceId}
          onSelect={(id) => leave(() => setSelectedId(id))}
          onDirtyChange={setEditorDirty}
          onRemoved={() => {
            setEditorDirty(false);
            setSelectedId(null);
          }}
          footer={
            <StepFooter
              onBack={() => leave(() => go('check'))}
              onNext={() => leave(() => go('order'))}
            />
          }
        />
      )}

      <ConfirmDialog
        open={pendingLeave !== null}
        title="Discard unsaved settings?"
        confirmLabel="Discard changes"
        destructive
        consequence="The settings you changed for this module have not been saved."
        onCancel={() => setPendingLeave(null)}
        onConfirm={() => {
          const then = pendingLeave;
          setPendingLeave(null);
          setEditorDirty(false);
          then?.();
        }}
      />
    </div>
  );
}

function InstanceSetup({
  instance,
  definition,
  others,
  deviceId,
  onSelect,
  onDirtyChange,
  onRemoved,
  footer,
}: {
  instance: ModuleInstanceDto;
  definition: ModuleDefinitionDto;
  others: ModuleInstanceDto[];
  deviceId: string | null;
  onSelect: (id: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  onRemoved: () => void;
  footer: ReactNode;
}) {
  const form = useModuleSettingsDraft(instance);
  const remove = useDeleteInstance();
  const [previewVersion, setPreviewVersion] = useState(0);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    onDirtyChange(form.dirty);
  }, [form.dirty]);

  return (
    <Card
      title={`Set up ${instance.name}`}
      description="Fill in what the module needs, save, and watch the preview update."
      actions={
        <>
          {form.dirty && (
            <span className="self-center text-xs text-[var(--color-warn)]">Unsaved changes</span>
          )}
          <Button
            variant="primary"
            disabled={!form.dirty}
            busy={form.saving}
            onClick={async () => {
              if (await form.save()) setPreviewVersion((value) => value + 1);
            }}
          >
            Save
          </Button>
        </>
      }
    >
      {others.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-[var(--color-ink-faint)]">
          Also added:
          {others.map((other) => (
            <button
              key={other.id}
              type="button"
              onClick={() => onSelect(other.id)}
              className="rounded-full border border-[var(--color-line)] px-2.5 py-1 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]"
            >
              {other.name}
            </button>
          ))}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <HealthBadge status={instance.healthStatus} />
            <span className="text-sm text-[var(--color-ink-muted)]">
              {instance.healthMessage ?? 'Waiting for its first update.'}
            </span>
          </div>
          <ModuleSettingsForm
            instance={instance}
            definition={definition}
            form={form}
            onActionCompleted={() => setPreviewVersion((value) => value + 1)}
          />
        </div>

        <div className="grid content-start gap-3 lg:w-[240px]">
          <ModulePreviews instance={instance} version={previewVersion} />
          {deviceId && <RotationNote deviceId={deviceId} instanceId={instance.id} />}
          <div>
            <Button variant="ghost" onClick={() => setConfirmRemove(true)}>
              Remove this module
            </Button>
          </div>
        </div>
      </div>

      {/* Long forms push the header's Save out of view, so offer it where editing ends. */}
      {form.dirty && (
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <span className="text-xs text-[var(--color-warn)]">Unsaved changes</span>
          <Button variant="ghost" onClick={form.discard}>
            Discard
          </Button>
          <Button
            variant="primary"
            busy={form.saving}
            onClick={async () => {
              if (await form.save()) setPreviewVersion((value) => value + 1);
            }}
          >
            Save
          </Button>
        </div>
      )}

      {footer}

      <ConfirmDialog
        open={confirmRemove}
        title={`Remove ${instance.name}?`}
        destructive
        confirmLabel="Remove module"
        busy={remove.isPending}
        consequence={
          <>
            This deletes the settings and any stored credentials for{' '}
            <strong>{instance.name}</strong>, and takes it out of the display order.
          </>
        }
        onCancel={() => setConfirmRemove(false)}
        onConfirm={async () => {
          await remove.mutateAsync({ id: instance.id });
          setConfirmRemove(false);
          onRemoved();
        }}
      />
    </Card>
  );
}

/** Confirms the automatic placement, so nobody wonders whether a second step is needed. */
function RotationNote({ deviceId, instanceId }: { deviceId: string; instanceId: string }) {
  const playlist = usePlaylist(deviceId);
  const devices = useDevices();
  const name = devices.data?.find((device) => device.id === deviceId)?.name ?? 'the display';
  const entries = (playlist.data ?? []).filter((item) => item.moduleInstanceId === instanceId);
  if (!playlist.data) return null;

  return (
    <p className="text-xs leading-relaxed text-[var(--color-ink-faint)]">
      {entries.length > 0 ? (
        <>
          <span className="text-[var(--color-ok)]">✓</span> In {name}&rsquo;s rotation as{' '}
          {entries.map((entry) => entry.viewDisplayName).join(', ')}.
        </>
      ) : (
        <>Not in {name}&rsquo;s rotation. You can add it in the next step.</>
      )}
    </p>
  );
}
