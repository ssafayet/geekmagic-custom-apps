import { AppError, newId, type PlaylistItemDto } from '@gca/shared';
import { DEFAULT_DWELL_SECONDS } from '@gca/core';
import type { AppContext } from '../context.js';
import type { AppServer } from '../fastify-types.js';

interface DeviceParams {
  id: string;
}

interface PlaylistInput {
  items?: Array<{
    id?: string;
    moduleInstanceId: string;
    viewId: string;
    dwellSeconds?: number;
    enabled?: boolean;
  }>;
}

export function registerPlaylistRoutes(app: AppServer, ctx: AppContext): void {
  app.get<{ Params: DeviceParams }>('/api/v1/devices/:id/playlist', async (request) =>
    toDtos(ctx, request.params.id),
  );

  app.put<{ Params: DeviceParams }>('/api/v1/devices/:id/playlist', async (request) => {
    const deviceId = request.params.id;
    if (!ctx.store.devices.get(deviceId)) {
      throw new AppError('DEVICE_NOT_FOUND', 'That device does not exist.');
    }

    const body = (request.body ?? {}) as PlaylistInput;
    const incoming = body.items ?? [];
    const seen = new Set<string>();

    const items = incoming.map((item, index) => {
      const instance = ctx.store.moduleInstances.get(item.moduleInstanceId);
      if (!instance) {
        throw new AppError(
          'MODULE_NOT_FOUND',
          `Module instance "${item.moduleInstanceId}" does not exist.`,
        );
      }

      const entry = ctx.registry.tryGet(instance.moduleId);
      const view = entry?.manifest.views.find((candidate) => candidate.id === item.viewId);
      if (!view) {
        throw new AppError(
          'VALIDATION_FAILED',
          `"${item.viewId}" is not a view of ${instance.name}.`,
        );
      }
      // Interrupt-only views are raised by the module, never scheduled in rotation.
      if (view.selectable === false) {
        throw new AppError(
          'VALIDATION_FAILED',
          `"${view.displayName}" cannot be placed in the rotation; it only appears as an interruption.`,
        );
      }

      const key = `${item.moduleInstanceId}:${item.viewId}`;
      if (seen.has(key)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `${instance.name} / ${view.displayName} is listed twice.`,
        );
      }
      seen.add(key);

      const dwell = Math.round(
        item.dwellSeconds ?? ctx.coreSettings().defaultDwellSeconds ?? DEFAULT_DWELL_SECONDS,
      );
      if (!Number.isFinite(dwell) || dwell < 5 || dwell > 3600) {
        throw new AppError('VALIDATION_FAILED', 'Dwell time must be between 5 and 3600 seconds.');
      }

      return {
        id: item.id ?? newId('ply'),
        deviceId,
        moduleInstanceId: item.moduleInstanceId,
        viewId: item.viewId,
        order: index,
        dwellSeconds: dwell,
        enabled: item.enabled ?? true,
      };
    });

    ctx.store.playlist.replaceForDevice(deviceId, items);
    ctx.scheduler.rebuildSchedules();
    ctx.scheduler.invalidateDevice(deviceId);
    ctx.store.audit.record({
      eventType: 'playlist.updated',
      entityType: 'device',
      entityId: deviceId,
      details: { count: items.length },
    });

    return toDtos(ctx, deviceId);
  });
}

function toDtos(ctx: AppContext, deviceId: string): PlaylistItemDto[] {
  return ctx.store.playlist.listForDevice(deviceId).map((item) => {
    const instance = ctx.store.moduleInstances.get(item.moduleInstanceId);
    const entry = instance ? ctx.registry.tryGet(instance.moduleId) : null;
    const view = entry?.manifest.views.find((candidate) => candidate.id === item.viewId);
    return {
      id: item.id,
      deviceId: item.deviceId,
      moduleInstanceId: item.moduleInstanceId,
      moduleId: instance?.moduleId ?? 'unknown',
      moduleInstanceName: instance?.name ?? 'Removed module',
      viewId: item.viewId,
      viewDisplayName: view?.displayName ?? item.viewId,
      order: item.order,
      dwellSeconds: item.dwellSeconds,
      enabled: item.enabled,
    };
  });
}
