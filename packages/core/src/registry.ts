import { AppError } from '@gca/shared';
import type { AnyAppModule, ModuleManifest, ModulePermission } from '@gca/module-sdk';
import { MODULE_PERMISSIONS } from '@gca/module-sdk';
import { adsbMonitorModule } from '@gca/module-adsb-monitor';
import { claudeUsageModule } from '@gca/module-claude-usage';
import type { AppLogger } from './logger.js';

/**
 * Version 1 ships a static, trusted registry. Packaged or remote modules are
 * deliberately out of scope: loading third-party code would need a trust policy and
 * worker isolation, which is a different problem from the one this release solves.
 */
export const builtInModules: readonly AnyAppModule[] = [claudeUsageModule, adsbMonitorModule];

export interface RegistryEntry {
  module: AnyAppModule;
  manifest: ModuleManifest;
}

export interface RegistryLoadReport {
  loaded: string[];
  rejected: Array<{ id: string; reason: string }>;
}

const ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * Holds validated module definitions.
 *
 * A malformed module is rejected individually and the server still starts; one bad
 * module must not take the whole service down.
 */
export class ModuleRegistry {
  readonly #entries = new Map<string, RegistryEntry>();
  readonly #report: RegistryLoadReport = { loaded: [], rejected: [] };

  constructor(modules: readonly AnyAppModule[], logger?: AppLogger) {
    for (const module of modules) {
      const id = module?.manifest?.id ?? '<unknown>';
      try {
        validateModule(module);
        if (this.#entries.has(module.manifest.id)) {
          throw new Error(`Duplicate module id "${module.manifest.id}"`);
        }
        this.#entries.set(module.manifest.id, { module, manifest: module.manifest });
        this.#report.loaded.push(module.manifest.id);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.#report.rejected.push({ id, reason });
        logger?.error({ moduleId: id, reason }, 'Module rejected at startup');
      }
    }
  }

  get report(): RegistryLoadReport {
    return { loaded: [...this.#report.loaded], rejected: [...this.#report.rejected] };
  }

  list(): RegistryEntry[] {
    return [...this.#entries.values()];
  }

  has(moduleId: string): boolean {
    return this.#entries.has(moduleId);
  }

  get(moduleId: string): RegistryEntry {
    const entry = this.#entries.get(moduleId);
    if (!entry) {
      throw new AppError('MODULE_NOT_FOUND', `No module definition registered for "${moduleId}".`);
    }
    return entry;
  }

  tryGet(moduleId: string): RegistryEntry | null {
    return this.#entries.get(moduleId) ?? null;
  }
}

export function validateModule(module: AnyAppModule): void {
  if (!module || typeof module !== 'object') throw new Error('Module is not an object');

  const manifest = module.manifest;
  if (!manifest) throw new Error('Module has no manifest');
  if (!ID_PATTERN.test(manifest.id)) {
    throw new Error(`Manifest id "${manifest.id}" must be lowercase kebab-case`);
  }
  if (!manifest.displayName || !manifest.description) {
    throw new Error(`Module "${manifest.id}" needs a displayName and description`);
  }
  if (!Number.isInteger(manifest.settingsVersion) || manifest.settingsVersion < 1) {
    throw new Error(`Module "${manifest.id}" needs a positive integer settingsVersion`);
  }

  const { defaultSeconds, minimumSeconds, maximumSeconds } = manifest.refresh ?? {};
  if (
    !Number.isFinite(defaultSeconds) ||
    !Number.isFinite(minimumSeconds) ||
    !Number.isFinite(maximumSeconds) ||
    minimumSeconds > defaultSeconds ||
    defaultSeconds > maximumSeconds
  ) {
    throw new Error(`Module "${manifest.id}" has an inconsistent refresh range`);
  }

  for (const permission of manifest.permissions ?? []) {
    if (!MODULE_PERMISSIONS.includes(permission as ModulePermission)) {
      throw new Error(`Module "${manifest.id}" declares unknown permission "${permission}"`);
    }
  }

  if (!Array.isArray(manifest.views) || manifest.views.length === 0) {
    throw new Error(`Module "${manifest.id}" must declare at least one view`);
  }
  const viewIds = new Set<string>();
  for (const view of manifest.views) {
    if (!view.id || viewIds.has(view.id)) {
      throw new Error(`Module "${manifest.id}" has a missing or duplicate view id`);
    }
    viewIds.add(view.id);
  }

  const actionIds = new Set<string>();
  for (const action of manifest.actions ?? []) {
    if (!action.id || actionIds.has(action.id)) {
      throw new Error(`Module "${manifest.id}" has a missing or duplicate action id`);
    }
    if (!Number.isFinite(action.timeoutMs) || action.timeoutMs <= 0) {
      throw new Error(`Action "${action.id}" needs a positive timeoutMs`);
    }
    actionIds.add(action.id);
  }

  if (!module.settingsSchema || typeof module.settingsSchema !== 'object') {
    throw new Error(`Module "${manifest.id}" has no settings schema`);
  }
  if (!module.uiSchema || !Array.isArray(module.uiSchema.sections)) {
    throw new Error(`Module "${manifest.id}" has no UI schema sections`);
  }

  // Every field must point at a section that exists, or the generic form renderer
  // would silently drop it.
  const sectionIds = new Set(module.uiSchema.sections.map((section) => section.id));
  for (const [field, meta] of Object.entries(module.uiSchema.fields ?? {})) {
    if (!sectionIds.has(meta.section)) {
      throw new Error(`Field "${field}" references unknown section "${meta.section}"`);
    }
    if (meta.actionId && !actionIds.has(meta.actionId) && meta.actionId !== 'core.refreshNow') {
      throw new Error(`Field "${field}" references unknown action "${meta.actionId}"`);
    }
  }
  for (const [sectionId, ids] of Object.entries(module.uiSchema.sectionActions ?? {})) {
    if (!sectionIds.has(sectionId)) {
      throw new Error(`sectionActions references unknown section "${sectionId}"`);
    }
    for (const id of ids) {
      if (!actionIds.has(id) && id !== 'core.refreshNow') {
        throw new Error(`sectionActions references unknown action "${id}"`);
      }
    }
  }

  if (typeof module.createRuntime !== 'function') {
    throw new Error(`Module "${manifest.id}" has no createRuntime`);
  }
  if (typeof module.validateSettings !== 'function') {
    throw new Error(`Module "${manifest.id}" has no validateSettings`);
  }
  if (!Array.isArray(module.secretKeys)) {
    throw new Error(`Module "${manifest.id}" must declare secretKeys (use [] for none)`);
  }
}
