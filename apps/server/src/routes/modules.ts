import { AppError, type ActionResultDto } from '@gca/shared';
import type { AppContext } from '../context.js';
import type { ModuleService, UpdateInstanceInput } from '../services/module-service.js';
import type { AppServer } from '../fastify-types.js';

interface InstanceParams {
  id: string;
}

export function registerModuleRoutes(
  app: AppServer,
  ctx: AppContext,
  services: { modules: ModuleService },
): void {
  app.get('/api/v1/module-definitions', async () => services.modules.listDefinitions());

  app.get('/api/v1/module-instances', async () => services.modules.listDtos());

  app.post('/api/v1/module-instances', async (request, reply) => {
    const body = (request.body ?? {}) as { moduleId?: string } & UpdateInstanceInput;
    if (!body.moduleId) throw new AppError('VALIDATION_FAILED', 'A moduleId is required.');
    const instance = await services.modules.create(body.moduleId, body);
    reply.status(201);
    return instance;
  });

  app.get<{ Params: InstanceParams }>('/api/v1/module-instances/:id', async (request) =>
    services.modules.toDto(request.params.id),
  );

  app.patch<{ Params: InstanceParams }>('/api/v1/module-instances/:id', async (request) => {
    const body = (request.body ?? {}) as UpdateInstanceInput;
    return services.modules.update(request.params.id, body);
  });

  app.delete<{ Params: InstanceParams }>('/api/v1/module-instances/:id', async (request, reply) => {
    const body = (request.body ?? {}) as { confirm?: boolean };
    if (body.confirm !== true) {
      throw new AppError(
        'CONFIRMATION_REQUIRED',
        'Removing a module deletes its settings, secrets and playlist entries. Confirm to continue.',
      );
    }
    await services.modules.remove(request.params.id);
    reply.status(204);
  });

  app.post<{ Params: InstanceParams }>('/api/v1/module-instances/:id/validate', async (request) => {
    const body = (request.body ?? {}) as { settings?: Record<string, unknown> };
    return services.modules.validateDraft(request.params.id, body.settings ?? {});
  });

  app.post<{ Params: InstanceParams; Body: unknown }>(
    '/api/v1/module-instances/:id/actions/:actionId',
    async (request): Promise<ActionResultDto> => {
      const { id, actionId } = request.params as InstanceParams & { actionId: string };
      const body = (request.body ?? {}) as { input?: unknown; confirm?: boolean };

      const record = ctx.store.moduleInstances.get(id);
      if (!record) throw new AppError('MODULE_NOT_FOUND', 'That module instance does not exist.');
      const entry = ctx.registry.get(record.moduleId);
      const definition = entry.manifest.actions?.find((action) => action.id === actionId);

      // An action that writes outside the application needs an explicit confirm flag.
      if (definition && definition.confirmation !== 'none' && body.confirm !== true) {
        throw new AppError(
          'CONFIRMATION_REQUIRED',
          `"${definition.displayName}" ${definition.writes ? 'modifies files outside this application' : 'needs confirmation'}. Confirm to continue.`,
          {
            details: { confirmation: definition.confirmation, description: definition.description },
          },
        );
      }

      const result = await ctx.runtimes.runAction(id, actionId, body.input ?? {});

      ctx.store.audit.record({
        eventType: 'module.action',
        entityType: 'module-instance',
        entityId: id,
        severity: result.ok ? 'info' : 'warn',
        details: { actionId, ok: result.ok, code: result.code },
      });

      if (result.settingsPatch) {
        await services.modules.update(id, { settings: result.settingsPatch });
      }

      return {
        ok: result.ok,
        message: result.message,
        ...(result.code ? { code: result.code } : {}),
        ...(result.data ? { data: result.data } : {}),
        ...(result.panel ? { panel: result.panel } : {}),
      };
    },
  );

  app.post<{ Params: InstanceParams }>('/api/v1/module-instances/:id/refresh', async (request) => {
    await ctx.runtimes.refresh(request.params.id, 'manual').catch(() => undefined);
    ctx.scheduler.invalidateAll();
    return services.modules.toDto(request.params.id);
  });

  app.get<{ Params: InstanceParams }>(
    '/api/v1/module-instances/:id/preview',
    async (request, reply) => {
      const query = request.query as { viewId?: string } | undefined;
      const frames = await ctx.runtimes.getFrames(request.params.id, {
        ...(query?.viewId ? { viewIds: [query.viewId] } : {}),
      });
      const frame = frames[0];
      if (!frame) throw new AppError('NOT_FOUND', 'This module produced no frame to preview.');

      const png = await ctx.renderer.renderPreviewPng(frame, { themeId: ctx.coreSettings().theme });
      reply.header('content-type', 'image/png');
      reply.header('cache-control', 'no-store');
      return reply.send(png);
    },
  );
}
