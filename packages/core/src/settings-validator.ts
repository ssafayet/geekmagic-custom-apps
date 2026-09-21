import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { AppError } from '@gca/shared';
import type {
  AnyAppModule,
  JsonSchema,
  ValidationContext,
  ValidationResult,
} from '@gca/module-sdk';

export interface SettingsValidationOutcome {
  ok: boolean;
  value: Record<string, unknown> | null;
  errors: Array<{ path: string; message: string }>;
  warnings: string[];
}

/**
 * Two-stage settings validation.
 *
 * Ajv enforces the declared JSON Schema (types, ranges, enums, conditionals) and fills
 * defaults; the module's own `validateSettings` then applies cross-field rules that a
 * schema cannot express, such as "exit radius must exceed enter radius".
 */
export class SettingsValidator {
  readonly #ajv: Ajv2020;
  readonly #compiled = new Map<string, ValidateFunction>();

  constructor() {
    this.#ajv = new Ajv2020({
      allErrors: true,
      useDefaults: true,
      coerceTypes: false,
      strict: false,
      removeAdditional: false,
    });
    (addFormats as unknown as (ajv: Ajv2020) => void)(this.#ajv);
  }

  compile(moduleId: string, schema: JsonSchema): ValidateFunction {
    const cached = this.#compiled.get(moduleId);
    if (cached) return cached;
    try {
      const validate = this.#ajv.compile(schema);
      this.#compiled.set(moduleId, validate);
      return validate;
    } catch (cause) {
      throw new AppError('INTERNAL_ERROR', `Module "${moduleId}" has an invalid settings schema.`, {
        cause,
      });
    }
  }

  async validate(
    module: AnyAppModule,
    settings: unknown,
    ctx: ValidationContext,
  ): Promise<SettingsValidationOutcome> {
    const validate = this.compile(module.manifest.id, module.settingsSchema);

    // Ajv mutates the candidate when applying defaults, so work on a copy.
    const candidate: Record<string, unknown> = {
      ...module.defaultSettings,
      ...(settings && typeof settings === 'object' && !Array.isArray(settings)
        ? (settings as Record<string, unknown>)
        : {}),
    };

    if (!validate(candidate)) {
      return {
        ok: false,
        value: null,
        errors: (validate.errors ?? []).map(formatAjvError),
        warnings: [],
      };
    }

    const result: ValidationResult<unknown> = await module.validateSettings(candidate, ctx);
    if (!result.ok) {
      return { ok: false, value: null, errors: result.errors, warnings: [] };
    }

    return {
      ok: true,
      value: result.value as Record<string, unknown>,
      errors: [],
      warnings: result.warnings ?? [],
    };
  }
}

/** Turns an Ajv error into something a person can act on in a form field. */
export function formatAjvError(error: ErrorObject): { path: string; message: string } {
  const path =
    error.instancePath || `/${String(error.params['missingProperty'] ?? '')}`.replace(/\/$/, '');
  const field = path.replace(/^\//, '') || 'settings';

  switch (error.keyword) {
    case 'required':
      return { path, message: `${String(error.params['missingProperty'])} is required.` };
    case 'enum':
      return {
        path,
        message: `${field} must be one of: ${(error.params['allowedValues'] as unknown[]).join(', ')}.`,
      };
    case 'minimum':
      return { path, message: `${field} must be at least ${String(error.params['limit'])}.` };
    case 'maximum':
      return { path, message: `${field} must be at most ${String(error.params['limit'])}.` };
    case 'minLength':
      return {
        path,
        message: `${field} must be at least ${String(error.params['limit'])} characters.`,
      };
    case 'maxLength':
      return {
        path,
        message: `${field} must be at most ${String(error.params['limit'])} characters.`,
      };
    case 'type':
      return { path, message: `${field} must be a ${String(error.params['type'])}.` };
    case 'pattern':
      return { path, message: `${field} is not in the expected format.` };
    case 'additionalProperties':
      return {
        path,
        message: `${String(error.params['additionalProperty'])} is not a recognised setting.`,
      };
    default:
      return { path, message: `${field} ${error.message ?? 'is invalid'}.` };
  }
}

/**
 * Applies a module's migration chain until the stored settings reach the current
 * version. Bounded so a module returning the same version cannot loop forever.
 */
export async function migrateToCurrent(
  module: AnyAppModule,
  storedVersion: number,
  settings: unknown,
): Promise<{ version: number; settings: unknown; migrated: boolean }> {
  const target = module.manifest.settingsVersion;
  let version = storedVersion;
  let value = settings;
  let steps = 0;

  while (version < target) {
    if (steps++ > 32) {
      throw new AppError(
        'MODULE_SETTINGS_INVALID',
        `Settings migration for "${module.manifest.id}" did not converge.`,
      );
    }
    const result = await module.migrateSettings(version, value);
    if (result.version <= version) {
      // The module cannot advance any further; accept what it produced.
      return { version: target, settings: result.settings, migrated: steps > 0 };
    }
    version = result.version;
    value = result.settings;
  }

  return { version: target, settings: value, migrated: steps > 0 };
}
