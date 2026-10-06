import { join } from 'node:path';
import type { AppContext } from '../context.js';
import type { ConfirmationService } from '../services/confirmation.js';
import type { ResetService } from '../services/reset-service.js';
import type { AppServer } from '../fastify-types.js';

export function registerResetRoutes(
  app: AppServer,
  ctx: AppContext,
  services: { reset: ResetService; confirmations: ConfirmationService },
): void {
  app.get('/api/v1/reset/plan', async () => {
    const proposal = services.reset.proposal();
    const backups = proposal.devices.reduce((total, device) => total + device.backups, 0);
    return {
      ...proposal,
      backups,
      backupDirectory: backups > 0 ? join(ctx.config.dataDir, 'device-backups') : null,
      confirmationToken: services.confirmations.issue('reset', 'app', proposal),
    };
  });

  app.post('/api/v1/reset', async (request) => {
    const body = (request.body ?? {}) as { confirmationToken?: string };
    // Re-derived, so a display or module added after the review invalidates the token.
    const proposal = services.reset.proposal();
    services.confirmations.consume(body.confirmationToken, 'reset', 'app', proposal);
    await services.reset.reset(proposal);
    return { removed: { devices: proposal.devices.length, modules: proposal.modules.length } };
  });
}
