import { AppError, type CoreSettingsDto, type StatusSummaryDto } from '@gca/shared';
import { THEMES } from '@gca/renderer';
import type { AppContext } from '../context.js';
import type { DeviceService } from '../services/device-service.js';
import type { AppServer } from '../fastify-types.js';

export function registerCoreRoutes(
  app: AppServer,
  ctx: AppContext,
  services: { devices: DeviceService },
): void {
  // Public so container healthchecks work. The details are for the signed-in UI; a
  // caller without a session on a login-enforced server learns only that it is up.
  app.get('/api/v1/health', { config: { public: true } }, async (request) => {
    if (!app.auth.isAuthorized(request)) return { status: 'ok' };
    return {
      status: 'ok',
      version: ctx.config.version,
      startedAt: ctx.startedAt,
      modules: { loaded: ctx.registry.report.loaded, rejected: ctx.registry.report.rejected },
      devices: ctx.devices.list().length,
      bridge: ctx.bridgeInbox.describe(),
    };
  });

  app.get('/api/v1/status', async (): Promise<StatusSummaryDto> => {
    const deviceDtos = await services.devices.listDtos();

    const devices = await Promise.all(
      deviceDtos.map(async (device) => {
        const described = ctx.scheduler.describeDevice(device.id);
        return {
          id: device.id,
          name: device.name,
          host: device.host,
          profileId: device.profileId,
          online: device.online,
          health: device.health,
          lastUploadAt: device.lastUploadAt,
          currentFrame: await describeFrame(ctx, described.current),
          nextFrame: await describeFrame(ctx, described.next),
          interrupted: described.interrupted,
        };
      }),
    );

    const modules = ctx.store.moduleInstances.list().map((record) => {
      const managed = ctx.runtimes.get(record.id);
      return {
        id: record.id,
        moduleId: record.moduleId,
        name: record.name,
        enabled: record.enabled,
        health: record.enabled
          ? (managed?.health.status ?? record.healthStatus)
          : ('disabled' as const),
        healthMessage: managed?.health.message ?? record.healthMessage,
        lastSuccessAt: record.lastSuccessAt,
      };
    });

    // Only actionable problems reach the overview; routine info stays in the audit log.
    const recentErrors = ctx.store.audit.recentProblems(8).map((event) => ({
      id: event.id,
      at: event.createdAt,
      code: String(event.details['code'] ?? event.eventType),
      message: String(event.details['message'] ?? event.eventType),
      entityType: event.entityType,
      entityId: event.entityId,
    }));

    return {
      devices,
      modules,
      recentErrors,
      server: {
        version: ctx.config.version,
        startedAt: ctx.startedAt,
        boundHost: ctx.config.host,
        authenticationRequired: app.auth.required,
      },
    };
  });

  /**
   * Clears problems from the overview. Dismissal is an acknowledgement, not a delete:
   * the events stay in the audit log and in the diagnostic report.
   */
  app.post('/api/v1/problems/dismiss', async (request) => {
    const body = (request.body ?? {}) as { ids?: unknown };
    let ids: string[] | undefined;
    if (body.ids !== undefined) {
      if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string')) {
        throw new AppError('VALIDATION_FAILED', 'ids must be an array of event ids.');
      }
      ids = body.ids as string[];
    }

    // Without ids every problem raised so far is cleared, including the ones beyond
    // the eight the overview shows — otherwise "clear all" would refill itself.
    const dismissed = ctx.store.audit.acknowledgeProblems(ids ? { ids } : {});
    if (dismissed > 0) {
      ctx.store.audit.record({
        eventType: 'problems.dismissed',
        actor: 'operator',
        entityType: 'app',
        details: { count: dismissed, scope: ids ? 'selected' : 'all' },
      });
    }
    return { dismissed };
  });

  app.get(
    '/api/v1/settings',
    async (): Promise<
      CoreSettingsDto & { themes: Array<{ id: string; displayName: string }> }
    > => ({
      ...ctx.coreSettings(),
      themes: Object.values(THEMES).map((theme) => ({
        id: theme.id,
        displayName: theme.displayName,
      })),
    }),
  );

  app.patch('/api/v1/settings', async (request): Promise<CoreSettingsDto> => {
    const body = (request.body ?? {}) as Partial<CoreSettingsDto>;
    const patch: Partial<CoreSettingsDto> = {};

    if (body.displayTimezone !== undefined) {
      if (!isValidTimezone(body.displayTimezone)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `"${body.displayTimezone}" is not a known time zone.`,
        );
      }
      patch.displayTimezone = body.displayTimezone;
    }
    if (body.theme !== undefined) {
      if (!THEMES[body.theme]) {
        throw new AppError('VALIDATION_FAILED', `"${body.theme}" is not a known theme.`);
      }
      patch.theme = body.theme;
    }
    if (body.defaultDwellSeconds !== undefined) {
      patch.defaultDwellSeconds = clampInt(
        body.defaultDwellSeconds,
        5,
        3600,
        'defaultDwellSeconds',
      );
    }
    if (body.minimumUploadIntervalSeconds !== undefined) {
      patch.minimumUploadIntervalSeconds = clampInt(
        body.minimumUploadIntervalSeconds,
        5,
        3600,
        'minimumUploadIntervalSeconds',
      );
    }
    if (body.jpegQuality !== undefined) {
      patch.jpegQuality = clampInt(body.jpegQuality, 86, 90, 'jpegQuality');
    }
    if (body.discoveryEnabled !== undefined)
      patch.discoveryEnabled = Boolean(body.discoveryEnabled);

    const updated = ctx.setCoreSettings(patch);
    ctx.store.audit.record({
      eventType: 'settings.updated',
      entityType: 'app',
      details: { changed: Object.keys(patch) },
    });
    return updated;
  });

  app.get('/api/v1/diagnostics', async () => {
    const devices = ctx.devices.list().map((runtime) => ({
      id: runtime.record.id,
      // Hostnames can identify a private network, so they are not part of the export.
      profileId: runtime.record.profileId,
      modelName: runtime.record.modelName,
      firmwareVersion: runtime.record.firmwareVersion,
      capabilities: runtime.record.capabilities,
      online: runtime.online,
      health: runtime.health,
      lastError: runtime.lastError,
    }));

    return {
      generatedAt: new Date().toISOString(),
      version: ctx.config.version,
      platform: { node: process.version, os: process.platform, arch: process.arch },
      registry: ctx.registry.report,
      devices,
      modules: ctx.store.moduleInstances.list().map((record) => ({
        moduleId: record.moduleId,
        enabled: record.enabled,
        settingsVersion: record.settingsVersion,
        healthStatus: record.healthStatus,
        lastErrorCode: record.lastErrorCode,
      })),
      bridge: ctx.bridgeInbox.describe(),
      recentEvents: ctx.store.audit.recent(40).map((event) => ({
        at: event.createdAt,
        type: event.eventType,
        severity: event.severity,
        entityType: event.entityType,
        details: event.details,
      })),
      note: 'Hostnames, coordinates and credentials are excluded from this export.',
    };
  });
}

async function describeFrame(
  ctx: AppContext,
  reference: { moduleInstanceId: string; viewId: string } | null,
): Promise<{ moduleInstanceId: string; viewId: string; title: string } | null> {
  if (!reference) return null;
  const record = ctx.store.moduleInstances.get(reference.moduleInstanceId);
  return {
    moduleInstanceId: reference.moduleInstanceId,
    viewId: reference.viewId,
    title: record?.name ?? reference.moduleInstanceId,
  };
}

function clampInt(value: number, min: number, max: number, field: string): number {
  if (!Number.isFinite(value)) {
    throw new AppError('VALIDATION_FAILED', `${field} must be a number.`);
  }
  const rounded = Math.round(value);
  if (rounded < min || rounded > max) {
    throw new AppError('VALIDATION_FAILED', `${field} must be between ${min} and ${max}.`);
  }
  return rounded;
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
