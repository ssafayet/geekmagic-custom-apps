import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api/client.js';
import {
  useCreateInstance,
  useDeleteInstance,
  useModuleDefinitions,
  useModuleInstance,
  useModuleInstances,
  useRefreshInstance,
  useUpdateInstance,
} from '../api/hooks.js';
import { Banner, Button, Card, EmptyState, HealthBadge, Spinner4 } from '../components/ui.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { ModuleSettingsForm, useModuleSettingsDraft } from '../components/ModuleSettings.js';
import { Preview } from '../components/Preview.js';
import { StatusPanel } from '../components/StatusPanel.js';
import { permissionLabel, relativeTime } from '../format.js';
import type { ModuleDefinitionDto, ModuleInstanceDto } from '../api/types.js';

export function ModulesPage() {
  const definitions = useModuleDefinitions();
  const instances = useModuleInstances();
  const { instanceId } = useParams<{ instanceId: string }>();
  const navigate = useNavigate();
  const create = useCreateInstance();
  const [error, setError] = useState<string | null>(null);

  if (definitions.isLoading || instances.isLoading) return <Spinner4 />;

  const catalog = definitions.data ?? [];
  const configured = instances.data ?? [];
  const selectedId = instanceId ?? configured[0]?.id;

  const addInstance = async (definition: ModuleDefinitionDto) => {
    setError(null);
    try {
      const instance = await create.mutateAsync({ moduleId: definition.id });
      navigate(`/modules/${instance.id}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    }
  };

  return (
    <div className="grid gap-5">
      {error && <Banner tone="bad">{error}</Banner>}

      <Card
        title="Module catalog"
        description="Every form below is generated from the module's own schema."
      >
        <ul className="grid gap-3 sm:grid-cols-2">
          {catalog.map((definition) => {
            const existing = configured.filter((instance) => instance.moduleId === definition.id);
            const atLimit = definition.singleton && existing.length > 0;
            return (
              <li
                key={definition.id}
                className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-[var(--color-ink)]">
                      {definition.displayName}
                    </h3>
                    <p className="mt-1 text-xs leading-relaxed text-[var(--color-ink-muted)]">
                      {definition.description}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full border border-[var(--color-line)] px-2 py-0.5 text-xs text-[var(--color-ink-faint)]">
                    {definition.category}
                  </span>
                </div>

                {definition.permissions.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
                      Needs permission to
                    </p>
                    <ul className="mt-1 grid gap-0.5 text-xs text-[var(--color-ink-muted)]">
                      {definition.permissions.map((permission) => (
                        <li key={permission}>· {permissionLabel(permission)}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {/* A module already at its instance limit offers configuration, not a
                      disabled Add button next to an explanation of why it is disabled. */}
                  {!atLimit && (
                    <Button
                      variant="primary"
                      busy={create.isPending}
                      onClick={() => void addInstance(definition)}
                    >
                      {existing.length > 0 ? 'Add another' : 'Add'}
                    </Button>
                  )}
                  {existing.map((instance) => (
                    <Button
                      key={instance.id}
                      variant={atLimit ? 'primary' : 'secondary'}
                      onClick={() => navigate(`/modules/${instance.id}`)}
                    >
                      {existing.length > 1 ? `Configure ${instance.name}` : 'Configure'}
                    </Button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      {configured.length === 0 ? (
        <EmptyState title="No modules configured">
          Add one above to put something on the display.
        </EmptyState>
      ) : (
        <Card title="Configured modules">
          <ul className="grid gap-2">
            {configured.map((instance) => (
              <li key={instance.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/modules/${instance.id}`)}
                  aria-current={selectedId === instance.id ? 'true' : undefined}
                  className={`flex w-full flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-left transition-colors ${
                    selectedId === instance.id
                      ? 'border-[var(--color-accent)] bg-[var(--color-surface-2)]'
                      : 'border-[var(--color-line)] bg-[var(--color-surface-2)] hover:bg-[var(--color-surface-3)]'
                  }`}
                >
                  <div className="min-w-0">
                    <span className="text-sm font-medium text-[var(--color-ink)]">
                      {instance.name}
                    </span>
                    <p className="text-xs text-[var(--color-ink-faint)]">
                      {instance.healthMessage ?? `Updated ${relativeTime(instance.lastRefreshAt)}`}
                    </p>
                  </div>
                  <HealthBadge status={instance.healthStatus} />
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {selectedId && <ModuleEditor key={selectedId} instanceId={selectedId} />}
    </div>
  );
}

/**
 * Generic module editor.
 *
 * Reads the definition's JSON Schema, UI metadata and declared actions, and renders
 * them. Nothing here knows what a Claude window or an aircraft is.
 */
function ModuleEditor({ instanceId }: { instanceId: string }) {
  const navigate = useNavigate();
  const instanceQuery = useModuleInstance(instanceId);
  const definitions = useModuleDefinitions();
  const update = useUpdateInstance(instanceId);
  const refresh = useRefreshInstance(instanceId);
  const remove = useDeleteInstance();

  const instance = instanceQuery.data;
  const definition = definitions.data?.find((candidate) => candidate.id === instance?.moduleId);
  const form = useModuleSettingsDraft(instance);

  const [confirmRemove, setConfirmRemove] = useState(false);
  const [previewVersion, setPreviewVersion] = useState(0);

  if (instanceQuery.isLoading || definitions.isLoading) return <Spinner4 />;
  if (!instance || !definition) {
    return <Banner tone="bad">That module instance no longer exists.</Banner>;
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto]">
      <div className="grid gap-5">
        <Card
          title={instance.name}
          description={definition.description}
          actions={
            <>
              <Button
                busy={refresh.isPending}
                onClick={async () => {
                  await refresh.mutateAsync();
                  setPreviewVersion((value) => value + 1);
                }}
              >
                Refresh now
              </Button>
              <Button
                onClick={() => void update.mutateAsync({ enabled: !instance.enabled })}
                busy={update.isPending}
              >
                {instance.enabled ? 'Disable' : 'Enable'}
              </Button>
            </>
          }
        >
          <div className="flex flex-wrap items-center gap-3">
            <HealthBadge status={instance.healthStatus} />
            <span className="text-sm text-[var(--color-ink-muted)]">
              {instance.healthMessage ?? 'No status reported yet.'}
            </span>
          </div>
          {!instance.enabled && (
            <div className="mt-3">
              <Banner tone="warn">
                This module is disabled. It performs no network requests and produces no frames.
              </Banner>
            </div>
          )}
        </Card>

        {instance.statusPanel && (
          <Card title="Status">
            <StatusPanel panel={instance.statusPanel} />
          </Card>
        )}

        <Card
          title="Settings"
          actions={
            <>
              {form.dirty && (
                <span className="self-center text-xs text-[var(--color-warn)]">
                  Unsaved changes
                </span>
              )}
              <Button variant="ghost" disabled={!form.dirty} onClick={form.discard}>
                Discard
              </Button>
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
          <ModuleSettingsForm
            instance={instance}
            definition={definition}
            form={form}
            onActionCompleted={() => setPreviewVersion((value) => value + 1)}
          />
        </Card>

        <Card title="Remove">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-[var(--color-ink-muted)]">
              Deletes this module&rsquo;s settings, stored credentials and display-order entries.
            </p>
            <Button variant="danger" onClick={() => setConfirmRemove(true)}>
              Remove module
            </Button>
          </div>
        </Card>
      </div>

      <Card title="Preview" className="lg:w-[320px]">
        <ModulePreviews instance={instance} version={previewVersion} />
      </Card>

      <ConfirmDialog
        open={confirmRemove}
        title={`Remove ${instance.name}?`}
        destructive
        confirmLabel="Remove module"
        busy={remove.isPending}
        consequence={
          <>
            This deletes the settings and any stored credentials for{' '}
            <strong>{instance.name}</strong>, and removes it from every display&rsquo;s order. It
            does not undo changes it made outside this application, such as an installed status-line
            bridge.
          </>
        }
        onCancel={() => setConfirmRemove(false)}
        onConfirm={async () => {
          await remove.mutateAsync({ id: instanceId });
          setConfirmRemove(false);
          navigate('/modules');
        }}
      />
    </div>
  );
}

/** The instance's main view at full size, then any further views smaller beneath it. */
export function ModulePreviews({
  instance,
  version,
}: {
  instance: ModuleInstanceDto;
  version: number;
}) {
  return (
    <>
      <Preview
        key={version}
        path={`/module-instances/${instance.id}/preview`}
        label={`${instance.name} preview`}
        size={240}
        refreshMs={15_000}
      />
      {instance.views.length > 1 && (
        <ul className="mt-3 grid gap-2">
          {instance.views.slice(1).map((view) => (
            <li key={view.id}>
              <p className="mb-1 text-xs text-[var(--color-ink-faint)]">{view.displayName}</p>
              <Preview
                key={`${view.id}-${version}`}
                path={`/module-instances/${instance.id}/preview?viewId=${encodeURIComponent(view.id)}`}
                label={`${instance.name} ${view.displayName} preview`}
                size={160}
                refreshMs={0}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
