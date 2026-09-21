import { AppError, type BackupDto } from '@gca/shared';
import { discoverDevices, listPrivateSubnets, expandCidr } from '@gca/device-core';
import { finalizeFrame } from '@gca/renderer';
import type { AppContext } from '../context.js';
import type { ConfirmationService } from '../services/confirmation.js';
import type { DeviceService } from '../services/device-service.js';
import type { AppServer } from '../fastify-types.js';

interface DeviceParams {
  id: string;
}

export function registerDeviceRoutes(
  app: AppServer,
  ctx: AppContext,
  services: { devices: DeviceService; confirmations: ConfirmationService },
): void {
  app.post('/api/v1/devices/probe', async (request) => {
    const body = (request.body ?? {}) as { host?: string };
    if (!body.host) throw new AppError('VALIDATION_FAILED', 'A host is required.');
    return services.devices.probe(body.host);
  });

  app.get('/api/v1/devices/subnets', async () => ({
    enabled: ctx.coreSettings().discoveryEnabled,
    subnets: listPrivateSubnets(),
  }));

  app.post('/api/v1/devices/discover', async (request) => {
    if (!ctx.coreSettings().discoveryEnabled) {
      throw new AppError('CONFLICT', 'Network discovery is disabled in settings.');
    }
    const body = (request.body ?? {}) as { cidr?: string };
    if (!body.cidr) throw new AppError('VALIDATION_FAILED', 'Choose a subnet to scan.');

    // Validate and bound the range before any packet is sent.
    const hosts = expandCidr(body.cidr);
    const found = await discoverDevices({ cidr: body.cidr });

    ctx.store.audit.record({
      eventType: 'device.discovery',
      entityType: 'app',
      details: { scanned: hosts.length, found: found.length },
    });
    return { scanned: hosts.length, found };
  });

  app.get('/api/v1/devices', async () => services.devices.listDtos());

  app.post('/api/v1/devices', async (request, reply) => {
    const body = (request.body ?? {}) as { host?: string; name?: string };
    if (!body.host) throw new AppError('VALIDATION_FAILED', 'A host is required.');
    const device = await services.devices.save({
      host: body.host,
      ...(body.name ? { name: body.name } : {}),
    });
    reply.status(201);
    return device;
  });

  app.get<{ Params: DeviceParams }>('/api/v1/devices/:id', async (request) => {
    const runtime = ctx.devices.get(request.params.id);
    const dto = await services.devices.toDto(request.params.id);
    return {
      ...dto,
      diagnostics: {
        lastError: runtime?.lastError ?? null,
        queueLastSha: runtime?.queue.lastSha256 ?? null,
      },
    };
  });

  app.patch<{ Params: DeviceParams }>('/api/v1/devices/:id', async (request) => {
    const body = (request.body ?? {}) as {
      name?: string;
      active?: boolean;
      minimumUploadIntervalSeconds?: number;
      brightness?: number;
    };
    const existing = ctx.store.devices.get(request.params.id);
    if (!existing) throw new AppError('DEVICE_NOT_FOUND', 'That device does not exist.');

    if (body.brightness !== undefined) {
      await ctx.devices.setBrightness(request.params.id, body.brightness);
    }

    const patch: Parameters<typeof ctx.store.devices.update>[1] = {};
    if (body.name !== undefined) patch.name = body.name.trim() || existing.name;
    if (body.active !== undefined) patch.active = Boolean(body.active);
    if (body.minimumUploadIntervalSeconds !== undefined) {
      const seconds = Math.round(body.minimumUploadIntervalSeconds);
      if (!Number.isFinite(seconds) || seconds < 5 || seconds > 3600) {
        throw new AppError(
          'VALIDATION_FAILED',
          'The minimum upload interval must be 5-3600 seconds.',
        );
      }
      patch.minimumUploadIntervalSeconds = seconds;
    }

    if (Object.keys(patch).length > 0) {
      const updated = ctx.store.devices.update(request.params.id, patch);
      // Interval and active state change queue behaviour, so rebuild the runtime.
      if (updated) ctx.devices.register(updated);
      ctx.scheduler.rebuildSchedules();
    }
    return services.devices.toDto(request.params.id);
  });

  app.delete<{ Params: DeviceParams }>('/api/v1/devices/:id', async (request, reply) => {
    await services.devices.remove(request.params.id);
    reply.status(204);
  });

  app.post<{ Params: DeviceParams }>('/api/v1/devices/:id/probe', async (request) => {
    await ctx.devices.refreshState(request.params.id);
    return services.devices.toDto(request.params.id);
  });

  app.post<{ Params: DeviceParams }>('/api/v1/devices/:id/test-frame', async (request) => {
    const runtime = ctx.devices.require(request.params.id);
    const frame = finalizeFrame(
      {
        id: 'test-frame',
        viewId: 'test',
        title: 'Connected',
        icon: 'check',
        accent: 'green',
        priority: 'normal',
        layout: {
          kind: 'empty',
          icon: 'check',
          headline: 'Connected',
          detail: `${runtime.record.name} is receiving frames`,
          footer: new Date().toLocaleTimeString('en-GB', { timeStyle: 'short' }),
        },
      },
      { now: new Date() },
    );

    const encoded = await ctx.renderer.render(frame, { themeId: ctx.coreSettings().theme });
    const outcome = await ctx.devices.pushFrame(request.params.id, encoded, { force: true });
    ctx.scheduler.invalidateDevice(request.params.id);

    return {
      status: outcome.status,
      ...(outcome.status === 'uploaded'
        ? { verified: outcome.result.verified, warning: outcome.result.warning ?? null }
        : {}),
      ...(outcome.status === 'failed'
        ? { code: outcome.error.code, message: outcome.error.message }
        : {}),
    };
  });

  app.post<{ Params: DeviceParams }>('/api/v1/devices/:id/render-now', async (request) => {
    const pushed = await ctx.scheduler.pushNow(request.params.id, { force: true });
    return { pushed };
  });

  app.get<{ Params: DeviceParams }>('/api/v1/devices/:id/preview', async (request, reply) => {
    const rendered = await ctx.scheduler.renderCurrent(request.params.id);
    if (!rendered) {
      throw new AppError(
        'NOT_FOUND',
        'This device has no frame to show yet. Add a module to its display order.',
      );
    }
    const png = await ctx.renderer.renderPreviewPng(rendered.frame, {
      themeId: ctx.coreSettings().theme,
    });
    reply.header('content-type', 'image/png');
    reply.header('cache-control', 'no-store');
    return reply.send(png);
  });

  /**
   * Album takeover is the destructive one. The plan is fetched first (a GET that
   * changes nothing), which mints a token bound to that exact plan; the POST then
   * has to present it. A GET can never delete anything here.
   */
  app.get<{ Params: DeviceParams }>('/api/v1/devices/:id/takeover-album/plan', async (request) => {
    const runtime = ctx.devices.require(request.params.id);
    if (!runtime.record.capabilities.requiresAlbumManagement) {
      throw new AppError('DEVICE_PROFILE_UNSUPPORTED', 'This device does not use a managed album.');
    }

    const toDelete = await listAlbumForProposal(runtime);
    const proposal = {
      deviceId: request.params.id,
      filesToDelete: toDelete,
      willBackUp: Boolean(runtime.adapter.backupUserContent),
    };

    return {
      ...proposal,
      consequence:
        toDelete.length > 0
          ? `${toDelete.length} picture(s) will be removed from the device album after they are backed up here.`
          : 'The album is already empty, so nothing will be deleted.',
      confirmationToken: services.confirmations.issue(
        'takeover-album',
        request.params.id,
        proposal,
      ),
    };
  });

  app.post<{ Params: DeviceParams }>('/api/v1/devices/:id/takeover-album', async (request) => {
    const body = (request.body ?? {}) as { confirmationToken?: string; filesToDelete?: string[] };
    const runtime = ctx.devices.require(request.params.id);

    const proposal = {
      deviceId: request.params.id,
      filesToDelete: await listAlbumForProposal(runtime),
      willBackUp: Boolean(runtime.adapter.backupUserContent),
    };

    // Re-derives the plan and compares it to what the user approved.
    services.confirmations.consume(
      body.confirmationToken,
      'takeover-album',
      request.params.id,
      proposal,
    );

    const rendered = await ctx.scheduler.renderCurrent(request.params.id);
    const frame =
      rendered?.encoded ??
      (await ctx.renderer.render(
        finalizeFrame(
          {
            id: 'managed-setup',
            viewId: 'test',
            title: 'Managed',
            icon: 'check',
            accent: 'green',
            priority: 'normal',
            layout: {
              kind: 'empty',
              icon: 'check',
              headline: 'Managed album',
              detail: 'This display is now managed by geekmagic-custom-apps',
            },
          },
          { now: new Date() },
        ),
        { themeId: ctx.coreSettings().theme },
      ));

    const result = await ctx.devices.takeoverAlbum(request.params.id, frame, { confirmed: true });
    ctx.scheduler.invalidateDevice(request.params.id);

    return {
      backupId: result.backup?.id ?? null,
      backupStatus: result.backup?.status ?? null,
      deleted: result.deleted,
      warnings: result.warnings,
      nextStep:
        runtime.record.profileId === 'stock-pro'
          ? 'On the device, open the Picture app once and confirm the dashboard is shown.'
          : null,
    };
  });

  app.get<{ Params: DeviceParams }>(
    '/api/v1/devices/:id/backups',
    async (request): Promise<BackupDto[]> =>
      ctx.store.backups.listForDevice(request.params.id).map((backup) => ({
        id: backup.id,
        deviceId: backup.deviceId,
        profileId: backup.profileId,
        createdAt: backup.createdAt,
        status: backup.status,
        fileCount: backup.manifest.files.length,
        totalBytes: backup.manifest.files.reduce((sum, file) => sum + file.bytes, 0),
        files: backup.manifest.files,
      })),
  );

  app.get<{ Params: DeviceParams & { backupId: string } }>(
    '/api/v1/devices/:id/restore/:backupId/plan',
    async (request) => {
      const backup = ctx.store.backups.get(request.params.backupId);
      if (!backup || backup.deviceId !== request.params.id) {
        throw new AppError('NOT_FOUND', 'That backup does not exist for this device.');
      }
      const proposal = {
        backupId: backup.id,
        files: backup.manifest.files.map((file) => file.filename),
      };
      return {
        ...proposal,
        consequence: `${proposal.files.length} file(s) will be uploaded back to the device and managed mode will be turned off.`,
        confirmationToken: services.confirmations.issue(
          'restore-backup',
          request.params.id,
          proposal,
        ),
      };
    },
  );

  app.post<{ Params: DeviceParams & { backupId: string } }>(
    '/api/v1/devices/:id/restore/:backupId',
    async (request) => {
      const body = (request.body ?? {}) as { confirmationToken?: string };
      const backup = ctx.store.backups.get(request.params.backupId);
      if (!backup || backup.deviceId !== request.params.id) {
        throw new AppError('NOT_FOUND', 'That backup does not exist for this device.');
      }

      services.confirmations.consume(body.confirmationToken, 'restore-backup', request.params.id, {
        backupId: backup.id,
        files: backup.manifest.files.map((file) => file.filename),
      });

      const result = await ctx.devices.restoreBackup(request.params.id, request.params.backupId);
      ctx.scheduler.rebuildSchedules();
      return result;
    },
  );
}

/**
 * Lists album contents for a takeover proposal.
 *
 * Deliberately does not swallow failures. Treating "the listing could not be read" as
 * "the album is empty" would show a consent screen promising nothing gets deleted and
 * then delete the user's pictures. If the album cannot be enumerated, no takeover is
 * proposed at all.
 */
async function listAlbumForProposal(
  runtime: ReturnType<AppContext['devices']['require']>,
): Promise<string[]> {
  if (!runtime.adapter.listFiles) {
    throw new AppError(
      'DEVICE_PROFILE_UNSUPPORTED',
      'This firmware cannot list album contents, so a managed takeover cannot be proposed safely.',
    );
  }
  try {
    const files = await runtime.adapter.listFiles();
    return files.filter((file) => file.name !== 'dashboard.jpg').map((file) => file.name);
  } catch (error) {
    throw new AppError(
      'DEVICE_UPLOAD_UNVERIFIED',
      `The device album could not be read, so no takeover will be proposed: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
      { cause: error, retryable: true },
    );
  }
}
