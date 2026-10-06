import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../api/client.js';
import { useRunModuleAction, useUpdateInstance } from '../api/hooks.js';
import { Banner, Button } from './ui.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { SchemaForm } from './SchemaForm.js';
import { StatusPanel } from './StatusPanel.js';
import type {
  ActionResultDto,
  JsonSchemaNode,
  ModuleDefinitionDto,
  ModuleInstanceDto,
  UiSchema,
} from '../api/types.js';

export interface ModuleSettingsDraft {
  draft: Record<string, unknown>;
  secretDrafts: Record<string, string | null>;
  errors: Record<string, string>;
  notice: { tone: 'ok' | 'bad'; text: string } | null;
  dirty: boolean;
  saving: boolean;
  setField: (field: string, value: unknown) => void;
  setSecret: (field: string, value: string | null) => void;
  discard: () => void;
  /** Resolves true once the server accepted the settings. */
  save: () => Promise<boolean>;
}

/**
 * Unsaved edits to one module instance's settings and secrets.
 *
 * Shared by the module editor and the setup guide so both validate, save and guard
 * against losing edits the same way.
 */
export function useModuleSettingsDraft(
  instance: ModuleInstanceDto | undefined,
): ModuleSettingsDraft {
  const update = useUpdateInstance(instance?.id ?? '');
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string | null>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<ModuleSettingsDraft['notice']>(null);

  // Re-seed the form whenever the saved settings change underneath it.
  useEffect(() => {
    if (instance) setDraft(instance.settings);
  }, [instance?.id, instance?.updatedAt]);

  const dirty = useMemo(() => {
    if (!instance) return false;
    const settingsChanged = JSON.stringify(draft) !== JSON.stringify(instance.settings);
    return settingsChanged || Object.keys(secretDrafts).length > 0;
  }, [draft, secretDrafts, instance]);

  // Warn before a navigation or reload throws away unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const save = async () => {
    setNotice(null);
    setErrors({});
    try {
      const secrets = Object.fromEntries(
        Object.entries(secretDrafts).filter(([, value]) => value === null || value.trim() !== ''),
      );
      await update.mutateAsync({
        settings: draft,
        ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
      });
      setSecretDrafts({});
      setNotice({ tone: 'ok', text: 'Saved.' });
      return true;
    } catch (caught) {
      if (caught instanceof ApiError && caught.fieldErrors.length > 0) {
        setErrors(
          Object.fromEntries(caught.fieldErrors.map((entry) => [entry.path, entry.message])),
        );
        setNotice({ tone: 'bad', text: 'Some settings need attention.' });
        return false;
      }
      setNotice({
        tone: 'bad',
        text: caught instanceof ApiError ? caught.message : String(caught),
      });
      return false;
    }
  };

  return {
    draft,
    secretDrafts,
    errors,
    notice,
    dirty,
    saving: update.isPending,
    setField: (field, value) => setDraft((current) => ({ ...current, [field]: value })),
    setSecret: (field, value) => setSecretDrafts((current) => ({ ...current, [field]: value })),
    discard: () => {
      if (instance) setDraft(instance.settings);
      setSecretDrafts({});
      setErrors({});
      setNotice(null);
    },
    save,
  };
}

/** The generated settings form for one instance, with its declared action buttons. */
export function ModuleSettingsForm({
  instance,
  definition,
  form,
  onActionCompleted,
}: {
  instance: ModuleInstanceDto;
  definition: ModuleDefinitionDto;
  form: ModuleSettingsDraft;
  onActionCompleted: () => void;
}) {
  return (
    <>
      {form.notice && (
        <div className="mb-4">
          <Banner tone={form.notice.tone}>{form.notice.text}</Banner>
        </div>
      )}

      <SchemaForm
        schema={definition.settingsSchema as JsonSchemaNode}
        uiSchema={definition.uiSchema as UiSchema}
        values={form.draft}
        secrets={instance.secrets}
        secretDrafts={form.secretDrafts}
        errors={form.errors}
        disabled={form.saving}
        onChange={form.setField}
        onSecretChange={form.setSecret}
        renderAction={(actionId) => (
          <ModuleActionButton
            key={actionId}
            instanceId={instance.id}
            definition={definition}
            actionId={actionId}
            draft={form.draft}
            secretDrafts={form.secretDrafts}
            onCompleted={onActionCompleted}
          />
        )}
      />
    </>
  );
}

/** Renders one declared module action, including its confirmation requirement. */
function ModuleActionButton({
  instanceId,
  definition,
  actionId,
  draft,
  secretDrafts,
  onCompleted,
}: {
  instanceId: string;
  definition: ModuleDefinitionDto;
  actionId: string;
  draft: Record<string, unknown>;
  secretDrafts: Record<string, string | null>;
  onCompleted: () => void;
}) {
  const run = useRunModuleAction(instanceId);
  const [result, setResult] = useState<ActionResultDto | null>(null);
  const [confirming, setConfirming] = useState(false);

  const action = definition.actions.find((candidate) => candidate.id === actionId);
  const label = action?.displayName ?? (actionId === 'core.refreshNow' ? 'Refresh now' : actionId);
  const needsConfirm = action?.confirmation && action.confirmation !== 'none';

  // Unsaved settings are passed as the action input so a test acts on what is on
  // screen, not on what was last saved.
  const input: Record<string, unknown> = { ...draft };
  for (const [key, value] of Object.entries(secretDrafts)) {
    if (typeof value === 'string' && value.trim() !== '') input[key] = value;
  }

  const execute = async (confirm: boolean) => {
    setResult(null);
    try {
      setResult(await run.mutateAsync({ actionId, input, ...(confirm ? { confirm: true } : {}) }));
      onCompleted();
    } catch (caught) {
      setResult({
        ok: false,
        message: caught instanceof ApiError ? caught.message : String(caught),
      });
    }
  };

  return (
    <div className="grid gap-2">
      <div>
        <Button
          type="button"
          busy={run.isPending}
          variant={action?.confirmation === 'destructive' ? 'danger' : 'secondary'}
          onClick={() => (needsConfirm ? setConfirming(true) : void execute(false))}
        >
          {label}
        </Button>
      </div>

      {result && (
        <div className="grid gap-2">
          <Banner tone={result.ok ? 'ok' : 'bad'}>{result.message}</Banner>
          {result.panel && <StatusPanel panel={result.panel} />}
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        title={label}
        destructive={action?.confirmation === 'destructive'}
        confirmLabel={label}
        busy={run.isPending}
        consequence={action?.description ?? 'This action needs confirmation.'}
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          setConfirming(false);
          await execute(true);
        }}
      />
    </div>
  );
}
