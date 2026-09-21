import { useMemo, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { Button, Field, Switch, inputClass } from './ui.js';
import type { JsonSchemaNode, SecretFieldStateDto, UiFieldMeta, UiSchema } from '../api/types.js';

/**
 * Renders a module's settings form purely from its JSON Schema and UI metadata.
 *
 * There is deliberately no module-specific branching anywhere in this file. A new
 * module gets a working, validated, accessible form by declaring a schema — which is
 * the property that makes the module system genuinely extensible rather than
 * nominally so.
 */

export interface SchemaFormProps {
  schema: JsonSchemaNode;
  uiSchema: UiSchema;
  values: Record<string, unknown>;
  secrets: Record<string, SecretFieldStateDto>;
  errors: Record<string, string>;
  onChange: (field: string, value: unknown) => void;
  onSecretChange: (field: string, value: string | null) => void;
  /** Pending secret edits, so the form can show "will be replaced / removed". */
  secretDrafts: Record<string, string | null>;
  renderAction?: (actionId: string) => ReactNode;
  disabled?: boolean;
}

export function SchemaForm({
  schema,
  uiSchema,
  values,
  secrets,
  errors,
  onChange,
  onSecretChange,
  secretDrafts,
  renderAction,
  disabled,
}: SchemaFormProps) {
  const grouped = useMemo(() => groupFields(schema, uiSchema), [schema, uiSchema]);

  return (
    <div className="grid gap-6">
      {grouped.map((section) => (
        <fieldset key={section.id} className="grid gap-4" disabled={disabled}>
          <legend className="sr-only">{section.title}</legend>
          <div>
            <h3 className="text-sm font-semibold text-[var(--color-ink)]">{section.title}</h3>
            {section.description && (
              <p className="mt-1 text-xs leading-relaxed text-[var(--color-ink-muted)]">
                {section.description}
              </p>
            )}
          </div>

          <div className="grid gap-4">
            {section.fields.map((entry) => {
              if (!isVisible(entry.meta, values)) return null;
              return (
                <div key={entry.name} className="grid gap-2">
                  {entry.meta.secret ? (
                    <SecretInput
                      name={entry.name}
                      meta={entry.meta}
                      state={secrets[entry.name]}
                      draft={secretDrafts[entry.name]}
                      error={errors[`/${entry.name}`]}
                      onChange={(value) => onSecretChange(entry.name, value)}
                    />
                  ) : (
                    <SchemaField
                      name={entry.name}
                      node={entry.node}
                      meta={entry.meta}
                      value={values[entry.name]}
                      error={errors[`/${entry.name}`]}
                      values={values}
                      onChange={onChange}
                    />
                  )}
                  {entry.meta.actionId && renderAction?.(entry.meta.actionId)}
                </div>
              );
            })}
          </div>

          {(uiSchema.sectionActions?.[section.id] ?? []).length > 0 && renderAction && (
            <div className="flex flex-wrap gap-2 border-t border-[var(--color-line)] pt-3">
              {(uiSchema.sectionActions?.[section.id] ?? []).map((actionId) => (
                <div key={actionId}>{renderAction(actionId)}</div>
              ))}
            </div>
          )}
        </fieldset>
      ))}
    </div>
  );
}

interface FieldEntry {
  name: string;
  node: JsonSchemaNode;
  meta: UiFieldMeta;
}

/**
 * Composite widgets that render more than one schema property.
 *
 * A `location` control draws latitude and longitude together, so the companion
 * property must not also appear as a standalone field. Declaring the relationship
 * here keeps the rule in the renderer rather than making every module remember it.
 */
const COMPOSITE_WIDGET_COMPANIONS: Partial<Record<NonNullable<UiFieldMeta['widget']>, string[]>> = {
  location: ['longitude'],
};

interface SectionGroup {
  id: string;
  title: string;
  description?: string;
  fields: FieldEntry[];
}

function groupFields(schema: JsonSchemaNode, uiSchema: UiSchema): SectionGroup[] {
  const properties = schema.properties ?? {};

  const consumed = new Set<string>();
  for (const meta of Object.values(uiSchema.fields)) {
    for (const companion of COMPOSITE_WIDGET_COMPANIONS[meta.widget ?? 'text'] ?? []) {
      consumed.add(companion);
    }
  }

  return uiSchema.sections.map((section) => ({
    id: section.id,
    title: section.title,
    ...(section.description ? { description: section.description } : {}),
    fields: Object.entries(uiSchema.fields)
      .filter(([name, meta]) => meta.section === section.id && !consumed.has(name))
      .sort(([, a], [, b]) => a.order - b.order)
      .map(([name, meta]) => ({
        name,
        // Secret fields have no schema entry: they live in the vault, not in settings.
        node: properties[name] ?? { type: 'string' },
        meta,
      })),
  }));
}

function isVisible(meta: UiFieldMeta, values: Record<string, unknown>): boolean {
  if (!meta.visibleWhen) return true;
  return meta.visibleWhen.equals.includes(values[meta.visibleWhen.field]);
}

function labelFor(name: string, meta: UiFieldMeta): string {
  if (meta.label) return meta.label;
  // Turn camelCase into a sentence, so an undeclared label still reads properly.
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function resolveWidget(
  node: JsonSchemaNode,
  meta: UiFieldMeta,
): NonNullable<UiFieldMeta['widget']> {
  if (meta.widget) return meta.widget;
  if (node.enum) return 'select';
  const types = Array.isArray(node.type) ? node.type : [node.type];
  if (types.includes('boolean')) return 'switch';
  if (types.includes('number') || types.includes('integer')) return 'number';
  return 'text';
}

function SchemaField({
  name,
  node,
  meta,
  value,
  error,
  values,
  onChange,
}: {
  name: string;
  node: JsonSchemaNode;
  meta: UiFieldMeta;
  value: unknown;
  error: string | undefined;
  values: Record<string, unknown>;
  onChange: (field: string, value: unknown) => void;
}) {
  const id = `field-${name}`;
  const widget = resolveWidget(node, meta);
  const label = labelFor(name, meta);
  const nullable = Array.isArray(node.type) && node.type.includes('null');
  const min = meta.min ?? node.minimum;
  const max = meta.max ?? node.maximum;

  switch (widget) {
    case 'switch':
      return (
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <label htmlFor={id} className="text-sm font-medium text-[var(--color-ink)]">
              {label}
            </label>
            {meta.help && (
              <p className="mt-1 text-xs leading-relaxed text-[var(--color-ink-faint)]">
                {meta.help}
              </p>
            )}
            {error && (
              <p role="alert" className="mt-1 text-xs font-medium text-[var(--color-bad)]">
                {error}
              </p>
            )}
          </div>
          <Switch
            id={id}
            label={label}
            checked={value === true}
            onChange={(next) => onChange(name, next)}
          />
        </div>
      );

    case 'select': {
      const options: NonNullable<UiFieldMeta['options']> =
        meta.options ??
        (node.enum ?? []).map((option) => ({ value: String(option), label: String(option) }));
      const selected = options.find((option) => option.value === String(value ?? ''));
      return (
        <Field label={label} htmlFor={id} help={selected?.description ?? meta.help} error={error}>
          <select
            id={id}
            className={inputClass}
            value={String(value ?? '')}
            onChange={(event) => onChange(name, event.target.value)}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      );
    }

    case 'slider':
      return (
        <Field label={label} htmlFor={id} help={meta.help} error={error} unit={meta.unit}>
          <div className="flex items-center gap-3">
            <input
              id={id}
              type="range"
              className="h-2 flex-1 accent-[var(--color-accent)]"
              min={min ?? 0}
              max={max ?? 100}
              step={meta.step ?? 1}
              value={Number(value ?? min ?? 0)}
              onChange={(event) => onChange(name, Number(event.target.value))}
            />
            <input
              type="number"
              aria-label={`${label} value`}
              className={clsx(inputClass, 'w-24 text-right')}
              min={min ?? 0}
              max={max ?? 100}
              step={meta.step ?? 1}
              value={Number(value ?? min ?? 0)}
              onChange={(event) => onChange(name, Number(event.target.value))}
            />
          </div>
        </Field>
      );

    case 'number':
    case 'duration':
      return (
        <Field label={label} htmlFor={id} help={meta.help} error={error} unit={meta.unit}>
          <input
            id={id}
            type="number"
            inputMode="decimal"
            className={inputClass}
            placeholder={meta.placeholder ?? (nullable ? 'Not set' : undefined)}
            min={min}
            max={max}
            step={meta.step ?? (node.type === 'integer' ? 1 : 'any')}
            value={value === null || value === undefined ? '' : String(value)}
            onChange={(event) => {
              const raw = event.target.value;
              // An empty box means "no value" for a nullable field, not zero.
              if (raw === '') {
                onChange(name, nullable ? null : undefined);
                return;
              }
              onChange(name, Number(raw));
            }}
          />
        </Field>
      );

    case 'location':
      return (
        <LocationField
          id={id}
          label={label}
          meta={meta}
          error={error}
          latitude={values['latitude']}
          longitude={values['longitude']}
          onChange={onChange}
        />
      );

    case 'textarea':
      return (
        <Field label={label} htmlFor={id} help={meta.help} error={error}>
          <textarea
            id={id}
            rows={3}
            className={inputClass}
            placeholder={meta.placeholder}
            value={String(value ?? '')}
            onChange={(event) => onChange(name, event.target.value)}
          />
        </Field>
      );

    default:
      return (
        <Field label={label} htmlFor={id} help={meta.help} error={error} unit={meta.unit}>
          <input
            id={id}
            type="text"
            className={inputClass}
            placeholder={meta.placeholder}
            maxLength={node.maxLength}
            value={String(value ?? '')}
            onChange={(event) => onChange(name, event.target.value)}
          />
        </Field>
      );
  }
}

/**
 * Latitude and longitude with an optional browser-geolocation assist.
 *
 * The privacy note is not decoration: these coordinates leave the machine on every
 * poll, and the user should know that before entering their home address.
 */
function LocationField({
  id,
  label,
  meta,
  error,
  latitude,
  longitude,
  onChange,
}: {
  id: string;
  label: string;
  meta: UiFieldMeta;
  error: string | undefined;
  latitude: unknown;
  longitude: unknown;
  onChange: (field: string, value: unknown) => void;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const useBrowserLocation = () => {
    if (!('geolocation' in navigator)) {
      setStatus('This browser does not expose a location API.');
      return;
    }
    setBusy(true);
    setStatus(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        onChange('latitude', Number(position.coords.latitude.toFixed(6)));
        onChange('longitude', Number(position.coords.longitude.toFixed(6)));
        setStatus(
          `Set from this browser (accurate to about ${Math.round(position.coords.accuracy)} m).`,
        );
        setBusy(false);
      },
      (positionError) => {
        setStatus(
          positionError.code === positionError.PERMISSION_DENIED
            ? 'Location permission was denied. Enter the coordinates by hand instead.'
            : 'This browser could not determine a location. Enter the coordinates by hand instead.',
        );
        setBusy(false);
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  };

  return (
    <Field label={label} htmlFor={id} help={meta.help} error={error}>
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <label htmlFor={id} className="mb-1 block text-xs text-[var(--color-ink-faint)]">
            Latitude
          </label>
          <input
            id={id}
            type="number"
            inputMode="decimal"
            step="any"
            min={-90}
            max={90}
            className={inputClass}
            value={latitude === null || latitude === undefined ? '' : String(latitude)}
            onChange={(event) =>
              onChange(
                'latitude',
                event.target.value === '' ? undefined : Number(event.target.value),
              )
            }
          />
        </div>
        <div>
          <label htmlFor={`${id}-lon`} className="mb-1 block text-xs text-[var(--color-ink-faint)]">
            Longitude
          </label>
          <input
            id={`${id}-lon`}
            type="number"
            inputMode="decimal"
            step="any"
            min={-180}
            max={180}
            className={inputClass}
            value={longitude === null || longitude === undefined ? '' : String(longitude)}
            onChange={(event) =>
              onChange(
                'longitude',
                event.target.value === '' ? undefined : Number(event.target.value),
              )
            }
          />
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button type="button" onClick={useBrowserLocation} busy={busy}>
          Use this browser&rsquo;s location
        </Button>
        {status && <span className="text-xs text-[var(--color-ink-muted)]">{status}</span>}
      </div>
    </Field>
  );
}

/**
 * Write-only secret input.
 *
 * The current value is never sent to the browser, so the control shows only whether
 * one is configured and its last four characters. Leaving it blank preserves what is
 * stored; removal is a separate, explicit action.
 */
function SecretInput({
  name,
  meta,
  state,
  draft,
  error,
  onChange,
}: {
  name: string;
  meta: UiFieldMeta;
  state: SecretFieldStateDto | undefined;
  draft: string | null | undefined;
  error: string | undefined;
  onChange: (value: string | null) => void;
}) {
  const id = `secret-${name}`;
  const configured = state?.configured ?? false;
  const pendingRemoval = draft === null;

  return (
    <Field
      label={labelFor(name, meta)}
      htmlFor={id}
      error={error}
      help={
        <>
          {meta.help}
          {meta.help && <br />}
          {configured
            ? `A value is stored (ends in ${state?.lastFour ?? '****'}). Leave this blank to keep it.`
            : 'No value is stored yet.'}
        </>
      }
    >
      <input
        id={id}
        type="password"
        autoComplete="off"
        spellCheck={false}
        className={inputClass}
        placeholder={configured ? '•••••••••• (unchanged)' : meta.placeholder}
        value={typeof draft === 'string' ? draft : ''}
        disabled={pendingRemoval}
        onChange={(event) => onChange(event.target.value)}
      />

      {configured && (
        <div className="mt-1 flex items-center gap-2">
          {pendingRemoval ? (
            <>
              <span className="text-xs font-medium text-[var(--color-bad)]">
                Will be removed when you save.
              </span>
              <Button type="button" variant="ghost" onClick={() => onChange('')}>
                Keep it
              </Button>
            </>
          ) : (
            <Button type="button" variant="ghost" onClick={() => onChange(null)}>
              Remove stored value
            </Button>
          )}
        </div>
      )}
    </Field>
  );
}
