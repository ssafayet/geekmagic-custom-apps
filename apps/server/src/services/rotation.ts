import { newId } from '@gca/shared';
import { DEFAULT_DWELL_SECONDS } from '@gca/core';
import type { PlaylistItemRecord } from '@gca/database';
import type { AppContext } from '../context.js';

/**
 * Puts enabled modules on displays that do not show them yet.
 *
 * Adding or enabling a module should be enough to see it; arranging the display order
 * is a refinement, not a prerequisite. Only a display that lists none of an instance's
 * views gains an entry, so an order someone arranged — including an entry they
 * switched off — is never touched. Each module contributes its primary view, the
 * first one it allows in rotation; secondary views are a deliberate choice.
 */
export function addToRotation(
  ctx: AppContext,
  scope: { instanceIds?: readonly string[]; deviceIds?: readonly string[] } = {},
): void {
  const instances = ctx.store.moduleInstances
    .list()
    .filter((instance) => instance.enabled)
    .filter((instance) => !scope.instanceIds || scope.instanceIds.includes(instance.id));
  const devices = ctx.store.devices
    .list()
    .filter((device) => !scope.deviceIds || scope.deviceIds.includes(device.id));
  const dwellSeconds = ctx.coreSettings().defaultDwellSeconds ?? DEFAULT_DWELL_SECONDS;

  let changed = false;
  for (const device of devices) {
    const current = ctx.store.playlist.listForDevice(device.id);
    const added: PlaylistItemRecord[] = [];

    for (const instance of instances) {
      if (current.some((item) => item.moduleInstanceId === instance.id)) continue;
      const view = ctx.registry
        .tryGet(instance.moduleId)
        ?.manifest.views.find((candidate) => candidate.selectable !== false);
      if (!view) continue;
      added.push({
        id: newId('ply'),
        deviceId: device.id,
        moduleInstanceId: instance.id,
        viewId: view.id,
        order: current.length + added.length,
        dwellSeconds,
        enabled: true,
      });
    }

    if (added.length === 0) continue;
    ctx.store.playlist.replaceForDevice(device.id, [...current, ...added]);
    ctx.store.audit.record({
      eventType: 'playlist.updated',
      entityType: 'device',
      entityId: device.id,
      details: { count: current.length + added.length, added: added.length, automatic: true },
    });
    changed = true;
  }

  // A rebuild also forces each display to re-render, so the new entry shows promptly.
  if (changed) ctx.scheduler.rebuildSchedules();
}
