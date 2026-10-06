import { DEFAULT_CORE_SETTINGS } from '@gca/core';
import type { AppContext } from '../context.js';

export interface ResetProposal {
  devices: Array<{ id: string; name: string; backups: number }>;
  modules: Array<{ id: string; name: string }>;
}

/**
 * Returns the server to the state of a fresh install, for starting setup over.
 *
 * Removed: every display (with its display order and backup records), every module
 * (with its settings, credentials, snapshots and state), and the server-wide
 * preferences. Kept: the administrator password and sessions, the encryption key, the
 * bridge token, the audit log, and backup files on disk — the last being the only copy
 * of pictures an album takeover removed from a display.
 */
export class ResetService {
  constructor(private readonly ctx: AppContext) {}

  /** The exact set of records a reset would remove now; confirmation binds to it. */
  proposal(): ResetProposal {
    return {
      devices: this.ctx.store.devices.list().map((device) => ({
        id: device.id,
        name: device.name,
        backups: this.ctx.store.backups.countForDevice(device.id),
      })),
      modules: this.ctx.store.moduleInstances
        .list()
        .map((instance) => ({ id: instance.id, name: instance.name })),
    };
  }

  async reset(proposal: ResetProposal): Promise<void> {
    // Stop the work first so nothing renders, refreshes or uploads mid-deletion.
    for (const module of proposal.modules) await this.ctx.runtimes.stopInstance(module.id);
    for (const device of proposal.devices) await this.ctx.devices.unregister(device.id);

    this.ctx.store.transaction(() => {
      for (const module of proposal.modules) this.ctx.store.moduleInstances.delete(module.id);
      for (const device of proposal.devices) this.ctx.store.devices.delete(device.id);
    });
    this.ctx.setCoreSettings({ ...DEFAULT_CORE_SETTINGS });
    this.ctx.scheduler.rebuildJobs();
    this.ctx.scheduler.rebuildSchedules();

    // Old problems describe things that no longer exist; the events stay in the log.
    this.ctx.store.audit.acknowledgeProblems();
    this.ctx.store.audit.record({
      eventType: 'app.reset',
      entityType: 'app',
      // Logged, not raised: a fresh start should not open with a problem on the overview.
      severity: 'info',
      details: {
        devices: proposal.devices.length,
        modules: proposal.modules.length,
        backupsKeptOnDisk: proposal.devices.reduce((total, device) => total + device.backups, 0),
      },
    });
  }
}
