import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import {
  AppError,
  newId,
  nowIso,
  toAppError,
  type DeviceProfileId,
  type HealthStatus,
} from '@gca/shared';
import type { BackupRecord, DeviceRecord, Store } from '@gca/database';
import {
  capabilitiesFor,
  createAdapter,
  detectProfile,
  DeviceTransport,
  DeviceUploadQueue,
  isWritableProfile,
  StockProAdapter,
  SdProAdapter,
  type AddressPolicy,
  type DeviceAdapter,
  type DetectionResult,
  type UploadOutcome,
} from '@gca/device-core';
import type { EncodedFrame } from '@gca/renderer';
import type { EventBus } from './events.js';
import type { AppLogger } from './logger.js';

export interface DeviceRuntime {
  record: DeviceRecord;
  transport: DeviceTransport;
  adapter: DeviceAdapter;
  queue: DeviceUploadQueue;
  online: boolean;
  health: HealthStatus;
  lastError: { code: string; message: string } | null;
}

export interface DeviceManagerOptions {
  store: Store;
  events: EventBus;
  logger: AppLogger;
  dataDir: string;
  addressPolicy?: AddressPolicy;
}

/**
 * Owns device connections, adapters and the one upload queue per device.
 *
 * This is the only component that talks to hardware. Modules produce frames; the
 * scheduler decides which frame belongs on which device; this class performs the write.
 */
export class DeviceManager {
  readonly #runtimes = new Map<string, DeviceRuntime>();
  readonly #store: Store;
  readonly #events: EventBus;
  readonly #logger: AppLogger;
  readonly #dataDir: string;
  readonly #addressPolicy: AddressPolicy | undefined;

  constructor(options: DeviceManagerOptions) {
    this.#store = options.store;
    this.#events = options.events;
    this.#logger = options.logger.child({ component: 'device-manager' });
    this.#dataDir = options.dataDir;
    this.#addressPolicy = options.addressPolicy;
  }

  list(): DeviceRuntime[] {
    return [...this.#runtimes.values()];
  }

  get(deviceId: string): DeviceRuntime | null {
    return this.#runtimes.get(deviceId) ?? null;
  }

  require(deviceId: string): DeviceRuntime {
    const runtime = this.#runtimes.get(deviceId);
    if (!runtime) throw new AppError('DEVICE_NOT_FOUND', `Device "${deviceId}" is not configured.`);
    return runtime;
  }

  async startAll(): Promise<void> {
    for (const record of this.#store.devices.list()) {
      this.register(record);
    }
    // Probe before the first post-restart write, so a firmware change is noticed
    // before we push bytes at it.
    await Promise.all(
      this.list().map((runtime) => this.refreshState(runtime.record.id).catch(() => undefined)),
    );
  }

  register(record: DeviceRecord): DeviceRuntime {
    this.#runtimes.get(record.id)?.queue.stop();

    const transport = this.createTransport(record.host);
    const adapter = createAdapter(record.profileId, transport);
    const queue = new DeviceUploadQueue({
      deviceId: record.id,
      adapter,
      minimumIntervalMs: record.minimumUploadIntervalSeconds * 1000,
      lastUploadedSha256: record.lastUploadHash,
      onEvent: (event) => {
        if (event.type === 'upload-success') {
          this.#logger.debug(
            { deviceId: event.deviceId, frameId: event.frameId },
            'Frame uploaded',
          );
        } else if (event.type === 'upload-retry') {
          this.#logger.warn(
            {
              deviceId: event.deviceId,
              attempt: event.attempt,
              delayMs: event.delayMs,
              code: event.code,
            },
            'Retrying upload',
          );
        } else if (event.type === 'upload-failed') {
          this.#events.emit('device.error', {
            deviceId: event.deviceId,
            code: event.code,
            message: event.message,
          });
        }
      },
    });

    const runtime: DeviceRuntime = {
      record,
      transport,
      adapter,
      queue,
      online: false,
      health: 'unknown',
      lastError: null,
    };
    this.#runtimes.set(record.id, runtime);
    return runtime;
  }

  async unregister(deviceId: string): Promise<void> {
    const runtime = this.#runtimes.get(deviceId);
    if (!runtime) return;
    runtime.queue.stop();
    this.#runtimes.delete(deviceId);
  }

  async stopAll(): Promise<void> {
    for (const runtime of this.#runtimes.values()) runtime.queue.stop();
    this.#runtimes.clear();
  }

  createTransport(host: string): DeviceTransport {
    return new DeviceTransport({
      host,
      ...(this.#addressPolicy ? { policy: this.#addressPolicy } : {}),
    });
  }

  /** Read-only probe of an arbitrary host, used during onboarding and diagnostics. */
  async probeHost(host: string, signal?: AbortSignal): Promise<DetectionResult> {
    const transport = this.createTransport(host);
    return detectProfile(transport, signal ? { signal } : {});
  }

  /** Re-probes a configured device and updates its stored profile if firmware changed. */
  async refreshState(deviceId: string): Promise<DeviceRuntime> {
    const runtime = this.require(deviceId);
    try {
      const detection = await detectProfile(runtime.transport);
      runtime.online = detection.reachable;

      const profileChanged =
        detection.reachable && detection.profileId !== runtime.record.profileId;
      if (profileChanged) {
        this.#logger.warn(
          { deviceId, from: runtime.record.profileId, to: detection.profileId },
          'Device firmware profile changed; swapping adapter',
        );
        const updated = this.#store.devices.update(deviceId, {
          profileId: detection.profileId,
          modelName: detection.modelName,
          firmwareVersion: detection.firmwareVersion,
          capabilities: capabilitiesFor(detection.profileId),
        });
        if (updated) {
          runtime.record = updated;
          runtime.adapter = createAdapter(detection.profileId, runtime.transport);
          runtime.queue.setAdapter(runtime.adapter);
        }
        this.#store.audit.record({
          eventType: 'device.profile-changed',
          entityType: 'device',
          entityId: deviceId,
          severity: 'warn',
          details: { from: runtime.record.profileId, to: detection.profileId },
        });
      }

      runtime.health = detection.reachable
        ? detection.supported
          ? 'healthy'
          : 'degraded'
        : 'error';
      runtime.lastError = detection.reachable
        ? null
        : { code: 'DEVICE_UNREACHABLE', message: 'Device did not respond to any probe.' };

      this.#store.devices.update(deviceId, {
        lastSeenAt: detection.reachable ? nowIso() : runtime.record.lastSeenAt,
        lastErrorCode: runtime.lastError?.code ?? null,
        lastErrorMessage: runtime.lastError?.message ?? null,
      });
      this.#events.emit('device.state', {
        deviceId,
        online: runtime.online,
        health: runtime.health,
      });
      return runtime;
    } catch (error) {
      const appError = toAppError(error, 'Device probe failed');
      runtime.online = false;
      runtime.health = 'error';
      runtime.lastError = { code: appError.code, message: appError.message };
      this.#store.devices.update(deviceId, {
        lastErrorCode: appError.code,
        lastErrorMessage: appError.message,
      });
      this.#events.emit('device.state', { deviceId, online: false, health: 'error' });
      return runtime;
    }
  }

  async getBrightness(deviceId: string): Promise<number | null> {
    const runtime = this.require(deviceId);
    if (!runtime.record.capabilities.canSetBrightness) return null;
    return runtime.adapter.getBrightness().catch(() => null);
  }

  async setBrightness(deviceId: string, value: number): Promise<void> {
    const runtime = this.require(deviceId);
    this.assertWritable(runtime);
    if (!runtime.record.capabilities.canSetBrightness) {
      throw new AppError(
        'DEVICE_PROFILE_UNSUPPORTED',
        'This firmware does not expose brightness control.',
      );
    }
    await runtime.adapter.setBrightness(value);
    this.#store.audit.record({
      eventType: 'device.brightness',
      entityType: 'device',
      entityId: deviceId,
      details: { value },
    });
  }

  /** Queues a rendered frame for a device. Returns the queue's outcome. */
  async pushFrame(
    deviceId: string,
    frame: EncodedFrame,
    options: { priority?: 'normal' | 'attention' | 'urgent'; force?: boolean } = {},
  ): Promise<UploadOutcome> {
    const runtime = this.require(deviceId);
    this.assertWritable(runtime);

    // Album-managed profiles must not be written to before the user has consented.
    if (
      runtime.record.capabilities.requiresAlbumManagement &&
      !runtime.record.albumManagementConsent
    ) {
      throw new AppError(
        'PRO_ALBUM_CONSENT_REQUIRED',
        'This device needs managed-album consent before the dashboard can be displayed.',
      );
    }

    const outcome = await runtime.queue.enqueue({
      frameId: frame.frameId,
      viewId: frame.viewId,
      frame: { bytes: frame.bytes, sha256: frame.sha256, contentType: frame.contentType },
      priority: options.priority ?? 'normal',
      ...(options.force ? { force: true } : {}),
      albumManagementConsent: runtime.record.albumManagementConsent,
    });

    if (outcome.status === 'uploaded') {
      const updated = this.#store.devices.update(deviceId, {
        lastUploadHash: outcome.sha256,
        lastUploadAt: nowIso(),
        lastSeenAt: nowIso(),
        lastErrorCode: null,
        lastErrorMessage: null,
      });
      if (updated) runtime.record = updated;
      runtime.online = true;
      runtime.health = 'healthy';
      runtime.lastError = null;
      this.#events.emit('device.uploaded', {
        deviceId,
        frameId: frame.frameId,
        sha256: outcome.sha256,
      });

      if (outcome.result.warning) {
        this.#store.audit.record({
          eventType: 'device.upload-warning',
          entityType: 'device',
          entityId: deviceId,
          severity: 'warn',
          details: { warning: outcome.result.warning },
        });
      }
    } else if (outcome.status === 'failed') {
      runtime.online = false;
      runtime.health = 'error';
      runtime.lastError = { code: outcome.error.code, message: outcome.error.message };
      const updated = this.#store.devices.update(deviceId, {
        lastErrorCode: outcome.error.code,
        lastErrorMessage: outcome.error.message,
      });
      if (updated) runtime.record = updated;
      this.#store.audit.record({
        eventType: 'device.upload-failed',
        entityType: 'device',
        entityId: deviceId,
        severity: 'error',
        details: {
          code: outcome.error.code,
          message: outcome.error.message,
          attempts: outcome.attempts,
        },
      });
    }

    return outcome;
  }

  /**
   * Backs up a device album, then takes it over.
   *
   * The order matters and is not negotiable: consent, then a verified backup, then
   * upload, then verify, and only then delete anything the user had there.
   */
  async takeoverAlbum(
    deviceId: string,
    frame: EncodedFrame,
    options: { confirmed: boolean },
  ): Promise<{ backup: BackupRecord | null; deleted: string[]; warnings: string[] }> {
    const runtime = this.require(deviceId);
    this.assertWritable(runtime);

    if (!options.confirmed) {
      throw new AppError(
        'PRO_ALBUM_CONSENT_REQUIRED',
        'Album takeover removes the other pictures on this device and needs explicit confirmation.',
      );
    }
    if (!runtime.record.capabilities.requiresAlbumManagement) {
      throw new AppError('DEVICE_PROFILE_UNSUPPORTED', 'This device does not use a managed album.');
    }

    const warnings: string[] = [];
    let backup: BackupRecord | null = null;

    if (runtime.adapter.backupUserContent) {
      try {
        backup = await this.createBackup(runtime);
      } catch (error) {
        const appError = toAppError(error, 'Album backup failed');
        throw new AppError(
          'PRO_ALBUM_BACKUP_FAILED',
          `The album could not be backed up, so nothing was deleted: ${appError.message}`,
          { cause: appError },
        );
      }
      if (backup.status === 'partial') {
        warnings.push(
          'Some album files could not be backed up. Review the backup before continuing.',
        );
      }
    } else {
      warnings.push('This firmware cannot download album contents, so no backup was taken.');
    }

    const updated = this.#store.devices.update(deviceId, { albumManagementConsent: true });
    if (updated) runtime.record = updated;

    await runtime.adapter.prepareManagedDisplay({ albumManagementConsent: true, force: true });
    await runtime.adapter.uploadFrame({
      bytes: frame.bytes,
      sha256: frame.sha256,
      contentType: frame.contentType,
    });

    const verification = await runtime.adapter.verifyFrame('dashboard.jpg');
    if (!verification.present) {
      throw new AppError(
        'DEVICE_UPLOAD_UNVERIFIED',
        `The managed image could not be verified on the device, so no files were deleted: ${verification.detail}`,
      );
    }

    let deleted: string[] = [];
    if (runtime.adapter instanceof StockProAdapter) {
      const prune = await runtime.adapter.pruneAlbum();
      deleted = prune.deleted;
      if (prune.failed.length > 0) {
        warnings.push(`These files could not be removed: ${prune.failed.join(', ')}`);
      }
    }

    this.#store.devices.update(deviceId, { lastUploadHash: frame.sha256, lastUploadAt: nowIso() });
    this.#store.audit.record({
      eventType: 'device.album-takeover',
      entityType: 'device',
      entityId: deviceId,
      severity: 'warn',
      details: { backupId: backup?.id ?? null, deletedCount: deleted.length, warnings },
    });

    return { backup, deleted, warnings };
  }

  async createBackup(runtime: DeviceRuntime): Promise<BackupRecord> {
    if (!runtime.adapter.backupUserContent) {
      throw new AppError(
        'DEVICE_PROFILE_UNSUPPORTED',
        'This firmware cannot export album contents.',
      );
    }
    const content = await runtime.adapter.backupUserContent();
    const backupId = newId('bak');
    const directory = join(this.#dataDir, 'device-backups', runtime.record.id, backupId);
    await mkdir(directory, { recursive: true });

    const files: BackupRecord['manifest']['files'] = [];
    for (const file of content.files) {
      await writeFile(backupFilePath(directory, file.filename), file.data);
      files.push({
        filename: file.filename,
        originalPath: file.originalPath,
        bytes: file.bytes,
        sha256: file.sha256,
      });
    }

    return this.#store.backups.insert({
      id: backupId,
      deviceId: runtime.record.id,
      profileId: runtime.record.profileId,
      manifest: { files, ...(content.notes.length > 0 ? { note: content.notes.join(' ') } : {}) },
      directory,
      status: content.partial ? 'partial' : 'complete',
    });
  }

  /** Restores a backup, verifying each file's checksum before it is uploaded. */
  async restoreBackup(
    deviceId: string,
    backupId: string,
  ): Promise<{ restored: string[]; failed: Array<{ filename: string; reason: string }> }> {
    const runtime = this.require(deviceId);
    const backup = this.#store.backups.get(backupId);
    if (!backup || backup.deviceId !== deviceId) {
      throw new AppError('NOT_FOUND', `Backup "${backupId}" does not exist for this device.`);
    }
    if (!runtime.adapter.restoreUserContent) {
      throw new AppError(
        'DEVICE_PROFILE_UNSUPPORTED',
        'This firmware cannot restore album contents.',
      );
    }

    // Stop pushing dashboard frames while the user's own content goes back.
    runtime.queue.stop();

    const payload: Array<{ filename: string; data: Buffer }> = [];
    const failed: Array<{ filename: string; reason: string }> = [];

    for (const entry of backup.manifest.files) {
      try {
        const data = await readFile(backupFilePath(backup.directory, entry.filename));
        const digest = createHash('sha256').update(data).digest('hex');
        if (digest !== entry.sha256) {
          failed.push({
            filename: entry.filename,
            reason: 'Checksum mismatch; the backup file changed on disk.',
          });
          continue;
        }
        payload.push({ filename: entry.filename, data });
      } catch (error) {
        failed.push({
          filename: entry.filename,
          reason: error instanceof Error ? error.message : 'Could not read the backup file.',
        });
      }
    }

    const result = await runtime.adapter.restoreUserContent(payload);
    const combined = { restored: result.restored, failed: [...failed, ...result.failed] };

    this.#store.devices.update(deviceId, { albumManagementConsent: false, lastUploadHash: null });
    if (runtime.adapter instanceof SdProAdapter) {
      await runtime.adapter.exitManagedMode().catch(() => undefined);
    }
    this.register({ ...runtime.record, albumManagementConsent: false, lastUploadHash: null });

    this.#store.audit.record({
      eventType: 'device.album-restore',
      entityType: 'device',
      entityId: deviceId,
      severity: combined.failed.length > 0 ? 'warn' : 'info',
      details: { backupId, restored: combined.restored.length, failed: combined.failed.length },
    });

    return combined;
  }

  async listBackupFiles(backup: BackupRecord): Promise<string[]> {
    try {
      return await readdir(backup.directory);
    } catch {
      return [];
    }
  }

  private assertWritable(runtime: DeviceRuntime): void {
    if (!isWritableProfile(runtime.record.profileId)) {
      throw new AppError(
        runtime.record.profileId === 'unknown'
          ? 'DEVICE_PROFILE_UNKNOWN'
          : 'DEVICE_PROFILE_UNSUPPORTED',
        runtime.record.profileId === 'unknown'
          ? 'This device firmware was not recognised, so no writes are permitted.'
          : `Firmware profile "${runtime.record.profileId}" is detected but not writable in this version.`,
      );
    }
    if (!runtime.record.active) {
      throw new AppError('CONFLICT', 'This device is deactivated.');
    }
  }
}

export function profileDisplayName(profile: DeviceProfileId): string {
  switch (profile) {
    case 'stock-ultra':
      return 'SmallTV Ultra (stock)';
    case 'stock-pro':
      return 'SmallTV-PRO (stock)';
    case 'sd-pro':
      return 'SmallTV Ultra (SD_PRO firmware)';
    case 'weather-clock-legacy':
      return 'Legacy weather clock';
    default:
      return 'Unknown firmware';
  }
}

/**
 * Resolves a device-supplied filename inside a backup directory, or refuses.
 *
 * Adapters already strip traversal from firmware listings; this is the check at the
 * point of the write, so a new adapter that forgets cannot escape the directory.
 */
export function backupFilePath(directory: string, filename: string): string {
  const name = basename(filename.replace(/\\/g, '/'));
  if (!name || name === '.' || name === '..' || name !== filename || name.includes('\0')) {
    throw new AppError('VALIDATION_FAILED', `Refusing unsafe backup filename "${filename}".`);
  }
  const root = resolve(directory);
  const target = resolve(root, name);
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || rel.includes(sep)) {
    throw new AppError('VALIDATION_FAILED', `Refusing unsafe backup filename "${filename}".`);
  }
  return target;
}
