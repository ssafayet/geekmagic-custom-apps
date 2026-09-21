import { AppError, newId, nowIso, type DeviceDto, type DeviceProbeDto } from '@gca/shared';
import { capabilitiesFor, splitHostPort } from '@gca/device-core';
import type { AppContext } from '../context.js';

export interface SaveDeviceInput {
  host: string;
  name?: string;
  minimumUploadIntervalSeconds?: number;
}

/** Device-facing operations shared by the HTTP routes. */
export class DeviceService {
  constructor(private readonly ctx: AppContext) {}

  async probe(host: string): Promise<DeviceProbeDto> {
    const { hostname } = splitHostPort(host, 80);
    if (!hostname) throw new AppError('VALIDATION_FAILED', 'Enter a hostname or IP address.');

    const detection = await this.ctx.devices.probeHost(host);
    return {
      host,
      reachable: detection.reachable,
      profileId: detection.profileId,
      modelName: detection.modelName,
      firmwareVersion: detection.firmwareVersion,
      capabilities: capabilitiesFor(detection.profileId),
      supported: detection.supported,
      transcript: detection.transcript,
      warnings: detection.warnings,
    };
  }

  async save(input: SaveDeviceInput): Promise<DeviceDto> {
    const probe = await this.probe(input.host);
    if (!probe.reachable) {
      throw new AppError('DEVICE_UNREACHABLE', `No device responded at ${input.host}.`);
    }

    const existing = this.ctx.store.devices.findByHost(input.host);
    if (existing) {
      throw new AppError('CONFLICT', `A device is already configured at ${input.host}.`);
    }

    const record = this.ctx.store.devices.insert({
      id: newId('dev'),
      name: input.name?.trim() || defaultName(probe.modelName, input.host),
      host: input.host,
      profileId: probe.profileId,
      modelName: probe.modelName,
      firmwareVersion: probe.firmwareVersion,
      capabilities: probe.capabilities,
      albumManagementConsent: false,
      active: true,
      minimumUploadIntervalSeconds:
        input.minimumUploadIntervalSeconds ?? this.ctx.coreSettings().minimumUploadIntervalSeconds,
      lastSeenAt: nowIso(),
      lastUploadHash: null,
      lastUploadAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    });

    this.ctx.devices.register(record);
    this.ctx.scheduler.rebuildSchedules();
    this.ctx.store.audit.record({
      eventType: 'device.added',
      entityType: 'device',
      entityId: record.id,
      details: { profileId: record.profileId, model: record.modelName },
    });

    return this.toDto(record.id);
  }

  async remove(deviceId: string): Promise<void> {
    const record = this.ctx.store.devices.get(deviceId);
    if (!record) throw new AppError('DEVICE_NOT_FOUND', 'That device does not exist.');
    await this.ctx.devices.unregister(deviceId);
    this.ctx.store.devices.delete(deviceId);
    this.ctx.scheduler.rebuildSchedules();
    this.ctx.store.audit.record({
      eventType: 'device.removed',
      entityType: 'device',
      entityId: deviceId,
      severity: 'warn',
      details: { host: record.host },
    });
  }

  async toDto(deviceId: string): Promise<DeviceDto> {
    const record = this.ctx.store.devices.get(deviceId);
    if (!record) throw new AppError('DEVICE_NOT_FOUND', 'That device does not exist.');
    const runtime = this.ctx.devices.get(deviceId);
    const brightness = runtime
      ? await this.ctx.devices.getBrightness(deviceId).catch(() => null)
      : null;

    return {
      id: record.id,
      name: record.name,
      host: record.host,
      profileId: record.profileId,
      modelName: record.modelName,
      firmwareVersion: record.firmwareVersion,
      capabilities: record.capabilities,
      albumManagementConsent: record.albumManagementConsent,
      active: record.active,
      minimumUploadIntervalSeconds: record.minimumUploadIntervalSeconds,
      lastSeenAt: record.lastSeenAt,
      lastUploadAt: record.lastUploadAt,
      online: runtime?.online ?? false,
      health: runtime?.health ?? 'unknown',
      lastErrorCode: record.lastErrorCode,
      lastErrorMessage: record.lastErrorMessage,
      brightness,
      backupCount: this.ctx.store.backups.countForDevice(deviceId),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  async listDtos(): Promise<DeviceDto[]> {
    const records = this.ctx.store.devices.list();
    return Promise.all(records.map((record) => this.toDto(record.id)));
  }
}

function defaultName(modelName: string | null, host: string): string {
  if (modelName) return modelName;
  return `Display ${host}`;
}
