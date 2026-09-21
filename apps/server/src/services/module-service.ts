import {
  AppError,
  newId,
  type ModuleDefinitionDto,
  type ModuleInstanceDto,
  type SecretFieldStateDto,
} from '@gca/shared';
import { migrateToCurrent } from '@gca/core';
import type { AppContext } from '../context.js';

export interface UpdateInstanceInput {
  name?: string;
  enabled?: boolean;
  settings?: Record<string, unknown>;
  /** Empty string preserves the existing secret; explicit null removes it. */
  secrets?: Record<string, string | null>;
}

/**
 * Module instance CRUD.
 *
 * The important rule lives in `update`: settings and secrets are written inside one
 * transaction, but validation runs first against the *post-update* secret state, so a
 * schema that requires "a credential or local mode" sees what will actually exist.
 */
export class ModuleService {
  constructor(private readonly ctx: AppContext) {}

  listDefinitions(): ModuleDefinitionDto[] {
    return this.ctx.registry.list().map((entry) => ({
      id: entry.manifest.id,
      version: entry.manifest.version,
      settingsVersion: entry.manifest.settingsVersion,
      displayName: entry.manifest.displayName,
      description: entry.manifest.description,
      icon: entry.manifest.icon,
      category: entry.manifest.category,
      singleton: entry.manifest.singleton,
      refresh: entry.manifest.refresh,
      permissions: [...entry.manifest.permissions],
      views: entry.manifest.views.map((view) => ({
        id: view.id,
        displayName: view.displayName,
        ...(view.description ? { description: view.description } : {}),
      })),
      actions: (entry.manifest.actions ?? []).map((action) => ({
        id: action.id,
        displayName: action.displayName,
        ...(action.description ? { description: action.description } : {}),
        confirmation: action.confirmation,
        ...(action.inputSchema ? { inputSchema: action.inputSchema } : {}),
      })),
      settingsSchema: entry.module.settingsSchema,
      uiSchema: entry.module.uiSchema,
      defaultSettings: entry.module.defaultSettings as Record<string, unknown>,
      instanceCount: this.ctx.store.moduleInstances.listByModule(entry.manifest.id).length,
    }));
  }

  async create(moduleId: string, input: UpdateInstanceInput = {}): Promise<ModuleInstanceDto> {
    const entry = this.ctx.registry.get(moduleId);

    if (
      entry.manifest.singleton &&
      this.ctx.store.moduleInstances.listByModule(moduleId).length > 0
    ) {
      throw new AppError('CONFLICT', `${entry.manifest.displayName} allows only one instance.`);
    }

    const instanceId = newId('mod');
    const draftSettings = {
      ...(entry.module.defaultSettings as object),
      ...(input.settings ?? {}),
    };
    const secretsAfter = new Set(
      Object.entries(input.secrets ?? {})
        .filter(([, value]) => typeof value === 'string' && value.trim() !== '')
        .map(([key]) => key),
    );

    const validation = await this.ctx.validator.validate(entry.module, draftSettings, {
      instanceId: null,
      secretConfigured: (key) => secretsAfter.has(key),
    });
    if (!validation.ok || !validation.value) {
      throw new AppError('MODULE_SETTINGS_INVALID', 'These settings are not valid.', {
        details: { errors: validation.errors },
      });
    }

    this.ctx.store.transaction(() => {
      this.ctx.store.moduleInstances.insert({
        id: instanceId,
        moduleId,
        name: input.name?.trim() || entry.manifest.displayName,
        enabled: input.enabled ?? true,
        settingsVersion: entry.manifest.settingsVersion,
        settings: validation.value as Record<string, unknown>,
        healthStatus: 'unknown',
        healthMessage: null,
        lastSuccessAt: null,
        lastErrorCode: null,
        lastRefreshAt: null,
      });
      this.writeSecrets(instanceId, entry.module.secretKeys, input.secrets ?? {});
    });

    this.ctx.store.audit.record({
      eventType: 'module.created',
      entityType: 'module-instance',
      entityId: instanceId,
      details: { moduleId },
    });

    await this.reload(instanceId);
    return this.toDto(instanceId);
  }

  async update(instanceId: string, input: UpdateInstanceInput): Promise<ModuleInstanceDto> {
    const record = this.requireRecord(instanceId);
    const entry = this.ctx.registry.get(record.moduleId);

    // Model the secret state as it will be *after* this update so validation and
    // storage agree, rather than validating against the pre-update world.
    const secretsAfter = new Set<string>();
    for (const key of entry.module.secretKeys) {
      const incoming = input.secrets?.[key];
      if (incoming === null) continue;
      if (typeof incoming === 'string' && incoming.trim() !== '') {
        secretsAfter.add(key);
        continue;
      }
      if (this.ctx.store.secrets.state(instanceId, key).configured) secretsAfter.add(key);
    }

    let validated = record.settings;
    if (input.settings !== undefined) {
      const validation = await this.ctx.validator.validate(
        entry.module,
        { ...record.settings, ...input.settings },
        { instanceId, secretConfigured: (key) => secretsAfter.has(key) },
      );
      if (!validation.ok || !validation.value) {
        throw new AppError('MODULE_SETTINGS_INVALID', 'These settings are not valid.', {
          details: { errors: validation.errors },
        });
      }
      validated = validation.value;
    }

    this.ctx.store.transaction(() => {
      this.ctx.store.moduleInstances.update(instanceId, {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.settings !== undefined ? { settings: validated } : {}),
      });
      if (input.secrets) this.writeSecrets(instanceId, entry.module.secretKeys, input.secrets);
    });

    this.ctx.store.audit.record({
      eventType: 'module.updated',
      entityType: 'module-instance',
      entityId: instanceId,
      details: {
        moduleId: record.moduleId,
        changedSettings: Object.keys(input.settings ?? {}),
        changedSecrets: Object.keys(input.secrets ?? {}),
      },
    });

    await this.reload(instanceId);
    this.ctx.events.emit('module.settings-changed', { instanceId });
    return this.toDto(instanceId);
  }

  async remove(instanceId: string): Promise<void> {
    const record = this.requireRecord(instanceId);
    await this.ctx.runtimes.stopInstance(instanceId);
    this.ctx.store.moduleInstances.delete(instanceId);
    this.ctx.scheduler.rebuildJobs();
    this.ctx.scheduler.rebuildSchedules();
    this.ctx.store.audit.record({
      eventType: 'module.removed',
      entityType: 'module-instance',
      entityId: instanceId,
      severity: 'warn',
      details: { moduleId: record.moduleId },
    });
  }

  async validateDraft(
    instanceId: string,
    settings: Record<string, unknown>,
  ): Promise<{
    ok: boolean;
    errors: Array<{ path: string; message: string }>;
    warnings: string[];
  }> {
    const record = this.requireRecord(instanceId);
    const entry = this.ctx.registry.get(record.moduleId);
    const validation = await this.ctx.validator.validate(
      entry.module,
      { ...record.settings, ...settings },
      {
        instanceId,
        secretConfigured: (key) => this.ctx.store.secrets.state(instanceId, key).configured,
      },
    );
    return { ok: validation.ok, errors: validation.errors, warnings: validation.warnings };
  }

  /** Applies any pending settings migration, then restarts the runtime. */
  async reload(instanceId: string): Promise<void> {
    const record = this.ctx.store.moduleInstances.get(instanceId);
    if (!record) return;
    const entry = this.ctx.registry.tryGet(record.moduleId);

    if (entry && record.settingsVersion < entry.manifest.settingsVersion) {
      const migrated = await migrateToCurrent(
        entry.module,
        record.settingsVersion,
        record.settings,
      );
      this.ctx.store.moduleInstances.update(instanceId, {
        settingsVersion: migrated.version,
        settings: migrated.settings as Record<string, unknown>,
      });
      this.ctx.store.audit.record({
        eventType: 'module.settings-migrated',
        entityType: 'module-instance',
        entityId: instanceId,
        details: { from: record.settingsVersion, to: migrated.version },
      });
    }

    await this.ctx.runtimes.reload(instanceId);
    this.ctx.scheduler.rebuildJobs();
    this.ctx.scheduler.rebuildSchedules();
  }

  async toDto(instanceId: string): Promise<ModuleInstanceDto> {
    const record = this.requireRecord(instanceId);
    const entry = this.ctx.registry.tryGet(record.moduleId);
    const managed = this.ctx.runtimes.get(instanceId);

    const secrets: Record<string, SecretFieldStateDto> = {};
    for (const key of entry?.module.secretKeys ?? []) {
      const state = this.ctx.store.secrets.state(instanceId, key);
      // Only ever describe a secret; the value itself never leaves the vault.
      secrets[key] = {
        configured: state.configured,
        lastFour: state.lastFour,
        updatedAt: state.updatedAt,
      };
    }

    const panel = managed ? await this.ctx.runtimes.getStatusPanel(instanceId) : null;

    return {
      id: record.id,
      moduleId: record.moduleId,
      name: record.name,
      enabled: record.enabled,
      settingsVersion: record.settingsVersion,
      settings: record.settings,
      secrets,
      healthStatus: record.enabled ? (managed?.health.status ?? record.healthStatus) : 'disabled',
      healthMessage: managed?.health.message ?? record.healthMessage,
      lastSuccessAt: record.lastSuccessAt,
      lastErrorCode: record.lastErrorCode,
      lastRefreshAt: managed?.lastRefreshAt ?? record.lastRefreshAt,
      nextRefreshAt: managed?.nextRefreshAt ?? null,
      statusPanel: panel ?? null,
      views: (entry?.manifest.views ?? []).map((view) => ({
        id: view.id,
        displayName: view.displayName,
      })),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  async listDtos(): Promise<ModuleInstanceDto[]> {
    const records = this.ctx.store.moduleInstances.list();
    return Promise.all(records.map((record) => this.toDto(record.id)));
  }

  private writeSecrets(
    instanceId: string,
    allowedKeys: readonly string[],
    secrets: Record<string, string | null>,
  ): void {
    for (const [key, value] of Object.entries(secrets)) {
      if (!allowedKeys.includes(key)) {
        throw new AppError('VALIDATION_FAILED', `"${key}" is not a secret field of this module.`);
      }
      if (value === null) {
        // Removal is an explicit action, never an accident of an empty field.
        this.ctx.store.secrets.remove(instanceId, key);
        continue;
      }
      // An empty string means "leave the stored secret alone".
      if (value.trim() === '') continue;
      this.ctx.store.secrets.set(instanceId, key, value.trim());
    }
  }

  private requireRecord(instanceId: string) {
    const record = this.ctx.store.moduleInstances.get(instanceId);
    if (!record) throw new AppError('MODULE_NOT_FOUND', 'That module instance does not exist.');
    return record;
  }
}
